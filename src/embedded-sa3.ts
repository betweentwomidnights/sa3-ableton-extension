import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { promptDefaults } from "./prompt-defaults.js";

export const EMBEDDED_SA3_URL = "embedded://sa3";
const VARIANT_NAMES = ["medium", "small-music", "small-sfx"];

export interface EmbeddedLora {
  name: string;
  strength: number;
}

export interface EmbeddedSa3Request {
  operation: "generate" | "transform" | "continue";
  modelsDir?: string | undefined;
  adaptersDir?: string | undefined;
  variant?: string | undefined;
  encoding?: string | undefined;
  device?: string | undefined;
  prompt: string;
  negativePrompt: string;
  durationSeconds: number;
  targetSamples: number;
  steps: number;
  cfgScale: number;
  distShift: string;
  seed: number;
  keepModels: boolean;
  durationPaddingSec: number;
  loras: EmbeddedLora[];
  initPath?: string | undefined;
  initNoiseLevel?: number | undefined;
  inpaintStart?: number | undefined;
  inpaintEnd?: number | undefined;
  encodeChunkSize: number;
  encodeOverlap: number;
  decodeChunkSize: number;
  decodeOverlap: number;
}

export interface EmbeddedSa3Result {
  wav: Buffer;
  seed: string;
  sampleRate: number;
  channels: number;
  samples: number;
}

interface EmbeddedSa3Native {
  diagnostics(): {
    available: boolean;
    version?: string;
    nativeDir?: string;
    reason?: string;
  };
  generate(
    request: Record<string, unknown>,
    onProgress?: (stage: string, step: number, total: number, fraction: number) => void,
  ): Promise<EmbeddedSa3Result>;
  convertLora(request: Record<string, unknown>): Promise<{ outputPath: string }>;
}

export interface EmbeddedModelOptions {
  modelsDir?: string | undefined;
  adaptersDir?: string | undefined;
  variant?: string | undefined;
  encoding?: string | undefined;
}

export interface EmbeddedModelStatus {
  modelsDir: string;
  variant: string;
  encoding: string;
  complete: boolean;
  missing: string[];
}

export interface EmbeddedDownloadStatus extends EmbeddedModelStatus {
  active: boolean;
  done: boolean;
  error: string;
  progress: number;
  label: string;
}

interface ModelDownloadItem {
  repo: string;
  filename: string;
  globPrefix: string;
  globSuffix: string;
  what: string;
}

export interface EmbeddedLoraInfo {
  name: string;
  directory?: string | undefined;
  ggufPath?: string | undefined;
  safetensorsPath?: string | undefined;
  jsonPath?: string | undefined;
  promptFiles: string[];
}

export interface EmbeddedVariantAvailability {
  variant: string;
  encodings: string[];
}

let downloadState: EmbeddedDownloadStatus | undefined;
let downloadCancelRequested = false;

let cachedNative: EmbeddedSa3Native | undefined;
let cachedNativeError: string | undefined;

export function isEmbeddedBackendUrl(url: string): boolean {
  return normalizeEmbeddedUrl(url) === EMBEDDED_SA3_URL;
}

export function normalizeEmbeddedUrl(url: string): string {
  return url.trim().replace(/\/+$/, "").toLowerCase();
}

export function embeddedNativeDirectory(): string {
  return path.join(__dirname, "native", `${process.platform}-${process.arch}`);
}

export function embeddedNativePath(): string {
  return path.join(embeddedNativeDirectory(), "sa3_embedded.node");
}

export function loadEmbeddedSa3(): EmbeddedSa3Native {
  if (cachedNative) {
    return cachedNative;
  }
  if (cachedNativeError) {
    throw new Error(cachedNativeError);
  }

  try {
    const requireNative = createRequire(__filename);
    cachedNative = requireNative(embeddedNativePath()) as EmbeddedSa3Native;
    return cachedNative;
  } catch (error) {
    cachedNativeError = error instanceof Error ? error.message : String(error);
    throw new Error(cachedNativeError);
  }
}

