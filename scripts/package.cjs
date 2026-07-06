// Package one or more backend-specific .ablx artifacts.
//
//   node scripts/package.cjs cuda vulkan cpu
//
// The JS bundle and the native addon are backend-agnostic, so they are built
// once; each backend only swaps the bundled sa3.dll + ggml*.dll set before
// packaging. Output: dist/gary-extension-<backend>.ablx, copied to releases/.
const cp = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..");
const KNOWN_BACKENDS = ["cuda", "vulkan", "cpu"];

let backends = process.argv.slice(2).map((value) => value.trim().toLowerCase()).filter(Boolean);
if (backends.length === 0) {
  backends = ["cuda"];
}
for (const backend of backends) {
  if (!KNOWN_BACKENDS.includes(backend)) {
    throw new Error(`Unknown backend '${backend}' (expected: ${KNOWN_BACKENDS.join(", ")})`);
  }
}

function run(command, args, env) {
  cp.execFileSync(command, args, {
    cwd: root,
    stdio: "inherit",
    shell: process.platform === "win32",
    env: { ...process.env, ...env },
  });
}

// Bundle the extension JS once; it does not depend on the backend.
run("npm", ["run", "build:js"]);

const releasesDir = path.join(root, "releases");
fs.mkdirSync(releasesDir, { recursive: true });

backends.forEach((backend, index) => {
  const env = { GARY_SA3_BACKEND: backend };
  // The addon is compiled on the first backend and reused for the rest.
  if (index > 0) {
    env.GARY_SA3_SKIP_GYP = "1";
  }
  run("node", ["scripts/build-native.cjs"], env);

  const outName = `gary-extension-${backend}.ablx`;
  const outPath = path.join("dist", outName);
  run("npx", ["extensions-cli", "package", "-o", outPath, "-i", "dist/native"]);

  fs.copyFileSync(path.join(root, outPath), path.join(releasesDir, outName));
  const sizeMb = fs.statSync(path.join(root, outPath)).size / (1024 * 1024);
  console.log(`[gary-extension] ${backend}: releases/${outName} (${sizeMb.toFixed(1)} MB)`);
});
