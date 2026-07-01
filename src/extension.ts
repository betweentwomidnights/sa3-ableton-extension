import {
  AudioTrack,
  DataModelObject,
  initialize,
  type ActivationContext,
  type ArrangementSelection,
  type ContextMenuScope,
  type ExtensionContext,
} from "@ableton-extensions/sdk";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import transformDialog from "./transform-dialog.html";

const API_VERSION = "1.0.0";
const COMMAND_TRANSFORM_SELECTION = "gary.sa3.transformSelection";
const COMMAND_CONTINUE_SELECTION = "gary.sa3.continueSelection";
const COMMAND_GENERATE_SELECTION = "gary.sa3.generateSelection";
const DEFAULT_LOCAL_SA3_URL = "http://localhost:8006";
let warnedMissingStorageDirectory = false;
let warnedSettingsWriteFailure = false;
let inMemorySettings: TransformSettings | undefined;

type Context = ExtensionContext<typeof API_VERSION>;
type SelectionOperation = "transform" | "continue" | "generate";

interface TransformSettings {
  backendUrl: string;
  prompt: string;
  strength: number;
  steps: number;
  cfgScale: number;
  shift: string;
  negativePrompt: string;
  seed: number;
  useSeed: boolean;
  lastSeed: string;
  replaceSelection: boolean;
  continueBeats: number;
  loras: LoraSelection[];
}

interface LoraSelection {
  name: string;
  strength: number;
}

interface DialogResult {
  action: SelectionOperation | "cancel" | "dice" | "refresh-loras";
  settings?: TransformSettings;
}

interface DialogInitial extends TransformSettings {
  operation: SelectionOperation;
  selectionLabel: string;
  selectionBeats: number;
  beatsPerBar: number;
  tempoLabel: string;
  keyScaleLabel: string;
  localBackendUrl: string;
  availableLoras: string[];
  statusMessage: string;
}

interface MusicContext {
  tempo: number;
  beatsPerBar: number;
  keyScale: string;
}

interface DicePromptResult {
  prompt: string;
  missingLoras: string[];
}

interface BackendHealth {
  online: boolean;
  status: string;
}

interface PollStatus {
  success?: boolean;
  status?: string;
  progress?: number;
  audio_data?: string;
  error?: string;
  errors?: unknown[];
  meta?: {
    seed?: number | string;
  };
}

interface TransformResult {
  filePath: string;
  seed?: string;
}

class BackendHttpError extends Error {
  constructor(
    readonly status: number,
    readonly responseBody: unknown,
    fallback: string,
  ) {
    super(errorFromResponse(responseBody, fallback));
    this.name = "BackendHttpError";
  }
}

const defaultSettings: TransformSettings = {
  backendUrl: DEFAULT_LOCAL_SA3_URL,
  prompt: "",
  strength: 0.9,
  steps: 8,
  cfgScale: 1.0,
  shift: "full",
  negativePrompt: "",
  seed: -1,
  useSeed: false,
  lastSeed: "",
  replaceSelection: true,
  continueBeats: 0,
  loras: [],
};

export function activate(activation: ActivationContext) {
  console.log(`[gary-sa3] activate; host API ${activation.hostApiVersion}`);
  const context = initialize(activation, API_VERSION);

  context.commands.registerCommand(COMMAND_TRANSFORM_SELECTION, (arg: unknown) => {
    console.log("[gary-sa3] transform command invoked");
    void processSelection(context, arg as ArrangementSelection, "transform").catch((error) => {
      console.error("[gary-sa3] transform failed", error);
    });
  });

  context.commands.registerCommand(COMMAND_CONTINUE_SELECTION, (arg: unknown) => {
    console.log("[gary-sa3] continue command invoked");
    void processSelection(context, arg as ArrangementSelection, "continue").catch((error) => {
      console.error("[gary-sa3] continue failed", error);
    });
  });

  context.commands.registerCommand(COMMAND_GENERATE_SELECTION, (arg: unknown) => {
    console.log("[gary-sa3] generate command invoked");
    void processSelection(context, arg as ArrangementSelection, "generate").catch((error) => {
      console.error("[gary-sa3] generate failed", error);
    });
  });

  void registerContextMenus(context).catch((error) => {
    console.error("[gary-sa3] context menu registration failed", error);
  });
}

async function registerContextMenus(context: Context) {
  await registerMenuAction(
    context,
    "AudioTrack.ArrangementSelection",
    "Gary SA3: Transform Selection",
    COMMAND_TRANSFORM_SELECTION,
  );
  await registerMenuAction(
    context,
    "AudioTrack.ArrangementSelection",
    "Gary SA3: Continue Selection",
    COMMAND_CONTINUE_SELECTION,
  );
  await registerMenuAction(
    context,
    "AudioTrack.ArrangementSelection",
    "Gary SA3: Generate Selection",
    COMMAND_GENERATE_SELECTION,
  );
}

async function registerMenuAction(
  context: Context,
  scope: ContextMenuScope<typeof API_VERSION>,
  title: string,
  commandId: string,
) {
  await context.ui.registerContextMenuAction(scope, title, commandId);
  console.log(`[gary-sa3] registered context menu: ${scope} -> ${title}`);
}