export function embeddedSa3Diagnostics(options: EmbeddedModelOptions = {}): {
  online: boolean;
  status: string;
} {
  try {
    const native = loadEmbeddedSa3();
    const diagnostics = native.diagnostics();
    if (!diagnostics.available) {
      return {
        online: false,
        status: diagnostics.reason || "native runtime unavailable",
      };
    }

    const modelStatus = embeddedModelStatus(options);
    return {
      online: modelStatus.complete,
      status: `${diagnostics.version || "libsa3"}; ${modelStatus.complete ? `${modelStatus.variant} ready` : `missing ${modelStatus.missing.join(", ")}`}`,
    };
  } catch (error) {
    return {
      online: false,
      status: error instanceof Error ? error.message : "embedded runtime unavailable",
    };
  }
}

export async function listEmbeddedLoras(options: EmbeddedModelOptions = {}): Promise<string[]> {
  return (await listEmbeddedLoraInfos(options)).map((info) => info.name);
}

export async function listEmbeddedLoraInfos(options: EmbeddedModelOptions = {}): Promise<EmbeddedLoraInfo[]> {
  // LoRAs are base-model specific, so they live under loras/<variant>/ and are only
  // listed for the matching variant.
  const variantDir = embeddedEffectiveDirs(options).lorasVariantDir;
  if (!variantDir) {
    return [];
  }

  const infos = new Map<string, EmbeddedLoraInfo>();
  await collectLoraInfos(variantDir, infos);
  return [...infos.values()].sort((left, right) => left.name.localeCompare(right.name));
}

async function collectLoraInfos(directory: string, infos: Map<string, EmbeddedLoraInfo>): Promise<void> {
  let entries: fsSync.Dirent[];
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (entry.isDirectory()) {
      // A leading "_" or "." disables a folder; anything else is a lora folder.
      if (/^[_.]/.test(entry.name)) {
        continue;
      }
      const info = await readLoraFolder(path.join(directory, entry.name), entry.name);
      if (info) {
        infos.set(info.name.toLowerCase(), info);
      }
      continue;
    }

    const flat = /^lora-(.+?)(?:-v\d|-f\d+)?\.gguf$/i.exec(entry.name);
    const name = flat?.[1]?.trim();
    if (name && !infos.has(name.toLowerCase())) {
      infos.set(name.toLowerCase(), {
        name,
        ggufPath: path.join(directory, entry.name),
        promptFiles: [],
      });
    }
  }
}

async function readLoraFolder(directory: string, name: string): Promise<EmbeddedLoraInfo | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(directory);
  } catch {
    return undefined;
  }

  const ggufs = entries.filter((entry) => entry.toLowerCase().endsWith(".gguf")).sort();
  const preferredGguf = ggufs.find((entry) => entry.toLowerCase().startsWith(name.toLowerCase())) ?? ggufs[0];

  let safetensorsPath: string | undefined;
  let jsonPath: string | undefined;
  const lowerEntries = new Set(entries.map((entry) => entry.toLowerCase()));
  const safetensors = entries
    .filter((entry) => entry.toLowerCase().endsWith(".safetensors"))
    .sort((left, right) => {
      const preferLeft = left.toLowerCase().startsWith(name.toLowerCase()) ? 0 : 1;
      const preferRight = right.toLowerCase().startsWith(name.toLowerCase()) ? 0 : 1;
      return preferLeft - preferRight || left.localeCompare(right);
    });
  for (const entry of safetensors) {
    const sidecar = `${entry.slice(0, -".safetensors".length)}.json`;
    if (lowerEntries.has(sidecar.toLowerCase())) {
      const actualSidecar = entries.find((candidate) => candidate.toLowerCase() === sidecar.toLowerCase());
      safetensorsPath = path.join(directory, entry);
      jsonPath = path.join(directory, actualSidecar ?? sidecar);
      break;
    }
  }

  if (!preferredGguf && !safetensorsPath) {
    return undefined;
  }

  return {
    name,
    directory,
    ggufPath: preferredGguf ? path.join(directory, preferredGguf) : undefined,
    safetensorsPath,
    jsonPath,
    promptFiles: entries
      .filter((entry) => entry.toLowerCase().endsWith(".txt"))
      .sort()
      .map((entry) => path.join(directory, entry)),
  };
}

