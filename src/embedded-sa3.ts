import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";
import { createRequire } from "node:module";
import { pipeline } from "node:stream/promises";
import { promptDefaults } from "./prompt-defaults.js";
import {
  laneBlendSettings,
  waveformPeaks,
  type LaneBlend,
  type PlannedLane,
} from "./lane-model.js";

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
  steps: number;
  cfgScale: number;
  distShift: string;
  seed: number;
  keepModels: boolean;
  generationTailPaddingSeconds: number;
  continuationTailPaddingSeconds: number;
  decoderLoraEnabled: boolean;
  peakNormalize: boolean;
  peakNormalizeDb: number;
  limiter: boolean;
  limiterCeilingDb: number;
  limiterKnee: number;
  loras: EmbeddedLora[];
  lanes: PlannedLane[];
  laneBlend: LaneBlend;
  /** What a lane falls back to if its LoRA can't run in one, by LoRA name. */
  laneFallbackStrengths: Record<string, number>;
  /** Where the part worth showing starts in the output: Continue's output includes its source. */
  outputPeaksFromSeconds: number;
  initPath?: string | undefined;
  initNoiseLevel?: number | undefined;
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
    supportsLanes?: boolean;
  };
  generate(
    request: Record<string, unknown>,
    onProgress?: (stage: string, step: number, total: number, fraction: number) => void,
  ): Promise<EmbeddedSa3Result>;
  cancelGeneration(): boolean;
  convertLora(request: Record<string, unknown>): Promise<{ outputPath: string }>;
  adapterInfo(path: string): { target: string; supportsLanes: boolean } | null;
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

export interface EmbeddedDecoderLoraStatus {
  compatible: boolean;
  installed: boolean;
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
  /** Other .json files in the folder, which may hold a prompt pool. */
  jsonFiles: string[];
}

export interface EmbeddedVariantAvailability {
  variant: string;
  encodings: string[];
}

let downloadState: EmbeddedDownloadStatus | undefined;
let downloadAbort = new AbortController();
let decoderDownloadState: EmbeddedDecoderLoraStatus | undefined;
let decoderDownloadAbort = new AbortController();

const DECODER_LORA_REPO = "thepatch/same-l-decoder-lora";
const DECODER_LORA_FILENAME = "squeakfix_v3.safetensors";
const DECODER_LORA_GGUF_FILENAME = "squeakfix_v3-f32.gguf";

let cachedNative: EmbeddedSa3Native | undefined;
let cachedNativeError: string | undefined;

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

function adapterSupportsLanes(path: string): boolean {
  // Unreadable or unanswerable means let generate decide, and report it if the adapter is wrong.
  try {
    return loadEmbeddedSa3().adapterInfo(path)?.supportsLanes !== false;
  } catch {
    return true;
  }
}

/**
 * Which LoRAs can have a lane, by name. A safetensors LoRA can't be read until it's converted on first
 * use, so it counts as yes here and the render checks it again.
 */