async function processSelection(
  context: Context,
  selection: ArrangementSelection,
  operation: SelectionOperation,
) {
  const startBeat = selection.time_selection_start;
  const endBeat = selection.time_selection_end;

  if (!Number.isFinite(startBeat) || !Number.isFinite(endBeat) || endBeat <= startBeat) {
    console.error("[gary-sa3] No valid arrangement time selection.");
    return;
  }

  const tracks = selection.selected_lanes
    .map((handle) => context.getObjectFromHandle(handle, DataModelObject))
    .filter((object): object is AudioTrack<typeof API_VERSION> => object instanceof AudioTrack);

  if (tracks.length === 0) {
    console.error("[gary-sa3] No audio tracks found in the arrangement selection.");
    return;
  }

  const storedSettings = await readStoredSettings(context);
  const musicContext = getMusicContext(context);
  const selectionBeats = endBeat - startBeat;
  let settings = sanitizeSettings({
    ...defaultSettings,
    ...storedSettings,
  });
  const initialSettings = settings;
  if (operation === "continue" && settings.continueBeats <= 0) {
    settings = {
      ...settings,
      continueBeats: clamp(selectionBeats, 0.25, 1024),
    };
  }
  let loraNames = await fetchAvailableLoras(settings.backendUrl);
  let statusMessage = loraStatusMessage(loraNames);
  const selectionLabel = `${tracks.length} track${tracks.length === 1 ? "" : "s"} / ${formatBeatBarDuration(selectionBeats, musicContext.beatsPerBar)}`;

  const dialogResult = await runTransformDialog(context, {
    operation,
    settings,
    selectionLabel,
    selectionBeats,
    musicContext,
    loraNames,
    statusMessage,
  });

  if (dialogResult.action !== operation || !dialogResult.settings) {
    if (dialogResult.settings) {
      await writeStoredSettings(
        context,
        settingsForStorage(initialSettings, sanitizeSettings(dialogResult.settings), operation),
      );
    }
    return;
  }

  settings = sanitizeSettings(dialogResult.settings);
  if (operation === "continue" && settings.continueBeats <= 0) {
    settings = {
      ...settings,
      continueBeats: clamp(selectionBeats, 0.25, 1024),
    };
  }
  await writeStoredSettings(context, settingsForStorage(initialSettings, settings, operation));

  const title = operation === "generate"
    ? "SA3 Generate"
    : operation === "continue"
      ? "SA3 Continue"
      : "SA3 Transform";
  const submitLabel = operation === "generate"
    ? "submitting generation to SA3"
    : operation === "continue"
      ? "submitting continuation to SA3"
      : "submitting to SA3";

  await context.ui.withinProgressDialog(title, { progress: 0 }, async (update, signal) => {
    for (let i = 0; i < tracks.length; i++) {
      signal.throwIfAborted();
      const track = tracks[i]!;
      const prefix = tracks.length === 1 ? "" : `${i + 1}/${tracks.length}: `;

      let sourceWavPath = "";
      if (operation !== "generate") {
        await update(`${prefix}rendering ${track.name}`, (i / tracks.length) * 100);
        console.log(`[gary-sa3] rendering ${operation} source: track="${track.name}" beats=${startBeat}-${endBeat}`);
        sourceWavPath = await context.resources.renderPreFxAudio(track, startBeat, endBeat);
        const sourceInfo = await fs.stat(sourceWavPath);
        console.log(`[gary-sa3] rendered source wav: ${sourceWavPath} (${sourceInfo.size} bytes)`);
        signal.throwIfAborted();
      }

      await update(`${prefix}${submitLabel}`, ((i + 0.15) / tracks.length) * 100);
      const transformed = operation === "generate"
        ? await submitAndDownloadGenerate(
          context,
          settings,
          musicContext,
          beatsToSeconds(selectionBeats, musicContext.tempo),
          (text, progress) => update(`${prefix}${text}`, ((i + progress) / tracks.length) * 100),
          signal,
        )
        : operation === "continue"
        ? await submitAndDownloadContinue(
          context,
          settings,
          sourceWavPath,
          musicContext,
          beatsToSeconds(selectionBeats, musicContext.tempo),
          beatsToSeconds(settings.continueBeats, musicContext.tempo),
          (text, progress) => update(`${prefix}${text}`, ((i + progress) / tracks.length) * 100),
          signal,
        )
        : await submitAndDownloadTransform(
          context,
          settings,
          sourceWavPath,
          musicContext,
          beatsToSeconds(selectionBeats, musicContext.tempo),
          (text, progress) => update(`${prefix}${text}`, ((i + progress) / tracks.length) * 100),
          signal,
        );
      signal.throwIfAborted();

      await update(`${prefix}importing result`, ((i + 0.9) / tracks.length) * 100);
      const importedPath = await context.resources.importIntoProject(transformed.filePath);
      if (transformed.seed) {
        const numericSeed = Number(transformed.seed);
        settings = {
          ...settings,
          seed: Number.isFinite(numericSeed) ? Math.trunc(numericSeed) : -1,
          lastSeed: transformed.seed,
        };
      }

      const outputDurationBeats = operation === "continue"
        ? selectionBeats + settings.continueBeats
        : selectionBeats;
      const clipStartBeat = operation === "generate" || operation === "continue" || settings.replaceSelection
        ? startBeat
        : findNonOverlappingStart(track, endBeat, outputDurationBeats);

      if (operation === "generate" || operation === "continue") {
        await track.clearClipsInRange(startBeat, startBeat + outputDurationBeats);
      } else if (settings.replaceSelection) {
        await track.clearClipsInRange(startBeat, endBeat);
      }

      const clip = await track.createAudioClip({
        filePath: importedPath,
        startTime: clipStartBeat,
        duration: outputDurationBeats,
        isWarped: false,
      });
      clip.name = makeClipName(settings.prompt, track.name, operation);
    }

    await update("done", 100);
  });

  await writeStoredSettings(context, settingsForStorage(initialSettings, settings, operation));
}