export function availableEmbeddedVariants(options: EmbeddedModelOptions = {}): EmbeddedVariantAvailability[] {
  const modelsDir = embeddedEffectiveDirs(options).modelsDir;
  return VARIANT_NAMES.map((variant) => ({
    variant,
    encodings: ["f16", "f32"].filter((encoding) => modelMissingFiles(modelsDir, variant, encoding).length === 0),
  }));
}

export function embeddedEffectiveDirs(options: EmbeddedModelOptions = {}): {
  modelsDir: string;
  lorasDir: string;
  lorasVariantDir: string;
} {
  const modelsDir = cleanUserPath(options.modelsDir) || resolveEmbeddedModelsDir(options.modelsDir) || "";
  const lorasDir = resolveEmbeddedAdaptersDir(modelsDir, options.adaptersDir);
  return {
    modelsDir,
    lorasDir,
    lorasVariantDir: lorasDir ? path.join(lorasDir, normalizeVariant(options.variant)) : "",
  };
}

export async function embeddedDicePrompts(
  activeLoraNames: string[],
  options: EmbeddedModelOptions = {},
): Promise<{ prompts: { dice: Record<string, string[]> }; missingLoras: string[] }> {
  const wanted = [...new Set(activeLoraNames.map((name) => name.trim()).filter(Boolean))];
  const dice: Record<string, string[]> = {};
  const missingLoras: string[] = [];

  if (wanted.length > 0) {
    const infos = new Map(
      (await listEmbeddedLoraInfos(options)).map((info) => [info.name.toLowerCase(), info]),
    );
    for (const name of wanted) {
      const info = infos.get(name.toLowerCase());
      const pool = info ? await readLoraPromptPool(info) : [];
      if (pool.length > 0) {
        dice[name] = pool;
      } else {
        missingLoras.push(name);
      }
    }
  }

  if (Object.keys(dice).length === 0) {
    Object.assign(dice, promptDefaults.dice);
  }

  return { prompts: { dice }, missingLoras };
}

async function readLoraPromptPool(info: EmbeddedLoraInfo): Promise<string[]> {
  const prompts = new Set<string>();
  for (const promptFile of info.promptFiles) {
    try {
      const firstLine = (await fs.readFile(promptFile, "utf8")).split(/\r?\n/u, 1)[0]?.trim();
      // The host appends live bpm + key/scale, so drop any that the caption already
      // carries (mirrors StripPromptMetadata in the iPlug2 demo / sa3 backends).
      const cleaned = firstLine ? stripPromptMetadata(firstLine) : "";
      if (cleaned) {
        prompts.add(cleaned);
      }
    } catch {
      // Skip unreadable prompt files.
    }
  }
  return [...prompts];
}

// Remove bpm and key/scale segments from a caption so they don't collide with the
// host's appended tempo/key. Comma-delimited segments, matching the demo/backends.
export function stripPromptMetadata(prompt: string): string {
  return prompt
    .split(",")
    .map((segment) => segment.trim())
    .filter((segment) => segment && !segmentHasBpm(segment) && !segmentLooksLikeKey(segment))
    .join(", ")
    .trim();
}

function segmentHasBpm(segment: string): boolean {
  const lower = segment.toLowerCase();
  const bpm = lower.indexOf("bpm");
  if (bpm === -1) {
    return false;
  }
  // "bpm" only counts as tempo when a number leads into it (e.g. "120 bpm").
  for (let i = bpm; i > 0; i--) {
    const c = lower[i - 1]!;
    if (c >= "0" && c <= "9") {
      return true;
    }
    if (!/\s/.test(c) && c !== "-" && c !== "_" && c !== ".") {
      return false;
    }
  }
  return false;
}

