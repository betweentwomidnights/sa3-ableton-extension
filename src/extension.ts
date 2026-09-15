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
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";

import transformDialog from "./transform-dialog.html";
import {
  availableEmbeddedVariants,
  cancelEmbeddedDecoderLoraDownload,
  cancelEmbeddedModelDownload,
  defaultEmbeddedLorasDir,
  defaultEmbeddedModelsDir,
  embeddedDicePrompts,
  embeddedDownloadStatus,
  embeddedDecoderLoraStatus,
  embeddedEffectiveDirs,
  embeddedModelStatus,
  embeddedSa3Diagnostics,
  listEmbeddedLoras,
  runEmbeddedSa3,
  startEmbeddedDecoderLoraDownload,
  startEmbeddedModelDownload,
  type EmbeddedModelOptions,
  type EmbeddedModelStatus,
  type EmbeddedSa3Request,
} from "./embedded-sa3.js";

const API_VERSION = "1.0.0";
const COMMAND_TRANSFORM_SELECTION = "gary.sa3.transformSelection";
const COMMAND_CONTINUE_SELECTION = "gary.sa3.continueSelection";
const COMMAND_GENERATE_SELECTION = "gary.sa3.generateSelection";
const SA3_CPP_TAIL_PAD_SECONDS = 6.0;
let warnedMissingStorageDirectory = false;
let warnedSettingsWriteFailure = false;
let inMemorySettings: TransformSettings | undefined;

type Context = ExtensionContext<typeof API_VERSION>;
type SelectionOperation = "transform" | "continue" | "generate";