async function runTransformDialog(
  context: Context,
  initial: {
    operation: SelectionOperation;
    settings: TransformSettings;
    selectionLabel: string;
    selectionBeats: number;
    musicContext: MusicContext;
    loraNames: string[];
    statusMessage: string;
  },
): Promise<DialogResult> {
  let settings = initial.settings;
  let loraNames = initial.loraNames;
  let statusMessage = initial.statusMessage;

  while (true) {
    const result = await showTransformDialog(context, {
      ...settings,
      operation: initial.operation,
      selectionLabel: initial.selectionLabel,
      selectionBeats: initial.selectionBeats,
      beatsPerBar: initial.musicContext.beatsPerBar,
      tempoLabel: `${Math.round(initial.musicContext.tempo)} bpm`,
      keyScaleLabel: initial.musicContext.keyScale || "scale off",
      localBackendUrl: DEFAULT_LOCAL_SA3_URL,
      availableLoras: mergeLoraNames(loraNames, settings.loras.map((lora) => lora.name)),
      statusMessage,
    });

    if (
      result.action === "cancel" ||
      result.action === "transform" ||
      result.action === "continue" ||
      result.action === "generate"
    ) {
      return result;
    }

    if (result.settings) {
      settings = sanitizeSettings(result.settings);
      await writeStoredSettings(
        context,
        settingsForStorage(initial.settings, settings, initial.operation),
      );
    }

    if (result.action === "refresh-loras") {
      loraNames = await fetchAvailableLoras(settings.backendUrl);
      statusMessage = loraStatusMessage(loraNames);
      await writeStoredSettings(
        context,
        settingsForStorage(initial.settings, settings, initial.operation),
      );
      continue;
    }

    if (result.action === "dice") {
      try {
        const dice = await fetchDicePrompt(
          settings.backendUrl,
          settings.loras.map((lora) => lora.name),
        );
        settings = {
          ...settings,
          prompt: dice.prompt,
        };
        await writeStoredSettings(
          context,
          settingsForStorage(initial.settings, settings, initial.operation),
        );
        statusMessage = dice.missingLoras.length > 0
          ? `rolled prompt; missing ${dice.missingLoras.length} lora pool${dice.missingLoras.length === 1 ? "" : "s"}`
          : settings.loras.length > 0
            ? "rolled lora prompt"
            : "rolled prompt";
      } catch (error) {
        statusMessage = error instanceof Error ? error.message : "failed to roll prompt";
      }
    }
  }
}

async function showTransformDialog(
  context: Context,
  initial: DialogInitial,
): Promise<DialogResult> {
  const html = transformDialog.replace(
    "__INITIAL_JSON__",
    JSON.stringify(initial).replaceAll("</", "<\\/"),
  );
  let storedSettings = sanitizeSettings(initial);
  const server = await startDialogServer(html, {
    onSettings: async (settings) => {
      storedSettings = settingsForStorage(storedSettings, sanitizeSettings(settings), initial.operation);
      await writeStoredSettings(context, storedSettings);
    },
  });

  try {
    const result = await context.ui.showModalDialog(server.url, 620, 500);
    const dialogResult = JSON.parse(result) as DialogResult;
    if (dialogResult.settings) {
      storedSettings = settingsForStorage(storedSettings, sanitizeSettings(dialogResult.settings), initial.operation);
      await writeStoredSettings(context, storedSettings);
    }
    return dialogResult;
  } finally {
    await server.close();
  }
}

