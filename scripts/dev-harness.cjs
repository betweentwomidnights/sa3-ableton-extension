// Runs the built extension (dist/extension.js) against a stand-in for Live's extension host, so the
// dialog and real renders can be tried in a browser without Live:
//
//   npm run build
//   GARY_HARNESS_STORAGE=<folder> node scripts/dev-harness.cjs
//   curl -X POST localhost:47811/__run -d '{"operation":"generate","beats":32}'
//
// then open http://localhost:47811/ for the dialog. GET /__state reports what the extension asked
// Live to do. Everything Live itself does here is faked: its dialog windows, rendering a track's audio
// and placing clips. Test those in Live. GARY_HARNESS_SOURCE is the WAV Transform and Continue get.
// POST /__dismiss closes the dialog the way its window's X does.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");

const port = Number(process.env.GARY_HARNESS_PORT) || 47811;
const tempo = Number(process.env.GARY_HARNESS_TEMPO) || 120;
const storageDirectory = process.env.GARY_HARNESS_STORAGE;
if (!storageDirectory) {
  throw new Error("set GARY_HARNESS_STORAGE to a folder the harness may write into");
}
const tempDirectory = path.join(storageDirectory, "_temp");
const projectDirectory = path.join(storageDirectory, "_project");
fs.mkdirSync(tempDirectory, { recursive: true });
fs.mkdirSync(projectDirectory, { recursive: true });

const state = { dialog: null, running: false, progress: [], clips: [], cleared: [], error: "", closed: [] };
let closeDialog = null;
let cancelProgress = null;

const KINDS = { 1n: "Application", 2n: "Song", 3n: "AudioTrack" };
const ANCESTORS = { AudioTrack: ["Track"], AudioClip: ["Clip"] };
let nextHandle = 100n;

function handleOf(id) {
  return { id };
}

const dataModel = new Proxy({
  withinTransaction: (fn) => fn(),
  getRoot: () => handleOf(1n),
  rootGetSong: () => handleOf(2n),
  getObjectIsOfClass: (handle, className) => {
    const kind = KINDS[handle.id];
    return kind === className || (ANCESTORS[kind] || []).includes(className);
  },
  songGetTempo: () => tempo,
  songGetRootNote: () => 9n,
  songGetScaleName: () => "Minor",
  songGetScaleMode: () => process.env.GARY_HARNESS_SCALE !== "off",
  trackGetName: () => "Audio 1",
  trackGetArrangementClips: () => [],
  trackClearClipsInRange: (_handle, startTime, endTime, onResult) => {
    state.cleared.push([startTime, endTime]);
    onResult();
  },
  trackCreateAudioClip: (_handle, args, onResult) => {
    const handle = handleOf(nextHandle++);
    KINDS[handle.id] = "AudioClip";
    state.clips.push({ ...args, handle: String(handle.id) });
    onResult(handle);
  },
  clipSetName: (handle, name) => {
    const clip = state.clips.find((item) => item.handle === String(handle.id));
    if (clip) clip.name = name;
  },
}, {
  get(target, key) {
    if (key in target) return target[key];
    return () => {
      throw new Error(`the harness has no ${String(key)}`);
    };
  },
});

const commands = new Map();

const hostApi = {
  commands: {
    registerCommand: (id, callback) => commands.set(id, callback),
    executeCommand: (id, ...args) => commands.get(id)(...args),
  },
  dataModel,
  environment: { storageDirectory, tempDirectory, language: "EN" },
  resources: {
    renderPreFxAudio: (_handle, _range, onResult, onError) => {
      const source = process.env.GARY_HARNESS_SOURCE;
      if (!source) {
        onError();
        return;
      }
      const copy = path.join(tempDirectory, `harness-source-${Date.now()}.wav`);
      fs.copyFileSync(source, copy);
      onResult(copy);
    },
    importIntoProject: (filePath, onResult) => {
      const copy = path.join(projectDirectory, path.basename(filePath));
      fs.copyFileSync(filePath, copy);
      onResult(copy);
    },
  },
  ui: {
    registerContextMenuAction: (_scope, _title, _commandId, done) => done((finished) => finished()),
    showModalDialog: (url, width, height, onResult) => {
      state.dialog = { url, width, height };
      closeDialog = (content) => {
        state.dialog = null;
        state.closed.push(content ? JSON.parse(content).action ?? content : "(window closed)");
        onResult(content);
      };
    },
    showProgressDialog: (options, onShow, onCancelled) => {
      state.progress.push(options.text);
      cancelProgress = onCancelled;
      onShow({
        update: (next, done) => {
          state.progress.push(`${Math.round(next.progress ?? 0)}% ${next.text}`);
          done?.();
        },
        close: (done) => {
          cancelProgress = null;
          done?.();
        },
      });
    },
  },
};

