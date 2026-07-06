const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const platform = process.platform;
const arch = process.arch;
const outDir = path.join(root, "dist", "native", `${platform}-${arch}`);
const addonName = platform === "win32" ? "sa3_embedded.node" : "sa3_embedded.node";
const addonPath = path.join(root, "build", "Release", addonName);

function exists(filePath) {
  try {
    fs.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function copyFile(src, destDir) {
  if (!exists(src)) {
    throw new Error(`Missing native asset: ${src}`);
  }
  fs.mkdirSync(destDir, { recursive: true });
  fs.copyFileSync(src, path.join(destDir, path.basename(src)));
}

function copyGlob(dir, pattern, destDir, required = true) {
  if (!exists(dir)) {
    if (required) throw new Error(`Missing native asset directory: ${dir}`);
    return [];
  }

  const matcher = new RegExp(`^${pattern.replace(/\*/g, ".*")}$`, "i");
  const copied = [];
  for (const entry of fs.readdirSync(dir)) {
    if (matcher.test(entry)) {
      const src = path.join(dir, entry);
      if (fs.statSync(src).isFile()) {
        copyFile(src, destDir);
        copied.push(src);
      }
    }
  }

  if (required && copied.length === 0) {
    throw new Error(`No files matched ${pattern} in ${dir}`);
  }
  return copied;
}

// GARY_SA3_BACKEND selects which sa3.cpp build supplies the runtime DLLs.
// The compiled addon is backend-agnostic (it LoadLibrary's sa3.dll at runtime),
// so only the bundled DLL set differs between backends.
// cpu -> the plain static build (ggml-cpu.dll is a direct dependency, so it loads
// from the addon dir when embedded). build-cpu-variants uses GGML_BACKEND_DL and
// discovers ggml-cpu-*.dll from the process dir, which fails inside the extension
// host; it stays a CLI-only benchmarking build.
const BACKEND_DIRS = {
  cuda: "build-cuda",
  vulkan: "build-vulkan",
  cpu: "build",
};

function selectedBackend() {
  const backend = String(process.env.GARY_SA3_BACKEND || "").trim().toLowerCase();
  if (backend && !BACKEND_DIRS[backend]) {
    throw new Error(`Unknown GARY_SA3_BACKEND '${backend}' (expected cuda, vulkan, or cpu)`);
  }
  return backend;
}

function defaultSa3RuntimeDir() {
  const sa3CppDir = process.env.SA3_CPP_DIR || path.resolve(root, "..", "sa3.cpp");
  const backend = selectedBackend();
  if (backend) {
    const dir = path.join(sa3CppDir, BACKEND_DIRS[backend], "bin", "Release");
    if (!exists(path.join(dir, "sa3.dll"))) {
      throw new Error(`GARY_SA3_BACKEND=${backend} but sa3.dll not found in ${dir}`);
    }
    return dir;
  }

  const candidates = [
    process.env.SA3_RUNTIME_DIR,
    path.join(sa3CppDir, "build-cuda", "bin", "Release"),
    path.join(sa3CppDir, "build-vulkan", "bin", "Release"),
    path.join(sa3CppDir, "build", "bin", "Release"),
  ].filter(Boolean);

  return candidates.find((candidate) => exists(path.join(candidate, "sa3.dll"))) || candidates[0];
}

function run(command, args) {
  cp.execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
  });
}

if (process.env.GARY_SA3_SKIP_NATIVE === "1") {
  console.log("[native] skipping embedded SA3 build because GARY_SA3_SKIP_NATIVE=1");
  process.exit(0);
}

if (process.env.GARY_SA3_SKIP_GYP === "1") {
  console.log("[native] GARY_SA3_SKIP_GYP=1: reusing already-compiled sa3_embedded.node");
  if (!exists(addonPath)) {
    throw new Error(`GARY_SA3_SKIP_GYP=1 but ${addonPath} does not exist; run a full build first`);
  }
} else {
  console.log("[native] building sa3_embedded.node");
  run("npx", ["node-gyp", "rebuild"]);

  if (!exists(addonPath)) {
    throw new Error(`node-gyp did not produce ${addonPath}`);
  }
}

fs.rmSync(outDir, { recursive: true, force: true });
fs.mkdirSync(outDir, { recursive: true });
copyFile(addonPath, outDir);

if (platform === "win32") {
  const runtimeDir = defaultSa3RuntimeDir();
  console.log(`[native] copying SA3 runtime from ${runtimeDir}`);
  copyFile(path.join(runtimeDir, "sa3.dll"), outDir);
  copyGlob(runtimeDir, "ggml*.dll", outDir);

  if (exists(path.join(runtimeDir, "ggml-cuda.dll"))) {
    const cudaDir = process.env.SA3_CUDA_RUNTIME_DIR ||
      (process.env.CUDA_PATH ? path.join(process.env.CUDA_PATH, "bin") : "");
    if (!cudaDir) {
      throw new Error("CUDA SA3 runtime selected, but CUDA_PATH/SA3_CUDA_RUNTIME_DIR is not set");
    }

    console.log(`[native] copying CUDA runtime from ${cudaDir}`);
    copyGlob(cudaDir, "cudart64_*.dll", outDir);
    copyGlob(cudaDir, "cublas64_*.dll", outDir);
    copyGlob(cudaDir, "cublasLt64_*.dll", outDir);
  }
}

console.log(`[native] embedded SA3 assets ready: ${outDir}`);