async function submitAndDownloadTransform(
  context: Context,
  settings: TransformSettings,
  sourceWavPath: string,
  musicContext: MusicContext,
  durationSeconds: number,
  update: (text: string, progress: number) => Promise<void>,
  signal: AbortSignal,
): Promise<TransformResult> {
  const prompt = composePrompt(settings.prompt, musicContext);
  const baseUrl = normalizeBaseUrl(settings.backendUrl);

  let sessionId: string;
  const useInitPath = await shouldPreferSa3CppInitPath(baseUrl, signal);
  if (useInitPath) {
    console.log("[gary-sa3] sa3.cpp backend detected; submitting transform via /generate init_path");
    const submitResponse = await fetchJson(`${baseUrl}/generate`, {
      ...sa3CppRequest(settings, prompt, durationSeconds),
      init_path: sourceWavPath,
      init_noise_level: settings.strength,
    }, signal);
    sessionId = sessionIdFromSubmit(submitResponse, "SA3 sa3.cpp transform submit failed");
  } else {
    const sourceBytes = await fs.readFile(sourceWavPath);
    const audioData = sourceBytes.toString("base64");
    try {
      const submitResponse = await fetchJson(`${baseUrl}/transform`, {
        ...legacySa3Request(settings, prompt),
        audio_data: audioData,
        strength: settings.strength,
      }, signal);
      sessionId = sessionIdFromSubmit(submitResponse, "SA3 transform submit failed");
    } catch (error) {
      if (!shouldFallbackToSa3Cpp(error)) {
        throw error;
      }

      console.log("[gary-sa3] /transform unavailable; falling back to sa3.cpp /generate init_path");
      const submitResponse = await fetchJson(`${baseUrl}/generate`, {
        ...sa3CppRequest(settings, prompt, durationSeconds),
        init_path: sourceWavPath,
        init_noise_level: settings.strength,
      }, signal);
      sessionId = sessionIdFromSubmit(submitResponse, "SA3 sa3.cpp transform submit failed");
    }
  }

  const status = await pollForCompletion(baseUrl, sessionId, update, signal, "SA3 transform");
  if (!status.audio_data) {
    throw new Error("SA3 completed without audio_data.");
  }

  const tempDirectory = context.environment.tempDirectory ?? path.dirname(sourceWavPath);
  const outputPath = path.join(tempDirectory, `gary-sa3-transform-${randomUUID()}.wav`);
  await fs.writeFile(outputPath, Buffer.from(status.audio_data, "base64"));

  const seed = status.meta?.seed;
  if (seed !== undefined) {
    console.log(`[gary-sa3] transform seed ${seed}`);
  }

  return seed === undefined
    ? { filePath: outputPath }
    : { filePath: outputPath, seed: String(seed) };
}

async function submitAndDownloadGenerate(
  context: Context,
  settings: TransformSettings,
  musicContext: MusicContext,
  durationSeconds: number,
  update: (text: string, progress: number) => Promise<void>,
  signal: AbortSignal,
): Promise<TransformResult> {
  if (durationSeconds <= 0) {
    throw new Error("SA3 generate needs a positive selection duration.");
  }

  const prompt = composePrompt(settings.prompt, musicContext);
  const baseUrl = normalizeBaseUrl(settings.backendUrl);

  const submitResponse = await fetchJson(`${baseUrl}/generate`, {
    ...legacySa3Request(settings, prompt),
    duration: Number(durationSeconds.toFixed(3)),
    ...sa3CppRequest(settings, prompt, durationSeconds),
  }, signal);

  const sessionId = sessionIdFromSubmit(submitResponse, "SA3 generate submit failed");

  const status = await pollForCompletion(baseUrl, sessionId, update, signal, "SA3 generate");
  if (!status.audio_data) {
    throw new Error("SA3 completed without audio_data.");
  }

  const tempDirectory = context.environment.tempDirectory;
  if (!tempDirectory) {
    throw new Error("Extension temp directory is unavailable.");
  }

  const outputPath = path.join(tempDirectory, `gary-sa3-generate-${randomUUID()}.wav`);
  await fs.writeFile(outputPath, Buffer.from(status.audio_data, "base64"));

  const seed = status.meta?.seed;
  if (seed !== undefined) {
    console.log(`[gary-sa3] generate seed ${seed}`);
  }

  return seed === undefined
    ? { filePath: outputPath }
    : { filePath: outputPath, seed: String(seed) };
}

async function submitAndDownloadContinue(
  context: Context,
  settings: TransformSettings,
  sourceWavPath: string,
  musicContext: MusicContext,
  sourceDurationSeconds: number,
  continuationSeconds: number,
  update: (text: string, progress: number) => Promise<void>,
  signal: AbortSignal,
): Promise<TransformResult> {
  if (continuationSeconds <= 0) {
    throw new Error("SA3 continue needs a positive continuation length.");
  }

  const prompt = composePrompt(settings.prompt, musicContext);
  const baseUrl = normalizeBaseUrl(settings.backendUrl);
  const totalDurationSeconds = sourceDurationSeconds + continuationSeconds;

  let sessionId: string;
  const useInitPath = await shouldPreferSa3CppInitPath(baseUrl, signal);
  if (useInitPath) {
    console.log("[gary-sa3] sa3.cpp backend detected; submitting continue via /generate init_path");
    const submitResponse = await fetchJson(`${baseUrl}/generate`, {
      ...sa3CppRequest(settings, prompt, totalDurationSeconds),
      init_path: sourceWavPath,
      inpaint_start: Number(sourceDurationSeconds.toFixed(3)),
      inpaint_end: Number(totalDurationSeconds.toFixed(3)),
    }, signal);
    sessionId = sessionIdFromSubmit(submitResponse, "SA3 sa3.cpp continue submit failed");
  } else {
    const sourceBytes = await fs.readFile(sourceWavPath);
    const audioData = sourceBytes.toString("base64");
    try {
      const submitResponse = await fetchJson(`${baseUrl}/continue`, {
        ...legacySa3Request(settings, prompt),
        audio_data: audioData,
        continuation_seconds: Number(continuationSeconds.toFixed(3)),
        continuation_mode: "inpaint",
      }, signal);
      sessionId = sessionIdFromSubmit(submitResponse, "SA3 continue submit failed");
    } catch (error) {
      if (!shouldFallbackToSa3Cpp(error)) {
        throw error;
      }

      console.log("[gary-sa3] /continue unavailable; falling back to sa3.cpp /generate inpaint");
      const submitResponse = await fetchJson(`${baseUrl}/generate`, {
        ...sa3CppRequest(settings, prompt, totalDurationSeconds),
        init_path: sourceWavPath,
        inpaint_start: Number(sourceDurationSeconds.toFixed(3)),
        inpaint_end: Number(totalDurationSeconds.toFixed(3)),
      }, signal);
      sessionId = sessionIdFromSubmit(submitResponse, "SA3 sa3.cpp continue submit failed");
    }
  }

  const status = await pollForCompletion(baseUrl, sessionId, update, signal, "SA3 continue");
  if (!status.audio_data) {
    throw new Error("SA3 completed without audio_data.");
  }

  const tempDirectory = context.environment.tempDirectory ?? path.dirname(sourceWavPath);
  const outputPath = path.join(tempDirectory, `gary-sa3-continue-${randomUUID()}.wav`);
  await fs.writeFile(outputPath, Buffer.from(status.audio_data, "base64"));

  const seed = status.meta?.seed;
  if (seed !== undefined) {
    console.log(`[gary-sa3] continue seed ${seed}`);
  }

  return seed === undefined
    ? { filePath: outputPath }
    : { filePath: outputPath, seed: String(seed) };
}