function segmentLooksLikeKey(segment: string): boolean {
  const trimmed = segment.trim();
  if (!trimmed || trimmed.length > 24) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  const root = lower[0]!;
  if (root < "a" || root > "g") {
    return false;
  }

  let pos = 1;
  while (pos < lower.length && /\s/.test(lower[pos]!)) pos++;
  if (pos < lower.length && (lower[pos] === "#" || lower[pos] === "b")) {
    pos++;
  } else if (lower.startsWith("sharp", pos)) {
    pos += 5;
  } else if (lower.startsWith("flat", pos)) {
    pos += 4;
  }

  while (pos < lower.length && /\s/.test(lower[pos]!)) pos++;
  if (lower.startsWith("major", pos)) {
    pos += 5;
  } else if (lower.startsWith("minor", pos)) {
    pos += 5;
  } else {
    return false;
  }

  while (pos < lower.length && /\s/.test(lower[pos]!)) pos++;
  return pos === lower.length;
}

export async function resolveLorasForGeneration(
  selections: EmbeddedLora[],
  options: EmbeddedModelOptions,
  update?: (text: string) => Promise<void>,
): Promise<EmbeddedLora[]> {
  const active = selections.filter((lora) => lora.name.trim() && lora.strength > 0);
  if (active.length === 0) {
    return [];
  }

  const infos = new Map(
    (await listEmbeddedLoraInfos(options)).map((info) => [info.name.toLowerCase(), info]),
  );

  const resolved: EmbeddedLora[] = [];
  for (const lora of active) {
    const info = infos.get(lora.name.trim().toLowerCase());
    if (!info) {
      // Unknown here; let libsa3 try its own adapters-dir resolution.
      resolved.push(lora);
      continue;
    }

    if (info.ggufPath && !(await ggufIsStale(info))) {
      resolved.push({ name: info.ggufPath, strength: lora.strength });
      continue;
    }

    if (info.directory && info.safetensorsPath && info.jsonPath) {
      await update?.(`converting lora ${info.name}`);
      const outputPath = path.join(info.directory, `${info.name}-f32.gguf`);
      const native = loadEmbeddedSa3();
      const converted = await native.convertLora({
        safetensorsPath: info.safetensorsPath,
        jsonPath: info.jsonPath,
        outputPath,
      });
      resolved.push({ name: converted.outputPath || outputPath, strength: lora.strength });
      continue;
    }

    if (info.ggufPath) {
      resolved.push({ name: info.ggufPath, strength: lora.strength });
    } else {
      resolved.push(lora);
    }
  }

  return resolved;
}

async function ggufIsStale(info: EmbeddedLoraInfo): Promise<boolean> {
  if (!info.ggufPath || !info.safetensorsPath || !info.directory) {
    return false;
  }

  try {
    const [gguf, safetensors] = await Promise.all([fs.stat(info.ggufPath), fs.stat(info.safetensorsPath)]);
    return safetensors.mtimeMs > gguf.mtimeMs;
  } catch {
    return false;
  }
}

// Maps libsa3's per-step progress ticks (fraction 0..1) into the generation
// slice of the host progress bar, with a readable stage label.
function makeProgressReporter(
  update: (text: string, progress: number) => Promise<void>,
): (stage: string, step: number, total: number, fraction: number) => void {
  const start = 0.24;
  const end = 0.85;
  return (stage, step, total, fraction) => {
    const clamped = Math.max(0, Math.min(1, Number(fraction) || 0));
    const progress = start + clamped * (end - start);
    const name = String(stage || "").trim() || "generating";
    const label = total > 0 ? `sa3 ${name} ${step}/${total}` : `sa3 ${name}`;
    void update(label, progress).catch(() => {});
  };
}