// The bundle is CommonJS, but package.json says "type": "module", so require() would refuse it.
const Module = require("node:module");
const extensionPath = path.join(__dirname, "..", "dist", "extension.js");
const extensionModule = new Module(extensionPath);
extensionModule.filename = extensionPath;
extensionModule.paths = Module._nodeModulePaths(path.dirname(extensionPath));
extensionModule._compile(fs.readFileSync(extensionPath, "utf8"), extensionPath);
extensionModule.exports.activate({ hostApiVersion: "1.0.0", initializeExtensionHost: () => hostApi });

const OPERATIONS = {
  generate: "gary.sa3.generateSelection",
  transform: "gary.sa3.transformSelection",
  continue: "gary.sa3.continueSelection",
};

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

function sendJson(response, body) {
  response.writeHead(200, { "Content-Type": "application/json" });
  response.end(JSON.stringify(body, (_key, value) => (typeof value === "bigint" ? String(value) : value)));
}

// Live's web view hands the dialog's result over through this object.
const WEBVIEW_STUB = `<script>window.chrome = { webview: { postMessage: (message) => {
  fetch("/__close", { method: "POST", body: JSON.stringify(message) });
} } };</script>`;

function proxyToDialog(request, response, body) {
  if (!state.dialog) {
    response.writeHead(404, { "Content-Type": "text/plain" });
    response.end("no dialog open");
    return;
  }
  const target = new URL(state.dialog.url);
  const upstream = http.request({
    host: target.hostname,
    port: target.port,
    method: request.method,
    path: request.url === "/" ? target.pathname : request.url,
    headers: {
      "Content-Type": request.headers["content-type"] || "application/json",
      ...(request.headers["x-gary-import"] ? { "X-Gary-Import": request.headers["x-gary-import"] } : {}),
    },
  }, (result) => {
    const chunks = [];
    result.on("data", (chunk) => chunks.push(chunk));
    result.on("end", () => {
      let bytes = Buffer.concat(chunks);
      if (request.url === "/") {
        bytes = Buffer.from(bytes.toString("utf8").replace("<head>", `<head>${WEBVIEW_STUB}`));
      }
      response.writeHead(result.statusCode, {
        "Content-Type": result.headers["content-type"] || "application/json",
        "Cache-Control": "no-store",
      });
      response.end(bytes);
    });
  });
  upstream.on("error", (error) => {
    response.writeHead(502);
    response.end(String(error));
  });
  upstream.end(body);
}

http.createServer(async (request, response) => {
  const body = await readBody(request);
  if (request.url === "/__state") {
    sendJson(response, state);
  } else if (request.url === "/__run") {
    const { operation = "generate", beats = 32, start = 0 } = JSON.parse(body.toString("utf8") || "{}");
    state.progress = [];
    state.clips = [];
    state.cleared = [];
    state.closed = [];
    commands.get(OPERATIONS[operation])({
      time_selection_start: start,
      time_selection_end: start + beats,
      selected_lanes: [handleOf(3n)],
    });
    sendJson(response, { started: operation });
  } else if (request.url === "/__close") {
    const message = JSON.parse(body.toString("utf8"));
    closeDialog?.(message.params[0]);
    sendJson(response, { closed: true });
  } else if (request.url === "/__dismiss") {
    // What Live does when the dialog's window is closed with its X: the result is an empty string.
    closeDialog?.("");
    sendJson(response, { closed: true });
  } else if (request.url === "/__cancel") {
    cancelProgress?.();
    sendJson(response, { cancelled: Boolean(cancelProgress) });
  } else {
    proxyToDialog(request, response, body);
  }
}).listen(port, "localhost", () => {
  console.log(`[harness] http://localhost:${port}/ storage=${storageDirectory}`);
});