function legacySa3Request(settings: TransformSettings, prompt: string): Record<string, unknown> {
  return {
    prompt,
    steps: settings.steps,
    cfg_scale: settings.cfgScale,
    shift: settings.shift,
    seed: settings.useSeed ? settings.seed : -1,
    loras: settings.loras.map((lora) => ({
      name: lora.name,
      strength: lora.strength,
      interval_min: 0.0,
      interval_max: 1.0,
    })),
    ...(settings.negativePrompt ? { negative_prompt: settings.negativePrompt } : {}),
  };
}

function sa3CppRequest(
  settings: TransformSettings,
  prompt: string,
  durationSeconds: number,
): Record<string, unknown> {
  return {
    prompt,
    seconds: Number(durationSeconds.toFixed(3)),
    steps: settings.steps,
    cfg_scale: settings.cfgScale,
    dist_shift: sa3CppDistShift(settings.shift),
    seed: settings.useSeed ? settings.seed : -1,
    keep_models: false,
    encode_chunk_size: 128,
    encode_overlap: 32,
    decode_chunk_size: 128,
    decode_overlap: 32,
    loras: settings.loras.map((lora) => ({
      name: lora.name,
      strength: lora.strength,
    })),
    ...(settings.negativePrompt ? { negative_prompt: settings.negativePrompt } : {}),
  };
}

function sa3CppDistShift(shift: string): string {
  switch (shift.toLowerCase()) {
    case "none":
      return "None";
    case "flux":
      return "Flux";
    case "full":
      return "Full";
    case "default":
    case "logsnr":
    default:
      return "LogSNR";
  }
}

function sessionIdFromSubmit(response: unknown, fallback: string): string {
  const record = asRecord(response);
  if (record?.success === false) {
    throw new Error(errorFromResponse(response, fallback));
  }

  const sessionId = typeof record?.session_id === "string" ? record.session_id.trim() : "";
  if (!sessionId) {
    throw new Error(errorFromResponse(response, fallback));
  }

  return sessionId;
}

function shouldFallbackToSa3Cpp(error: unknown): boolean {
  return error instanceof BackendHttpError && (error.status === 404 || error.status === 405);
}

async function shouldPreferSa3CppInitPath(baseUrl: string, signal: AbortSignal): Promise<boolean> {
  try {
    const health = await fetchJson<unknown>(`${baseUrl}/health`, undefined, signal);
    const record = asRecord(health);
    const status = String(record?.status ?? "").toLowerCase();
    const isSa3Cpp = status === "ok" && typeof record?.encoding === "string" && typeof record?.loaded === "boolean";
    console.log(`[gary-sa3] backend flavor ${isSa3Cpp ? "sa3.cpp" : "legacy"} (${baseUrl})`);
    return isSa3Cpp;
  } catch (error) {
    console.warn("[gary-sa3] backend flavor check failed; using legacy submit route", error);
    return false;
  }
}

async function pollForCompletion(
  baseUrl: string,
  sessionId: string,
  update: (text: string, progress: number) => Promise<void>,
  signal: AbortSignal,
  operationLabel: string,
): Promise<PollStatus> {
  const startedAt = Date.now();
  const timeoutMs = 20 * 60 * 1000;

  while (Date.now() - startedAt < timeoutMs) {
    signal.throwIfAborted();
    await delay(1500, signal);

    const status = await fetchJson<PollStatus>(
      `${baseUrl}/poll_status/${encodeURIComponent(sessionId)}?consume=1`,
      undefined,
      signal,
    );

    if (status.status === "completed") {
      await update("SA3 completed", 0.85);
      return status;
    }

    if (status.status === "failed" || status.success === false) {
      throw new Error(errorFromResponse(status, `${operationLabel} failed`));
    }

    const progress = typeof status.progress === "number"
      ? Math.max(0.2, Math.min(0.85, status.progress / 100))
      : 0.35;
    await update(status.status ? `SA3 ${status.status}` : "SA3 working", progress);
  }

  throw new Error(`${operationLabel} timed out.`);
}