export async function runEmbeddedSa3(
  request: EmbeddedSa3Request,
  outputPath: string,
  update: (text: string, progress: number) => Promise<void>,
  signal: AbortSignal,
): Promise<{ filePath: string; seed?: string }> {
  signal.throwIfAborted();
  const native = loadEmbeddedSa3();
  const diagnostics = native.diagnostics();
  if (!diagnostics.available) {
    throw new Error(diagnostics.reason || "embedded SA3 runtime unavailable");
  }

  const modelStatus = embeddedModelStatus(request);
  const modelsDir = modelStatus.complete ? modelStatus.modelsDir : "";
  if (!modelsDir) {
    throw new Error(`embedded SA3 models missing (${modelStatus.missing.join(", ")}); set up models`);
  }

  await update("preparing loras", 0.18);
  const loras = await resolveLorasForGeneration(
    request.loras,
    { ...request, modelsDir },
    async (text) => update(text, 0.2),
  );

  await update("loading embedded SA3", 0.22);
  const result = await native.generate(
    {
      modelsDir,
      adaptersDir: resolveEmbeddedAdaptersDir(modelsDir, request.adaptersDir),
      variant: normalizeVariant(request.variant),
      encoding: normalizeEncoding(request.encoding),
      device: normalizeDevice(request.device),
      cpuThreads: numberFromEnv("SA3_THREADS", 0),
      prompt: request.prompt,
      negativePrompt: request.negativePrompt,
      duration: request.durationSeconds,
      targetSamples: request.targetSamples,
      steps: request.steps,
      cfgScale: request.cfgScale,
      distShift: request.distShift,
      seed: request.seed,
      keepModels: request.keepModels,
      durationPaddingSec: request.durationPaddingSec,
      loras,
      initPath: request.initPath,
      initNoiseLevel: request.initNoiseLevel,
      inpaintStart: request.inpaintStart,
      inpaintEnd: request.inpaintEnd,
      encodeChunkSize: request.encodeChunkSize,
      encodeOverlap: request.encodeOverlap,
      decodeChunkSize: request.decodeChunkSize,
      decodeOverlap: request.decodeOverlap,
    },
    makeProgressReporter(update),
  );
  signal.throwIfAborted();

  await update("writing embedded SA3 output", 0.85);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, result.wav);
  return { filePath: outputPath, seed: result.seed };
}

export function embeddedModelStatus(options: EmbeddedModelOptions = {}): EmbeddedModelStatus {
  const modelsDir = cleanUserPath(options.modelsDir) || resolveEmbeddedModelsDir(options.modelsDir);
  const variant = normalizeVariant(options.variant);
  const encoding = normalizeEncoding(options.encoding);
  const missing = modelMissingFiles(modelsDir ?? "", variant, encoding);
  return {
    modelsDir: modelsDir ?? "",
    variant,
    encoding,
    complete: missing.length === 0,
    missing,
  };
}

export async function startEmbeddedModelDownload(options: EmbeddedModelOptions = {}): Promise<EmbeddedDownloadStatus> {
  if (downloadState?.active) {
    return downloadState;
  }

  const variant = normalizeVariant(options.variant);
  const encoding = normalizeEncoding(options.encoding);
  const modelsDir = cleanUserPath(options.modelsDir) || resolveEmbeddedModelsDir(options.modelsDir) || "";
  if (!modelsDir) {
    throw new Error("models directory is required");
  }

  await fs.mkdir(modelsDir, { recursive: true });
  downloadCancelRequested = false;
  downloadState = {
    ...embeddedModelStatus({ modelsDir, variant, encoding }),
    modelsDir,
    variant,
    encoding,
    active: true,
    done: false,
    error: "",
    progress: 0,
    label: "starting download",
  };

  void downloadModelSet(modelsDir, variant, encoding).catch((error) => {
    if (downloadState) {
      downloadState.error = error instanceof Error ? error.message : String(error);
      downloadState.active = false;
      downloadState.done = false;
      downloadState.label = "download failed";
    }
  });

  return downloadState;
}

export function embeddedDownloadStatus(options: EmbeddedModelOptions = {}): EmbeddedDownloadStatus {
  if (downloadState) {
    return downloadState;
  }

  return {
    ...embeddedModelStatus(options),
    active: false,
    done: false,
    error: "",
    progress: 0,
    label: "",
  };
}

export function cancelEmbeddedModelDownload(): EmbeddedDownloadStatus {
  downloadCancelRequested = true;
  if (downloadState) {
    downloadState.label = "cancelling download";
  }
  return embeddedDownloadStatus();
}

export function defaultEmbeddedModelsDir(storageDirectory?: string): string {
  return storageDirectory
    ? path.join(storageDirectory, "models")
    : process.platform === "win32"
      ? path.join(process.env.LOCALAPPDATA || process.cwd(), "Ableton", "Extensions Data", "gary.gary-extension", "models")
      : path.join(process.cwd(), "models");
}