export async function embeddedLaneSupport(options: EmbeddedModelOptions = {}): Promise<Record<string, boolean>> {
  const support: Record<string, boolean> = {};
  for (const info of await listEmbeddedLoraInfos(options)) {
    support[info.name] = info.ggufPath ? adapterSupportsLanes(info.ggufPath) : true;
  }
  return support;
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

const FLAT_LORA_FILE = /^lora-(.+?)(?:-v\d|-f\d+)?\.gguf$/i;

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

    const flat = FLAT_LORA_FILE.exec(entry.name);
    const name = flat?.[1]?.trim();
    if (name && !infos.has(name.toLowerCase())) {
      infos.set(name.toLowerCase(), {
        name,
        ggufPath: path.join(directory, entry.name),
        promptFiles: [],
        jsonFiles: [],
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
    safetensorsPath = path.join(directory, entry);
    if (lowerEntries.has(sidecar.toLowerCase())) {
      const actualSidecar = entries.find((candidate) => candidate.toLowerCase() === sidecar.toLowerCase());
      jsonPath = path.join(directory, actualSidecar ?? sidecar);
    }
    break;
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
    jsonFiles: entries
      .filter((entry) => entry.toLowerCase().endsWith(".json"))
      .map((entry) => path.join(directory, entry))
      .filter((file) => file !== jsonPath),
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
  includeDefaults = false,
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

  if (includeDefaults || Object.keys(dice).length === 0) {
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
  for (const jsonFile of info.jsonFiles) {
    try {
      for (const prompt of promptsFromPoolJson(JSON.parse(await fs.readFile(jsonFile, "utf8")))) {
        const cleaned = stripPromptMetadata(prompt);
        if (cleaned) {
          prompts.add(cleaned);
        }
      }
    } catch {
      // Not every .json here is a pool, and a broken one shouldn't stop the dice.
    }
  }
  return [...prompts];
}

// The strings of a pool: sa3.cpp's prompts/<lora>.json shape ({ "dice": { "<bucket>": [...] } }), or a
// plain array. Anything else, such as an adapter's rank and alpha settings, has none.
export function promptsFromPoolJson(json: unknown): string[] {
  const buckets = Array.isArray(json)
    ? [json]
    : Object.values((json as { dice?: Record<string, unknown> } | null)?.dice ?? {});
  return buckets.flatMap((bucket) =>
    Array.isArray(bucket) ? bucket.filter((item): item is string => typeof item === "string") : []);
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

// The file a LoRA runs from, converting safetensors on first use. Unknown names pass through, so
// libsa3 can try its own adapters-dir resolution.
async function resolveLoraPath(
  name: string,
  infos: Map<string, EmbeddedLoraInfo>,
  update?: (text: string) => Promise<void>,
): Promise<string> {
  const info = infos.get(name.trim().toLowerCase());
  if (!info) {
    return name;
  }
  if (info.ggufPath && !(await ggufIsStale(info))) {
    return info.ggufPath;
  }
  if (info.directory && info.safetensorsPath) {
    await update?.(`converting lora ${info.name}`);
    const outputPath = path.join(info.directory, `${info.name}-f32.gguf`);
    const converted = await loadEmbeddedSa3().convertLora({
      safetensorsPath: info.safetensorsPath,
      ...(info.jsonPath ? { jsonPath: info.jsonPath } : {}),
      outputPath,
    });
    return converted.outputPath || outputPath;
  }
  return info.ggufPath ?? name;
}

async function loraInfosByName(options: EmbeddedModelOptions): Promise<Map<string, EmbeddedLoraInfo>> {
  return new Map((await listEmbeddedLoraInfos(options)).map((info) => [info.name.toLowerCase(), info]));
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

  const infos = await loraInfosByName(options);
  const resolved: EmbeddedLora[] = [];
  for (const lora of active) {
    resolved.push({ name: await resolveLoraPath(lora.name, infos, update), strength: lora.strength });
  }
  return resolved;
}

const IMPORTABLE_LORA_FILE = /\.(gguf|safetensors|json|txt)$/iu;
const MAX_IMPORTED_JSON_BYTES = 16 * 1024 * 1024;

// The folder holding one LoRA, refusing a name that would land anywhere else.
function importedLoraDirectory(options: EmbeddedModelOptions, name: string): string {
  const variantDir = embeddedEffectiveDirs(options).lorasVariantDir;
  if (!variantDir) {
    throw new Error("the loras folder isn't available");
  }
  // A leading "_" or "." means a disabled folder, which would make it vanish from the list.
  if (!name.trim() || name !== path.basename(name) || /^[_.]|[<>:"/\\|?*]/u.test(name)) {
    throw new Error(`"${name}" can't be a lora name`);
  }
  return path.join(variantDir, name);
}

/**
 * Stores a file the dialog read for us, which is how a file from anywhere reaches the sandbox: only the
 * dialog sees the original, and this only ever writes inside the LoRA's own folder.
 */
export async function importEmbeddedLoraFile(
  options: EmbeddedModelOptions,
  name: string,
  fileName: string,
  body: NodeJS.ReadableStream,
): Promise<void> {
  const directory = importedLoraDirectory(options, name);
  if (fileName !== path.basename(fileName) || !IMPORTABLE_LORA_FILE.test(fileName)) {
    throw new Error(`can't import ${fileName}: choose a .gguf, .safetensors, .json or .txt file`);
  }
  await fs.mkdir(directory, { recursive: true });

  if (fileName.toLowerCase().endsWith(".json")) {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of body) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > MAX_IMPORTED_JSON_BYTES) {
        throw new Error(`${fileName} is too large to be a sidecar or a prompt pool`);
      }
      chunks.push(bytes);
    }
    const text = Buffer.concat(chunks);
    // A pool is often called <lora>.json, which next to the adapter would read as its settings.
    let isPool = false;
    try {
      isPool = promptsFromPoolJson(JSON.parse(text.toString("utf8"))).length > 0;
    } catch {
      throw new Error(`${fileName} isn't valid JSON`);
    }
    await fs.writeFile(path.join(directory, isPool ? "prompts.json" : fileName), text);
    return;
  }

  const outputPath = path.join(directory, fileName);
  const partPath = `${outputPath}.part`;
  await pipeline(body, fsSync.createWriteStream(partPath));
  await fs.rename(partPath, outputPath);
}

/** A safetensors LoRA that can't convert until it has its .json settings file. */
export class LoraNeedsSettingsError extends Error {}

/** Converts an imported LoRA now, so a bad one is reported here rather than at its first render. */
export async function finishEmbeddedLoraImport(
  options: EmbeddedModelOptions,
  name: string,
  adapterJustImported: boolean,
): Promise<{ target: string; supportsLanes: boolean; promptCount: number }> {
  importedLoraDirectory(options, name);
  const infos = await loraInfosByName(options);
  const info = infos.get(name.toLowerCase());
  if (!info) {
    throw new Error(`${name} has no .gguf or .safetensors file yet`);
  }
  const promptCount = (await readLoraPromptPool(info)).length;
  if (!info.ggufPath && !info.safetensorsPath) {
    return { target: "dit", supportsLanes: true, promptCount };
  }
  let loraPath: string;
  try {
    loraPath = await resolveLoraPath(name, infos);
  } catch (error) {
    // Otherwise a file that can't run would stay on the list. One that was already here isn't ours to
    // remove, as when prompts are added to a folder someone copied in by hand.
    if (adapterJustImported && info.safetensorsPath) {
      await fs.rm(info.safetensorsPath, { force: true });
      // Only goes if nothing else is in there.
      await fs.rmdir(path.dirname(info.safetensorsPath)).catch(() => {});
    }
    const reason = error instanceof Error ? error.message : String(error);
    if (!info.jsonPath && /lora_config|json sidecar/iu.test(reason)) {
      throw new LoraNeedsSettingsError(`${name} needs its settings file too: choose its .json`);
    }
    throw new Error(`couldn't convert ${name}: ${reason}`);
  }
  const read = loadEmbeddedSa3().adapterInfo(loraPath);
  return { target: read?.target ?? "dit", supportsLanes: read?.supportsLanes !== false, promptCount };
}

const LORA_OWN_FILE = /\.(gguf|safetensors|json|txt)(\.part)?$/iu;

/**
 * Deletes a LoRA from the list. The name is only looked up among what's listed, so it can't reach anywhere
 * else, and only the kinds of file a LoRA is made of go: a dataset copied in alongside one stays, and so
 * does its folder.
 */
export async function removeEmbeddedLora(
  options: EmbeddedModelOptions,
  name: string,
): Promise<{ itemsLeft: number }> {
  const info = (await loraInfosByName(options)).get(name.toLowerCase());
  if (!info) {
    throw new Error(`${name} isn't on the list`);
  }

  const files: string[] = [];
  if (info.directory) {
    for (const entry of await fs.readdir(info.directory, { withFileTypes: true })) {
      if (entry.isFile() && LORA_OWN_FILE.test(entry.name)) {
        files.push(path.join(info.directory, entry.name));
      }
    }
  }
  // Flat files of the same name would otherwise step up and put it straight back on the list.
  const variantDir = embeddedEffectiveDirs(options).lorasVariantDir;
  for (const entry of await fs.readdir(variantDir, { withFileTypes: true })) {
    if (entry.isFile() && FLAT_LORA_FILE.exec(entry.name)?.[1]?.trim().toLowerCase() === name.toLowerCase()) {
      files.push(path.join(variantDir, entry.name));
    }
  }

  await Promise.all(files.map((file) => fs.rm(file, { force: true })));

  if (!info.directory) {
    return { itemsLeft: 0 };
  }
  const itemsLeft = (await fs.readdir(info.directory)).length;
  if (itemsLeft === 0) {
    await fs.rmdir(info.directory);
  }
  return { itemsLeft };
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
): Promise<{ filePath: string; seed?: string; peaks: number[] }> {
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

  const lanes: Array<{ loraPath: string; prompt: string; envelope: number[] }> = [];
  if (request.lanes.length > 0) {
    if (!diagnostics.supportsLanes) {
      throw new Error("this libsa3 predates automation lanes");
    }
    const infos = await loraInfosByName({ ...request, modelsDir });
    for (const lane of request.lanes) {
      const loraPath = await resolveLoraPath(lane.name, infos, async (text) => update(text, 0.2));
      if (adapterSupportsLanes(loraPath)) {
        lanes.push({ loraPath, prompt: lane.prompt, envelope: lane.envelope });
        continue;
      }
      // Generate would fail on it, and the dialog can't know until a safetensors LoRA is converted.
      const strength = request.laneFallbackStrengths[lane.name] ?? 0;
      console.warn(`[gary-sa3] ${lane.name} can't run in a lane; using its fixed strength ${strength}`);
      if (strength > 0) {
        loras.push({ name: loraPath, strength });
      }
    }
  }

  const decoder = embeddedDecoderLoraStatus(request);
  if (request.decoderLoraEnabled && decoder.compatible && decoder.installed) {
    loras.push({ name: decoderLoraPaths(request).ggufPath, strength: 1 });
  }

  signal.throwIfAborted();
  await update("loading embedded SA3", 0.22);
  const cancelGeneration = () => {
    native.cancelGeneration();
  };
  signal.addEventListener("abort", cancelGeneration, { once: true });

  let result: EmbeddedSa3Result;
  try {
    const generation = native.generate(
      {
        modelsDir,
        adaptersDir: resolveEmbeddedAdaptersDir(modelsDir, request.adaptersDir),
        variant: normalizeVariant(request.variant),
        encoding: normalizeEncoding(request.encoding),
        device: normalizeDevice(request.device),
        cpuThreads: numberFromEnv("SA3_THREADS", 0),
        prompt: request.prompt,
        negativePrompt: request.negativePrompt,
        operation: request.operation,
        duration: request.durationSeconds,
        steps: request.steps,
        cfgScale: request.cfgScale,
        distShift: request.distShift,
        seed: request.seed,
        keepModels: request.keepModels,
        generationTailPaddingSeconds: request.generationTailPaddingSeconds,
        continuationTailPaddingSeconds: request.continuationTailPaddingSeconds,
        peakNormalize: request.peakNormalize,
        peakNormalizeDb: request.peakNormalizeDb,
        limiter: request.limiter,
        limiterCeilingDb: request.limiterCeilingDb,
        limiterKnee: request.limiterKnee,
        loras,
        lanes,
        ...(() => {
          const blend = laneBlendSettings(request.laneBlend);
          return {
            laneIsolation: blend.isolation,
            laneIsolationUntil: blend.isolationUntil,
            laneAverageUntil: blend.averageUntil,
          };
        })(),
        initPath: request.initPath,
        initNoiseLevel: request.initNoiseLevel,
        encodeChunkSize: request.encodeChunkSize,
        encodeOverlap: request.encodeOverlap,
        decodeChunkSize: request.decodeChunkSize,
        decodeOverlap: request.decodeOverlap,
      },
      makeProgressReporter(update),
    );
    if (signal.aborted) {
      cancelGeneration();
    }
    result = await generation;
    signal.throwIfAborted();
  } catch (error) {
    signal.throwIfAborted();
    throw error;
  } finally {
    signal.removeEventListener("abort", cancelGeneration);
  }

  await update("writing embedded SA3 output", 0.85);
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  await fs.writeFile(outputPath, result.wav);
  return {
    filePath: outputPath,
    seed: result.seed,
    peaks: waveformPeaks(result.wav, request.outputPeaksFromSeconds),
  };
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
  downloadAbort = new AbortController();
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

  const signal = downloadAbort.signal;
  void downloadModelSet(modelsDir, variant, encoding, signal).catch((error) => {
    if (downloadState) {
      const cancelled = signal.aborted;
      downloadState.error = cancelled
        ? ""
        : `${error instanceof Error ? error.message : String(error)}; download again to resume`;
      downloadState.active = false;
      downloadState.done = false;
      downloadState.label = cancelled ? "download cancelled; partial files kept, resume any time" : "download failed";
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
  downloadAbort.abort();
  if (downloadState) {
    downloadState.label = "cancelling download";
  }
  return embeddedDownloadStatus();
}

export function embeddedDecoderLoraStatus(options: EmbeddedModelOptions = {}): EmbeddedDecoderLoraStatus {
  const compatible = normalizeVariant(options.variant) === "medium";
  const installed = fsSync.existsSync(decoderLoraPaths(options).ggufPath);
  if (decoderDownloadState?.active) {
    return { ...decoderDownloadState, compatible, installed };
  }
  return {
    compatible,
    installed,
    active: false,
    done: installed,
    error: decoderDownloadState?.error || "",
    progress: installed ? 1 : decoderDownloadState?.progress || 0,
    label: installed ? "decoder correction ready" : decoderDownloadState?.label || "not installed",
  };
}

export async function startEmbeddedDecoderLoraDownload(
  options: EmbeddedModelOptions = {},
): Promise<EmbeddedDecoderLoraStatus> {
  if (decoderDownloadState?.active) {
    return embeddedDecoderLoraStatus(options);
  }

  const paths = decoderLoraPaths(options);
  await fs.mkdir(paths.directory, { recursive: true });
  decoderDownloadAbort = new AbortController();
  decoderDownloadState = {
    compatible: normalizeVariant(options.variant) === "medium",
    installed: await fileExists(paths.ggufPath),
    active: true,
    done: false,
    error: "",
    progress: 0,
    label: "starting decoder download",
  };

  void downloadDecoderLora(options, decoderDownloadAbort.signal).catch((error) => {
    decoderDownloadState = {
      ...embeddedDecoderLoraStatus(options),
      active: false,
      done: false,
      error: error instanceof Error ? error.message : String(error),
      label: "decoder download failed",
    };
  });
  return embeddedDecoderLoraStatus(options);
}

export function cancelEmbeddedDecoderLoraDownload(
  options: EmbeddedModelOptions = {},
): EmbeddedDecoderLoraStatus {
  decoderDownloadAbort.abort();
  if (decoderDownloadState) {
    decoderDownloadState.label = "cancelling decoder download";
  }
  return embeddedDecoderLoraStatus(options);
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

async function downloadModelSet(
  modelsDir: string,
  variant: string,
  encoding: string,
  signal: AbortSignal,
): Promise<void> {
  const plan = modelPlan(variant, encoding);
  let completed = 0;

  for (const item of plan) {
    signal.throwIfAborted();

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
    }, signal);
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

async function downloadDecoderLora(options: EmbeddedModelOptions, signal: AbortSignal): Promise<void> {
  const paths = decoderLoraPaths(options);
  if (!(await fileExists(paths.ggufPath))) {
    if (!(await fileExists(paths.safetensorsPath))) {
      const url = `https://huggingface.co/${DECODER_LORA_REPO}/resolve/main/${encodeURIComponent(DECODER_LORA_FILENAME)}`;
      await downloadFile(url, paths.safetensorsPath, (progress) => {
        decoderDownloadState = {
          ...embeddedDecoderLoraStatus(options),
          active: true,
          done: false,
          error: "",
          progress: progress * 0.9,
          label: "downloading decoder correction",
        };
      }, signal);
    }

    signal.throwIfAborted();
    decoderDownloadState = {
      ...embeddedDecoderLoraStatus(options),
      active: true,
      done: false,
      error: "",
      progress: 0.95,
      label: "converting decoder correction",
    };
    const converted = await loadEmbeddedSa3().convertLora({
      safetensorsPath: paths.safetensorsPath,
      outputPath: paths.ggufPath,
    });
    if (!converted.outputPath && !(await fileExists(paths.ggufPath))) {
      throw new Error("decoder conversion completed without an output file");
    }
  }

  decoderDownloadState = {
    compatible: normalizeVariant(options.variant) === "medium",
    installed: true,
    active: false,
    done: true,
    error: "",
    progress: 1,
    label: "decoder correction ready",
  };
}

function decoderLoraPaths(options: EmbeddedModelOptions): {
  directory: string;
  safetensorsPath: string;
  ggufPath: string;
} {
  const lorasDir = embeddedEffectiveDirs(options).lorasDir || defaultEmbeddedLorasDir();
  const directory = path.join(lorasDir, "decoder", "squeakfix_v3");
  return {
    directory,
    safetensorsPath: path.join(directory, DECODER_LORA_FILENAME),
    ggufPath: path.join(directory, DECODER_LORA_GGUF_FILENAME),
  };
}

// Keeps what it has in a .part file, and picks up from there the next time.
export async function downloadFile(
  url: string,
  outputPath: string,
  onProgress: (progress: number) => void,
  signal: AbortSignal,
): Promise<void> {
  const tempPath = `${outputPath}.part`;
  await fs.mkdir(path.dirname(outputPath), { recursive: true });
  const existing = await fs.stat(tempPath).then((stats) => stats.size, () => 0);
  const response = await fetch(url, {
    signal,
    ...(existing > 0 ? { headers: { Range: `bytes=${existing}-` } } : {}),
  });

  // Asked for bytes past the end, which only happens when the .part already holds them all.
  if (response.status === 416) {
    await response.body?.cancel();
    await fs.rename(tempPath, outputPath);
    onProgress(1);
    return;
  }
  if (!response.ok || !response.body) {
    throw new Error(`download failed (${response.status}) ${url}`);
  }

  // A server that ignores the range sends the whole file with a 200, so start over.
  const resumed = response.status === 206;
  const length = Number(response.headers.get("content-length")) || 0;
  const total = length > 0 ? length + (resumed ? existing : 0) : 0;
  let received = resumed ? existing : 0;
  const file = fsSync.createWriteStream(tempPath, { flags: resumed ? "a" : "w" });
  let failure: Error | undefined;
  file.on("error", (error) => {
    failure = error;
  });
  const reader = response.body.getReader();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      if (failure) {
        throw failure;
      }
      received += value.byteLength;
      if (!file.write(Buffer.from(value))) {
        await new Promise<void>((resolve) => file.once("drain", resolve));
      }
      onProgress(total > 0 ? received / total : 0);
    }
  } finally {
    await new Promise<void>((resolve) => file.end(resolve));
  }

  // A connection that drops early can still end the stream cleanly, and that file must not be used.
  if (failure) {
    throw failure;
  }
  if (total > 0 && received < total) {
    throw new Error(`download stopped early (${received} of ${total} bytes)`);
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