async function fetchJson<T = Record<string, unknown>>(
  url: string,
  body: Record<string, unknown> | undefined,
  signal: AbortSignal,
): Promise<T> {
  const init: RequestInit = {
    method: body ? "POST" : "GET",
    signal,
  };

  if (body) {
    init.headers = { "Content-Type": "application/json" };
    init.body = JSON.stringify(body);
  }

  const response = await fetch(url, init);

  const text = await response.text();
  let json: unknown = {};
  if (text.trim()) {
    try {
      json = JSON.parse(text);
    } catch {
      json = { message: text.trim() };
    }
  }

  if (!response.ok) {
    throw new BackendHttpError(response.status, json, `HTTP ${response.status}`);
  }

  return json as T;
}

async function startDialogServer(
  html: string,
  options: {
    onSettings?: (settings: TransformSettings) => Promise<void>;
  } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    void handleDialogRequest(html, options, request, response).catch((error) => {
      sendJson(response, 500, {
        success: false,
        error: error instanceof Error ? error.message : "dialog bridge failed",
      });
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "localhost", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address() as AddressInfo;
  return {
    url: `http://localhost:${address.port}/dialog`,
    close: () => new Promise((resolve, reject) => {
      server.close((error) => {
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      });
    }),
  };
}

async function handleDialogRequest(
  html: string,
  options: {
    onSettings?: (settings: TransformSettings) => Promise<void>;
  },
  request: http.IncomingMessage,
  response: http.ServerResponse,
) {
  const route = parseRequestUrl(request.url ?? "/");

  if (route.path === "/api/settings" && request.method === "POST") {
    if (!options.onSettings) {
      sendJson(response, 501, { success: false, error: "settings persistence unavailable" });
      return;
    }

    const payload = await readJsonBody(request);
    const settings = sanitizeSettings({
      ...defaultSettings,
      ...asRecord(payload),
    } as TransformSettings);
    await options.onSettings(settings);
    sendJson(response, 200, { success: true });
    return;
  }

  if (request.method !== "GET") {
    sendJson(response, 405, { success: false, error: "method not allowed" });
    return;
  }

  if (route.path === "/" || route.path === "/dialog") {
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
    });
    response.end(html);
    return;
  }

  if (route.path === "/api/prompts") {
    const backendUrl = route.query.backendUrl || DEFAULT_LOCAL_SA3_URL;
    const loras = route.query.lora
      ? route.query.lora.split(",").map((name) => name.trim()).filter(Boolean)
      : [];
    const dice = await fetchDicePrompt(backendUrl, loras);
    sendJson(response, 200, { success: true, ...dice });
    return;
  }

  if (route.path === "/api/loras") {
    const backendUrl = route.query.backendUrl || DEFAULT_LOCAL_SA3_URL;
    const loras = await fetchAvailableLoras(backendUrl);
    sendJson(response, 200, {
      success: true,
      loras,
      statusMessage: loraStatusMessage(loras),
    });
    return;
  }

  if (route.path === "/api/health") {
    const backendUrl = route.query.backendUrl || DEFAULT_LOCAL_SA3_URL;
    const health = await checkBackendHealth(backendUrl);
    sendJson(response, 200, { success: true, ...health });
    return;
  }

  sendJson(response, 404, { success: false, error: "not found" });
}

function sendJson(response: http.ServerResponse, status: number, body: unknown) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  const text = Buffer.concat(chunks).toString("utf8").trim();
  return text ? JSON.parse(text) : {};
}

async function fetchJsonWithTimeout<T = unknown>(url: string, timeoutMs: number): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error("request timed out")), timeoutMs);

  try {
    return await fetchJson<T>(url, undefined, controller.signal);
  } finally {
    clearTimeout(timeout);
  }
}

async function checkBackendHealth(backendUrl: string): Promise<BackendHealth> {
  try {
    const response = await fetchJsonWithTimeout<unknown>(`${normalizeBaseUrl(backendUrl)}/health`, 2500);
    if (healthResponseLooksOnline(response)) {
      return { online: true, status: healthStatusLabel(response) };
    }

    return { online: false, status: healthStatusLabel(response) };
  } catch (error) {
    console.warn("[gary-sa3] health check failed", error);
    return { online: false, status: "offline" };
  }
}

async function fetchAvailableLoras(backendUrl: string): Promise<string[]> {
  try {
    const response = await fetchJsonWithTimeout<unknown>(`${normalizeBaseUrl(backendUrl)}/loras`, 8000);
    return parseLoraNames(response);
  } catch (error) {
    console.warn("[gary-sa3] lora fetch failed", error);
    return [];
  }
}

async function fetchDicePrompt(
  backendUrl: string,
  activeLoraNames: string[],
): Promise<DicePromptResult> {
  const baseUrl = normalizeBaseUrl(backendUrl);
  const loraQuery = uniqueStrings(activeLoraNames.map((name) => name.trim()).filter(Boolean));
  const url = appendQuery(`${baseUrl}/prompts`, loraQuery.length > 0
    ? { lora: loraQuery.join(",") }
    : {});

  const response = await fetchJsonWithTimeout<unknown>(url, 15000);
  return pickDicePrompt(response);
}