export function defaultEmbeddedLorasDir(storageDirectory?: string): string {
  return storageDirectory
    ? path.join(storageDirectory, "loras")
    : path.join(defaultEmbeddedModelsDir(storageDirectory), "loras");
}

function resolveEmbeddedModelsDir(preferred?: string): string | undefined {
  return firstExistingDirectory([
    preferred,
    process.env.SA3_MODELS_DIR,
    path.join(embeddedNativeDirectory(), "models"),
    process.env.SA3_CPP_DIR ? path.join(process.env.SA3_CPP_DIR, "models") : undefined,
    path.resolve(process.cwd(), "..", "sa3.cpp", "models"),
    path.resolve(process.cwd(), "models"),
    process.platform === "win32" ? "C:\\dev\\sa3.cpp\\models" : undefined,
  ]);
}

function resolveEmbeddedAdaptersDir(modelsDir: string, preferred?: string): string {
  const explicit = cleanUserPath(preferred);
  if (explicit) {
    return explicit;
  }

  return firstExistingDirectory([
    process.env.SA3_ADAPTERS_DIR,
    modelsDir,
  ]) ?? modelsDir;
}

function firstExistingDirectory(candidates: Array<string | undefined>): string | undefined {
  for (const candidate of candidates) {
    const directory = cleanUserPath(candidate);
    if (!directory) {
      continue;
    }

    try {
      const stats = fsSync.statSync(directory);
      if (stats.isDirectory()) {
        return directory;
      }
    } catch {
      // Try the next candidate.
    }
  }

  return undefined;
}

function normalizeVariant(variant: string | undefined): string {
  return ["medium", "small-music", "small-sfx"].includes(String(variant || "").trim())
    ? String(variant).trim()
    : "medium";
}

function normalizeEncoding(encoding: string | undefined): string {
  return String(encoding || "").trim().toLowerCase() === "f32" ? "f32" : "f16";
}

export function normalizeDevice(device: string | undefined): string {
  return String(device || "").trim().toLowerCase() === "cpu" ? "cpu" : "auto";
}

function variantIsSmall(variant: string): boolean {
  return variant === "small-music" || variant === "small-sfx";
}

function modelPlan(variant: string, encoding: string): ModelDownloadItem[] {
  const enc = encoding === "f32" ? "F32" : "F16";
  const ditSize = variantIsSmall(variant) ? "0.5B" : "1.5B";
  const same = variantIsSmall(variant) ? "same-s" : "same-l";
  const varRepo = `thepatch/stable-audio-3-${variant}-GGUF`;
  const shared = "thepatch/t5gemma-b-b-ul2-GGUF";
  const base = `stable-audio-3-${variant}`;

  return [
    {
      repo: varRepo,
      filename: `${base}-dit-${ditSize}-v1.0-${enc}.gguf`,
      globPrefix: `${base}-dit-`,
      globSuffix: `-${enc}.gguf`,
      what: "DiT",
    },
    {
      repo: varRepo,
      filename: `${base}-${same}-v1.0-${enc}.gguf`,
      globPrefix: `${base}-same-`,
      globSuffix: `-${enc}.gguf`,
      what: "SAME",
    },
    {
      repo: varRepo,
      filename: `${base}-conditioner-v1.0-F32.gguf`,
      globPrefix: `${base}-conditioner-`,
      globSuffix: ".gguf",
      what: "conditioner",
    },
    {
      repo: shared,
      filename: "t5gemma-b-b-ul2-encoder-0.3B-v1.0-F32.gguf",
      globPrefix: "t5gemma-b-b-ul2-encoder-",
      globSuffix: ".gguf",
      what: "encoder",
    },
    {
      repo: shared,
      filename: "t5gemma-b-b-ul2-v1.0-vocab.gguf",
      globPrefix: "t5gemma-b-b-ul2-v1.0-vocab",
      globSuffix: ".gguf",
      what: "tokenizer",
    },
  ];
}

