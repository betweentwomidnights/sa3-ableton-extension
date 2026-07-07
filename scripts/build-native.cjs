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
  metal: "build-metal",
};

function selectedBackend() {
  const backend = String(process.env.GARY_SA3_BACKEND || "").trim().toLowerCase();
  if (backend && !BACKEND_DIRS[backend]) {
    throw new Error(`Unknown GARY_SA3_BACKEND '${backend}' (expected cuda, vulkan, cpu, or metal)`);
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

function capture(command, args) {
  return cp.execFileSync(command, args, { encoding: "utf8" });
}

// Recursively locate a file by basename under dir (dylibs live in ggml subdirs).
function findByBasename(dir, basename) {
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.name === basename) {
        return full;
      }
    }
  }
  return null;
}

// The @rpath-relative dylib dependencies of a Mach-O file, by basename.
function rpathDeps(dylibPath) {
  const deps = [];
  for (const line of capture("otool", ["-L", dylibPath]).split("\n")) {
    const match = line.trim().match(/^@rpath\/(\S+)/);
    if (match) deps.push(match[1]);
  }
  return deps;
}

// Every LC_RPATH entry currently baked into a Mach-O file.
function currentRpaths(dylibPath) {
  const rpaths = [];
  const lines = capture("otool", ["-l", dylibPath]).split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === "cmd LC_RPATH") {
      for (let j = i + 1; j < Math.min(i + 4, lines.length); j++) {
        const match = lines[j].trim().match(/^path\s+(.+?)\s+\(offset/);
        if (match) {
          rpaths.push(match[1]);
          break;
        }
      }
    }
  }
  return rpaths;
}

// macOS: bundle libsa3.dylib plus its ggml deps (metal/blas/cpu/base) flat next
// to the addon, so the runtime .dylibs resolve via an @loader_path rpath the way
// the Windows build resolves its co-located .dll set.
function bundleMacRuntime(outDir) {
  const sa3CppDir = process.env.SA3_CPP_DIR || path.resolve(root, "..", "sa3.cpp");
  const backend = selectedBackend() || "metal";
  const buildDir = path.join(sa3CppDir, BACKEND_DIRS[backend]);
  const rootLib = path.join(buildDir, "libsa3.dylib");
  if (!exists(rootLib)) {
    throw new Error(
      `GARY_SA3_BACKEND=${backend} but libsa3.dylib not found in ${buildDir} ` +
      `(build it first: 'build.sh ${backend}' in ${sa3CppDir})`);
  }

  console.log(`[native] bundling SA3 dylibs from ${buildDir}`);
  const copied = new Set();
  const queue = ["libsa3.dylib"];
  while (queue.length) {
    const name = queue.shift();
    if (copied.has(name)) continue;
    const src = name === "libsa3.dylib" ? rootLib : findByBasename(buildDir, name);
    if (!src) {
      throw new Error(`could not locate ${name} (dependency of libsa3.dylib) under ${buildDir}`);
    }
    const dest = path.join(outDir, name);
    fs.copyFileSync(src, dest); // follows symlinks -> copies the real dylib
    fs.chmodSync(dest, 0o755);
    copied.add(name);
    for (const dep of rpathDeps(dest)) {
      if (!copied.has(dep)) queue.push(dep);
    }
  }

  // Make each dylib self-contained: strip the absolute build-tree rpaths baked in
  // by the sa3.cpp build (they leak local paths and get searched before the
  // bundled copies), leaving only @loader_path so siblings resolve from this dir.
  // Then re-adhoc-sign: install_name_tool invalidates the signature, and arm64
  // refuses to dlopen an unsigned/invalidly-signed dylib.
  for (const name of copied) {
    const dest = path.join(outDir, name);
    let hasLoaderPath = false;
    for (const rpath of currentRpaths(dest)) {
      if (rpath === "@loader_path") {
        hasLoaderPath = true;
      } else {
        run("install_name_tool", ["-delete_rpath", rpath, dest]);
      }
    }
    if (!hasLoaderPath) {
      run("install_name_tool", ["-add_rpath", "@loader_path", dest]);
    }
    run("codesign", ["--force", "--sign", "-", dest]);
  }
  console.log(`[native] bundled ${copied.size} dylibs: ${[...copied].join(", ")}`);
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
} else if (platform === "darwin") {
  bundleMacRuntime(outDir);
}

console.log(`[native] embedded SA3 assets ready: ${outDir}`);