function sanitizeSettings(settings: TransformSettings): TransformSettings {
  const seed = Number.isFinite(Number(settings.seed)) ? Math.trunc(Number(settings.seed)) : -1;
  return {
    backendUrl: normalizeBaseUrl(settings.backendUrl || DEFAULT_LOCAL_SA3_URL),
    prompt: settings.prompt.trim(),
    strength: clamp(Number(settings.strength), 0.01, 1.0),
    steps: Math.round(clamp(Number(settings.steps), 4, 16)),
    cfgScale: clamp(Number(settings.cfgScale), 0.5, 2.0),
    shift: ["full", "default", "none", "logsnr", "flux"].includes(settings.shift)
      ? settings.shift
      : "full",
    negativePrompt: settings.negativePrompt.trim(),
    seed,
    useSeed: Boolean(settings.useSeed && seed >= 0),
    lastSeed: typeof settings.lastSeed === "string" ? settings.lastSeed.trim() : "",
    replaceSelection: Boolean(settings.replaceSelection),
    continueBeats: clamp(Number(settings.continueBeats), 0, 1024),
    loras: sanitizeLoras(settings.loras),
  };
}

function settingsForStorage(
  previous: TransformSettings,
  next: TransformSettings,
  operation: SelectionOperation,
): TransformSettings {
  if (operation === "transform") {
    return next;
  }

  return {
    ...next,
    replaceSelection: previous.replaceSelection,
  };
}

function sanitizeLoras(loras: LoraSelection[] | undefined): LoraSelection[] {
  if (!Array.isArray(loras)) {
    return [];
  }

  const sanitized: LoraSelection[] = [];
  for (const lora of loras) {
    const name = typeof lora?.name === "string" ? lora.name.trim() : "";
    const strength = clamp(Number(lora?.strength), 0, 2);
    if (!name || strength <= 0) {
      continue;
    }

    const existing = sanitized.find((entry) => entry.name === name);
    if (existing) {
      existing.strength = strength;
    } else {
      sanitized.push({ name, strength });
    }
  }

  return sanitized;
}

function parseLoraNames(response: unknown): string[] {
  const record = asRecord(response);
  const loras = Array.isArray(record?.loras) ? record.loras : [];
  const names = loras
    .map((item) => {
      if (typeof item === "string") {
        return item.trim();
      }
      return asRecord(item)?.name?.toString().trim() ?? "";
    })
    .filter(Boolean);

  return uniqueStrings(names);
}

function healthResponseLooksOnline(response: unknown): boolean {
  const record = asRecord(response);
  if (!record) {
    return response !== undefined && response !== null;
  }

  const status = String(record.status ?? "").trim().toLowerCase();
  if (!status) {
    return true;
  }

  return !["unhealthy", "failed", "down", "error", "offline"].includes(status);
}

function healthStatusLabel(response: unknown): string {
  const record = asRecord(response);
  if (!record) {
    return "online";
  }

  const status = String(record.status ?? "").trim();
  return status || "online";
}

function pickDicePrompt(response: unknown): DicePromptResult {
  const responseRecord = asRecord(response);
  if (!responseRecord) {
    throw new Error("invalid sa3 prompt response");
  }

  if (responseRecord.success === false) {
    throw new Error(errorFromResponse(response, "sa3 prompt request failed"));
  }

  const missingLoras = Array.isArray(responseRecord.missing_loras)
    ? uniqueStrings(responseRecord.missing_loras.map((item) => String(item).trim()).filter(Boolean))
    : [];

  const promptsRecord = asRecord(responseRecord.prompts);
  const diceRecord = asRecord(promptsRecord?.dice);
  if (!diceRecord) {
    throw new Error("sa3 prompt response missing dice pool");
  }

  const promptPool: string[] = [];
  const preferredBuckets = ["generic", "instrumental", "drums"];
  for (const bucket of preferredBuckets) {
    addDiceBucketPrompts(diceRecord, bucket, promptPool);
  }

  for (const bucket of Object.keys(diceRecord)) {
    if (!preferredBuckets.includes(bucket)) {
      addDiceBucketPrompts(diceRecord, bucket, promptPool);
    }
  }

  const uniquePool = uniqueStrings(promptPool);
  if (uniquePool.length === 0) {
    throw new Error("sa3 dice returned no prompts");
  }

  return {
    prompt: uniquePool[Math.floor(Math.random() * uniquePool.length)]!,
    missingLoras,
  };
}

function addDiceBucketPrompts(
  diceRecord: Record<string, unknown>,
  bucketName: string,
  promptPool: string[],
) {
  const bucket = diceRecord[bucketName];
  if (!Array.isArray(bucket)) {
    return;
  }

  for (const item of bucket) {
    const prompt = String(item).trim();
    if (prompt) {
      promptPool.push(prompt);
    }
  }
}

async function readStoredSettings(context: Context): Promise<Partial<TransformSettings>> {
  const filePath = settingsFilePath(context);
  if (!filePath) {
    return inMemorySettings ?? {};
  }

  try {
    const settings = JSON.parse(await fs.readFile(filePath, "utf8")) as Partial<TransformSettings>;
    inMemorySettings = sanitizeSettings({
      ...defaultSettings,
      ...settings,
    });
    return settings;
  } catch {
    return inMemorySettings ?? {};
  }
}

async function writeStoredSettings(context: Context, settings: TransformSettings) {
  inMemorySettings = sanitizeSettings(settings);
  const filePath = settingsFilePath(context);
  if (!filePath) {
    return;
  }

  try {
    await fs.mkdir(path.dirname(filePath), { recursive: true });
    await fs.writeFile(filePath, JSON.stringify(inMemorySettings, null, 2));
  } catch (error) {
    if (!warnedSettingsWriteFailure) {
      warnedSettingsWriteFailure = true;
      console.warn("[gary-sa3] settings write failed; falling back to in-memory dialog state", error);
    }
  }
}