function modelMissingFiles(modelsDir: string, variant: string, encoding: string): string[] {
  const directory = cleanUserPath(modelsDir);
  if (!directory) {
    return ["all"];
  }

  let entries: string[];
  try {
    entries = fsSync.readdirSync(directory);
  } catch {
    return ["all"];
  }

  const lowerEntries = entries.map((entry) => entry.toLowerCase());
  return modelPlan(variant, encoding)
    .filter((item) => !lowerEntries.some((entry) => entry.startsWith(item.globPrefix.toLowerCase()) && entry.endsWith(item.globSuffix.toLowerCase())))
    .map((item) => item.what);
}

async function downloadModelSet(modelsDir: string, variant: string, encoding: string): Promise<void> {
  const plan = modelPlan(variant, encoding);
  let completed = 0;

  for (const item of plan) {
    if (downloadCancelRequested) {
      throw new Error("download cancelled");
    }

    const outputPath = path.join(modelsDir, item.filename);
    if (await fileExists(outputPath)) {
      completed += 1;
      updateDownloadState(modelsDir, variant, encoding, completed / plan.length, `${item.what} already present`);
      continue;
    }

    const url = `https://huggingface.co/${item.repo}/resolve/main/${encodeURIComponent(item.filename)}`;
    await downloadFile(url, outputPath, (fileProgress) => {
      updateDownloadState(
        modelsDir,
        variant,
        encoding,
        (completed + fileProgress) / plan.length,
        `downloading ${item.what} ${completed + 1}/${plan.length}`,
      );
    });
    completed += 1;
  }

  const status = embeddedModelStatus({ modelsDir, variant, encoding });
  downloadState = {
    ...status,
    active: false,
    done: status.complete,
    error: status.complete ? "" : `missing ${status.missing.join(", ")}`,
    progress: status.complete ? 1 : downloadState?.progress ?? 0,
    label: status.complete ? "models ready" : "download incomplete",
  };
}

function updateDownloadState(
  modelsDir: string,
  variant: string,
  encoding: string,
  progress: number,
  label: string,
) {
  const status = embeddedModelStatus({ modelsDir, variant, encoding });
  downloadState = {
    ...status,
    active: true,
    done: false,
    error: "",
    progress: Math.max(0, Math.min(1, progress)),
    label,
  };
}

async function downloadFile(url: string, outputPath: string, onProgress: (progress: number) => void): Promise<void> {
  const tempPath = `${outputPath}.part`;
  const response = await fetch(url);
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) ${url}`);
  }

  const total = Number(response.headers.get("content-length")) || 0;
  let received = 0;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const file = fsSync.createWriteStream(tempPath);
  const reader = response.body.getReader();

  try {
    while (true) {
      if (downloadCancelRequested) {
        throw new Error("download cancelled");
      }
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      received += value.byteLength;
      file.write(Buffer.from(value));
      onProgress(total > 0 ? received / total : 0);
    }
  } finally {
    await new Promise<void>((resolve) => file.end(resolve));
  }

  await fs.rename(tempPath, outputPath);
  onProgress(1);
}

async function fileExists(filePath: string): Promise<boolean> {
  const cleanPath = cleanUserPath(filePath);
  try {
    const stats = await fs.stat(cleanPath);
    return stats.isFile();
  } catch {
    return false;
  }
}

function cleanUserPath(value: string | undefined): string {
  let result = String(value || "").trim();
  while (
    result.length >= 2 &&
    ((result.startsWith('"') && result.endsWith('"')) || (result.startsWith("'") && result.endsWith("'")))
  ) {
    result = result.slice(1, -1).trim();
  }

  if (result.toLowerCase().startsWith("file://")) {
    try {
      const fileUrl = new URL(result);
      result = decodeURIComponent(fileUrl.pathname);
      if (process.platform === "win32" && /^\/[a-z]:/i.test(result)) {
        result = result.slice(1);
      }
      result = result.replaceAll("/", path.sep);
    } catch {
      result = result.replace(/^file:\/+/i, "");
    }
  }

  return result ? path.normalize(result) : "";
}

function numberFromEnv(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) ? value : fallback;
}