interface TransformSettings {
  embeddedModelsDir: string;
  embeddedLorasDir: string;
  embeddedVariant: string;
  embeddedEncoding: string;
  embeddedDevice: string;
  keepModelsResident: boolean;
  decoderLoraEnabled: boolean;
  generationEndingMode: "ends-here" | "keeps-going";
  continuationEndingMode: "ends-here" | "keeps-going";
  peakNormalize: boolean;
  peakNormalizeDb: number;
  limiter: boolean;
  limiterCeilingDb: number;
  limiterKnee: number;
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
  embeddedModelStatus: EmbeddedModelStatus;
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

interface TransformResult {
  filePath: string;
  seed?: string;
}

const defaultSettings: TransformSettings = {
  embeddedModelsDir: "",
  embeddedLorasDir: "",
  embeddedVariant: "medium",
  embeddedEncoding: "f16",
  embeddedDevice: "auto",
  keepModelsResident: false,
  decoderLoraEnabled: true,
  generationEndingMode: "keeps-going",
  continuationEndingMode: "keeps-going",
  peakNormalize: true,
  peakNormalizeDb: 2.0,
  limiter: true,
  limiterCeilingDb: -0.3,
  limiterKnee: 0.8,
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
      void handleCommandError(context, "transform", error);
    });
  });

  context.commands.registerCommand(COMMAND_CONTINUE_SELECTION, (arg: unknown) => {
    console.log("[gary-sa3] continue command invoked");
    void processSelection(context, arg as ArrangementSelection, "continue").catch((error) => {
      void handleCommandError(context, "continue", error);
    });
  });

  context.commands.registerCommand(COMMAND_GENERATE_SELECTION, (arg: unknown) => {
    console.log("[gary-sa3] generate command invoked");
    void processSelection(context, arg as ArrangementSelection, "generate").catch((error) => {
      void handleCommandError(context, "generate", error);
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
  let settings = settingsWithEmbeddedDefaults(context, sanitizeSettings({
    ...defaultSettings,
    ...storedSettings,
  }));
  const initialSettings = settings;
  if (operation === "continue" && settings.continueBeats <= 0) {
    settings = {
      ...settings,
      continueBeats: clamp(selectionBeats, 0.25, 1024),
    };
  }
  let loraNames = await fetchAvailableLoras(embeddedOptionsFromSettings(settings));
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
        settingsForStorage(initialSettings, settingsWithEmbeddedDefaults(context, sanitizeSettings(dialogResult.settings)), operation),
      );
    }
    return;
  }

  settings = settingsWithEmbeddedDefaults(context, sanitizeSettings(dialogResult.settings));
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

async function handleCommandError(
  context: Context,
  operation: SelectionOperation,
  error: unknown,
) {
  if (isAbortError(error)) {
    console.log(`[gary-sa3] ${operation} cancelled`);
    return;
  }

  console.error(`[gary-sa3] ${operation} failed`, error);
  try {
    await showErrorDialog(context, `SA3 ${capitalize(operation)} Failed`, error);
  } catch (dialogError) {
    console.error("[gary-sa3] failed to show error dialog", dialogError);
  }
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return false;
  }

  const record = error as { name?: unknown; code?: unknown };
  return record.name === "AbortError" || record.code === "ABORT_ERR";
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
      embeddedModelStatus: embeddedModelStatus(embeddedOptionsFromSettings(settings)),
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
      settings = settingsWithEmbeddedDefaults(context, sanitizeSettings(result.settings));
      await writeStoredSettings(
        context,
        settingsForStorage(initial.settings, settings, initial.operation),
      );
    }

    if (result.action === "refresh-loras") {
      loraNames = await fetchAvailableLoras(embeddedOptionsFromSettings(settings));
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
          settings.loras.map((lora) => lora.name),
          embeddedOptionsFromSettings(settings),
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
    const result = await context.ui.showModalDialog(server.url, 680, 560);
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

async function showErrorDialog(context: Context, title: string, error: unknown) {
  const message = errorToMessage(error);
  const details = errorToDetails(error);
  const html = errorDialogHtml(title, message, details);
  const server = await startDialogServer(html);

  try {
    await context.ui.showModalDialog(server.url, 520, details ? 300 : 210);
  } finally {
    await server.close();
  }
}

function errorDialogHtml(title: string, message: string, details: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <script>
    function closeDialog() {
      const message = { method: "close_and_send", params: ["ok"] };
      if (window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.live) {
        window.webkit.messageHandlers.live.postMessage(message);
      } else if (window.chrome && window.chrome.webview) {
        window.chrome.webview.postMessage(message);
      }
    }
    document.addEventListener("DOMContentLoaded", () => {
      document.getElementById("ok").addEventListener("click", closeDialog);
      document.addEventListener("keydown", (event) => {
        if (event.key === "Escape" || event.key === "Enter") closeDialog();
      });
      document.getElementById("ok").focus();
    });
  </script>
  <style>
    *, *::before, *::after { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 16px;
      background: #363636;
      color: #d0d0d0;
      font-family: "AbletonSansSmall", Arial, sans-serif;
      font-size: 11.5px;
    }
    .shell { display: grid; gap: 12px; }
    h1 { margin: 0; font-size: 13px; }
    p { margin: 0; line-height: 1.4; color: #f0b1a6; overflow-wrap: anywhere; }
    pre {
      max-height: 118px;
      margin: 0;
      padding: 8px;
      overflow: auto;
      white-space: pre-wrap;
      background: #202020;
      color: #bdbdbd;
      border: 1px solid #111;
    }
    .buttons { display: flex; justify-content: flex-end; }
    button {
      height: 24px;
      min-width: 62px;
      border: 1px solid #111;
      background: #ffb15f;
      color: #151515;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <div class="shell">
    <h1>${escapeHtml(title)}</h1>
    <p>${escapeHtml(message)}</p>
    ${details ? `<pre>${escapeHtml(details)}</pre>` : ""}
    <div class="buttons"><button id="ok" type="button">OK</button></div>
  </div>
</body>
</html>`;
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
  console.log("[gary-sa3] embedded SA3 transform selected");
  const outputPath = await outputWavPath(context, "transform", path.dirname(sourceWavPath));
  const transformed = await runEmbeddedSa3(
    embeddedSa3Request(settings, prompt, durationSeconds, {
      operation: "transform",
      initPath: sourceWavPath,
      initNoiseLevel: settings.strength,
    }),
    outputPath,
    update,
    signal,
  );
  if (transformed.seed) {
    console.log(`[gary-sa3] embedded transform seed ${transformed.seed}`);
  }
  return transformed;
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
  console.log(
    `[gary-sa3] embedded SA3 generate selected duration=${durationSeconds.toFixed(3)} steps=${settings.steps} loras=${settings.loras.length}`,
  );
  const outputPath = await outputWavPath(context, "generate");
  const generated = await runEmbeddedSa3(
    embeddedSa3Request(settings, prompt, durationSeconds, { operation: "generate" }),
    outputPath,
    update,
    signal,
  );
  if (generated.seed) {
    console.log(`[gary-sa3] embedded generate seed ${generated.seed}`);
  }
  return generated;
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
  const totalDurationSeconds = sourceDurationSeconds + continuationSeconds;
  console.log(
    `[gary-sa3] embedded SA3 continue selected source=${sourceDurationSeconds.toFixed(3)}s add=${continuationSeconds.toFixed(3)}s total=${totalDurationSeconds.toFixed(3)}s`,
  );
  const outputPath = await outputWavPath(context, "continue", path.dirname(sourceWavPath));
  const continued = await runEmbeddedSa3(
    embeddedSa3Request(settings, prompt, continuationSeconds, {
      operation: "continue",
      initPath: sourceWavPath,
    }),
    outputPath,
    update,
    signal,
  );
  if (continued.seed) {
    console.log(`[gary-sa3] embedded continue seed ${continued.seed}`);
  }
  return continued;
}

function embeddedSa3Request(
  settings: TransformSettings,
  prompt: string,
  durationSeconds: number,
  overrides: Partial<EmbeddedSa3Request> & Pick<EmbeddedSa3Request, "operation">,
): EmbeddedSa3Request {
  return {
    operation: overrides.operation,
    ...embeddedOptionsFromSettings(settings),
    device: settings.embeddedDevice,
    prompt,
    negativePrompt: settings.negativePrompt,
    durationSeconds,
    generationTailPaddingSeconds: settings.generationEndingMode === "ends-here" ? 0 : SA3_CPP_TAIL_PAD_SECONDS,
    continuationTailPaddingSeconds: settings.continuationEndingMode === "ends-here" ? 0 : SA3_CPP_TAIL_PAD_SECONDS,
    decoderLoraEnabled: settings.decoderLoraEnabled,
    peakNormalize: settings.peakNormalize,
    peakNormalizeDb: settings.peakNormalizeDb,
    limiter: settings.limiter,
    limiterCeilingDb: settings.limiterCeilingDb,
    limiterKnee: settings.limiterKnee,
    steps: settings.steps,
    cfgScale: settings.cfgScale,
    distShift: sa3CppDistShift(settings.shift),
    seed: settings.useSeed ? settings.seed : -1,
    keepModels: settings.keepModelsResident,
    loras: settings.loras.map((lora) => ({
      name: lora.name,
      strength: lora.strength,
    })),
    initPath: overrides.initPath,
    initNoiseLevel: overrides.initNoiseLevel,
    encodeChunkSize: 128,
    encodeOverlap: 32,
    decodeChunkSize: 128,
    decodeOverlap: 32,
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

async function outputWavPath(
  context: Context,
  operation: SelectionOperation,
  fallbackDirectory?: string,
): Promise<string> {
  const tempDirectory =
    context.environment.tempDirectory ??
    fallbackDirectory ??
    path.join(os.tmpdir(), "gary-sa3-ableton");
  await fs.mkdir(tempDirectory, { recursive: true });

  return path.join(tempDirectory, `gary-sa3-${operation}-${randomUUID()}.wav`);
}

async function startDialogServer(
  html: string,
  options: {
    onSettings?: (settings: TransformSettings) => Promise<void>;
  } = {},
): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((request, response) => {
    void handleDialogRequest(html, options, request, response).catch((error) => {
      console.error(`[gary-sa3] dialog bridge failed ${request.method || ""} ${request.url || ""}`, error);
      sendJson(response, 500, {
        success: false,
        error: errorToMessage(error),
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

  if (route.path === "/api/embedded/models/download" && request.method === "POST") {
    const payload = asRecord(await readJsonBody(request));
    const status = await startEmbeddedModelDownload(embeddedOptionsFromRecord(payload));
    sendJson(response, 200, { success: true, ...status });
    return;
  }

  if (route.path === "/api/embedded/models/cancel" && request.method === "POST") {
    const status = cancelEmbeddedModelDownload();
    sendJson(response, 200, { success: true, ...status });
    return;
  }

  if (route.path === "/api/embedded/decoder/download" && request.method === "POST") {
    const payload = asRecord(await readJsonBody(request));
    const status = await startEmbeddedDecoderLoraDownload(embeddedOptionsFromRecord(payload));
    sendJson(response, 200, { success: true, ...status });
    return;
  }

  if (route.path === "/api/embedded/decoder/cancel" && request.method === "POST") {
    const payload = asRecord(await readJsonBody(request));
    const status = cancelEmbeddedDecoderLoraDownload(embeddedOptionsFromRecord(payload));
    sendJson(response, 200, { success: true, ...status });
    return;
  }

  if (route.path === "/api/embedded/models/reveal" && request.method === "POST") {
    const payload = asRecord(await readJsonBody(request));
    const directory = embeddedEffectiveDirs(embeddedOptionsFromRecord(payload)).modelsDir;
    await revealDirectory(directory);
    sendJson(response, 200, { success: true, path: directory });
    return;
  }

  if (route.path === "/api/embedded/loras/reveal" && request.method === "POST") {
    const payload = asRecord(await readJsonBody(request));
    const directory = embeddedEffectiveDirs(embeddedOptionsFromRecord(payload)).lorasVariantDir;
    await revealDirectory(directory);
    sendJson(response, 200, { success: true, path: directory });
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
    const loras = route.query.lora
      ? route.query.lora.split(",").map((name) => name.trim()).filter(Boolean)
      : [];
    const dice = await fetchDicePrompt(loras, embeddedOptionsFromRecord(route.query));
    sendJson(response, 200, { success: true, ...dice });
    return;
  }

  if (route.path === "/api/loras") {
    const loras = await fetchAvailableLoras(embeddedOptionsFromRecord(route.query));
    sendJson(response, 200, {
      success: true,
      loras,
      statusMessage: loraStatusMessage(loras),
    });
    return;
  }

  if (route.path === "/api/health") {
    const health = embeddedSa3Diagnostics(embeddedOptionsFromRecord(route.query));
    sendJson(response, 200, { success: true, ...health });
    return;
  }

  if (route.path === "/api/embedded/models/status") {
    const options = embeddedOptionsFromRecord(route.query);
    sendJson(response, 200, {
      success: true,
      ...embeddedModelStatus(options),
      download: embeddedDownloadStatus(options),
      variants: availableEmbeddedVariants(options),
      dirs: embeddedEffectiveDirs(options),
    });
    return;
  }

  if (route.path === "/api/embedded/decoder/status") {
    const options = embeddedOptionsFromRecord(route.query);
    sendJson(response, 200, {
      success: true,
      ...embeddedDecoderLoraStatus(options),
    });
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

async function revealDirectory(directory: string): Promise<void> {
  if (!directory) {
    throw new Error("no directory to reveal");
  }

  await fs.mkdir(directory, { recursive: true });
  const opener = process.platform === "win32"
    ? "explorer.exe"
    : process.platform === "darwin"
      ? "open"
      : "xdg-open";
  // explorer.exe reports a nonzero exit code even on success, so fire and forget.
  execFile(opener, [directory], () => {});
}

async function fetchAvailableLoras(embeddedOptions: EmbeddedModelOptions = {}): Promise<string[]> {
  return listEmbeddedLoras(embeddedOptions);
}

async function fetchDicePrompt(
  activeLoraNames: string[],
  embeddedOptions: EmbeddedModelOptions = {},
): Promise<DicePromptResult> {
  const dice = await embeddedDicePrompts(activeLoraNames, embeddedOptions);
  return pickDicePrompt({
    success: true,
    prompts: dice.prompts,
    missing_loras: dice.missingLoras,
  });
}

function sanitizeSettings(settings: TransformSettings): TransformSettings {
  const seed = Number.isFinite(Number(settings.seed)) ? Math.trunc(Number(settings.seed)) : -1;
  return {
    embeddedModelsDir: typeof settings.embeddedModelsDir === "string" ? settings.embeddedModelsDir.trim() : "",
    embeddedLorasDir: typeof settings.embeddedLorasDir === "string" ? settings.embeddedLorasDir.trim() : "",
    embeddedVariant: ["medium", "small-music", "small-sfx"].includes(settings.embeddedVariant)
      ? settings.embeddedVariant
      : "medium",
    embeddedEncoding: String(settings.embeddedEncoding || "").trim().toLowerCase() === "f32" ? "f32" : "f16",
    embeddedDevice: String(settings.embeddedDevice || "").trim().toLowerCase() === "cpu" ? "cpu" : "auto",
    keepModelsResident: Boolean(settings.keepModelsResident),
    decoderLoraEnabled: settings.decoderLoraEnabled !== false,
    generationEndingMode: settings.generationEndingMode === "ends-here" ? "ends-here" : "keeps-going",
    continuationEndingMode: settings.continuationEndingMode === "ends-here" ? "ends-here" : "keeps-going",
    peakNormalize: settings.peakNormalize !== false,
    peakNormalizeDb: clamp(Number(settings.peakNormalizeDb), -6, 6),
    limiter: settings.limiter !== false,
    limiterCeilingDb: clamp(Number(settings.limiterCeilingDb), -6, 0),
    limiterKnee: clamp(Number(settings.limiterKnee), 0.1, 1),
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

function settingsWithEmbeddedDefaults(context: Context, settings: TransformSettings): TransformSettings {
  return sanitizeSettings({
    ...settings,
    embeddedModelsDir: settings.embeddedModelsDir || defaultEmbeddedModelsDir(context.environment.storageDirectory),
    embeddedLorasDir: settings.embeddedLorasDir || defaultEmbeddedLorasDir(context.environment.storageDirectory),
  });
}

function embeddedOptionsFromSettings(settings: TransformSettings): EmbeddedModelOptions {
  return {
    modelsDir: settings.embeddedModelsDir,
    adaptersDir: settings.embeddedLorasDir,
    variant: settings.embeddedVariant,
    encoding: settings.embeddedEncoding,
  };
}

function embeddedOptionsFromRecord(record: Record<string, unknown> | undefined): EmbeddedModelOptions {
  return {
    modelsDir: stringField(record, "modelsDir") || stringField(record, "embeddedModelsDir"),
    adaptersDir: stringField(record, "adaptersDir") || stringField(record, "embeddedLorasDir"),
    variant: stringField(record, "variant") || stringField(record, "embeddedVariant"),
    encoding: stringField(record, "encoding") || stringField(record, "embeddedEncoding"),
  };
}

function stringField(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key];
  return typeof value === "string" ? value.trim() : undefined;
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

function errorToMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }

  return String(error || "Unknown error");
}

function errorToDetails(error: unknown): string {
  if (error instanceof Error && error.stack) {
    return error.stack;
  }

  return "";
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function capitalize(value: string): string {
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
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