function settingsFilePath(context: Context): string | undefined {
  if (!context.environment.storageDirectory) {
    if (!warnedMissingStorageDirectory) {
      warnedMissingStorageDirectory = true;
      console.warn("[gary-sa3] settings storage unavailable; falling back to in-memory dialog state");
    }
    return undefined;
  }

  return path.join(context.environment.storageDirectory, "gary-sa3-transform.json");
}

function getMusicContext(context: Context): MusicContext {
  const song = context.application.song;
  const tempo = song.tempo || 120;
  const keyScale = song.scaleMode ? formatKeyScale(song.rootNote, song.scaleName) : "";

  return {
    tempo,
    beatsPerBar: 4,
    keyScale,
  };
}

function formatKeyScale(rootNote: number, scaleName: string): string {
  const noteNames = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];
  const noteName = noteNames[((Math.round(rootNote) % 12) + 12) % 12] ?? "";
  const scale = scaleName.trim();
  return noteName && scale ? `${noteName} ${scale}` : "";
}

function composePrompt(prompt: string, musicContext: MusicContext): string {
  const parts = [prompt.trim(), `${Math.round(musicContext.tempo || 120)} bpm`, musicContext.keyScale.trim()]
    .filter(Boolean);
  return parts.join(", ");
}

function beatsToSeconds(beats: number, tempo: number): number {
  const safeTempo = tempo > 0 ? tempo : 120;
  return (beats * 60) / safeTempo;
}

function formatBeatBarDuration(beats: number, beatsPerBar: number): string {
  const bars = beatsPerBar > 0 ? beats / beatsPerBar : beats / 4;
  const barLabel = Math.abs(bars - 1) < 0.005 ? "bar" : "bars";
  return `${beats.toFixed(2)} beats / ${bars.toFixed(2)} ${barLabel}`;
}

function normalizeBaseUrl(url: string): string {
  return url.trim().replace(/\/+$/, "") || DEFAULT_LOCAL_SA3_URL;
}

function appendQuery(url: string, params: Record<string, string>): string {
  const entries = Object.entries(params).filter(([, value]) => value.trim());
  if (entries.length === 0) {
    return url;
  }

  const query = entries
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
    .join("&");
  return `${url}${url.includes("?") ? "&" : "?"}${query}`;
}

function parseRequestUrl(rawUrl: string): { path: string; query: Record<string, string> } {
  const [pathPart = "/", queryPart = ""] = rawUrl.split("?", 2);
  const query: Record<string, string> = {};

  for (const part of queryPart.split("&")) {
    if (!part) {
      continue;
    }

    const separator = part.indexOf("=");
    const rawKey = separator === -1 ? part : part.slice(0, separator);
    const rawValue = separator === -1 ? "" : part.slice(separator + 1);
    const key = safeDecode(rawKey.replace(/\+/gu, " "));
    if (!key) {
      continue;
    }

    query[key] = safeDecode(rawValue.replace(/\+/gu, " "));
  }

  return { path: pathPart || "/", query };
}

function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

function loraStatusMessage(loraNames: string[]): string {
  if (loraNames.length === 0) {
    return "no loras available";
  }

  return `${loraNames.length} lora${loraNames.length === 1 ? "" : "s"} available`;
}

function mergeLoraNames(...groups: string[][]): string[] {
  return uniqueStrings(groups.flat().map((name) => name.trim()).filter(Boolean));
}

function uniqueStrings(values: string[]): string[] {
  return [...new Set(values)];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" ? value as Record<string, unknown> : undefined;
}

function errorFromResponse(response: unknown, fallback: string): string {
  if (response && typeof response === "object") {
    const record = response as Record<string, unknown>;
    for (const key of ["detail", "error", "message"]) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) {
        return value;
      }
    }
    if (typeof record.error === "string" && record.error.trim()) {
      return record.error;
    }
    if (Array.isArray(record.errors) && record.errors.length > 0) {
      return record.errors.map(String).join(", ");
    }
  }

  return fallback;
}

function makeClipName(prompt: string, trackName: string, operation: SelectionOperation): string {
  const base = prompt.trim() || trackName.trim() || "selection";
  const prefix = operation === "generate"
    ? "SA3 Generate"
    : operation === "continue"
      ? "SA3 Continue"
      : "SA3";
  return `${prefix} ${base}`.slice(0, 64);
}

function findNonOverlappingStart(
  track: AudioTrack<typeof API_VERSION>,
  preferredStartBeat: number,
  durationBeats: number,
): number {
  const clips = [...track.arrangementClips].sort((left, right) => left.startTime - right.startTime);
  let startBeat = preferredStartBeat;
  let moved = true;

  while (moved) {
    moved = false;
    const endBeat = startBeat + durationBeats;

    for (const clip of clips) {
      if (startBeat < clip.endTime && endBeat > clip.startTime) {
        startBeat = clip.endTime;
        moved = true;
        break;
      }
    }
  }

  return startBeat;
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timeout);
      reject(signal.reason ?? new Error("Aborted"));
    }, { once: true });
  });
}
