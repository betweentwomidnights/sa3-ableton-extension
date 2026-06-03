#!/usr/bin/env node

const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const url = require("node:url");
const childProcess = require("node:child_process");

globalThis.require = require;
globalThis.fs = fs;
globalThis.path = path;
globalThis.vm = vm;
globalThis.url = url;

const NODE_MODULE_FILE = "ExtensionHostNodeModule.node";
const repoRoot = path.resolve(__dirname, "..");

loadEnvFile(path.join(repoRoot, ".env"));

const livePath = process.env.EXTENSION_HOST_PATH;
if (!livePath) {
  throw new Error("EXTENSION_HOST_PATH is missing. Set it in .env.");
}

const extensionHostDir = resolveExtensionHostDir(livePath);
const hostModulePath = path.join(extensionHostDir, NODE_MODULE_FILE);
const hostNodePath = path.join(extensionHostDir, "node.exe");
const storageDirectory = path.join(repoRoot, ".ableton-storage");
const tempDirectory = path.join(repoRoot, ".ableton-temp");

if (fs.existsSync(hostNodePath) && !samePath(process.execPath, hostNodePath)) {
  console.log(`Re-launching with Ableton Extension Host Node: ${hostNodePath}`);
  const result = childProcess.spawnSync(hostNodePath, [__filename], {
    cwd: repoRoot,
    env: process.env,
    stdio: "inherit",
  });

  if (result.error) {
    throw result.error;
  }

  process.exit(result.status ?? 0);
}

fs.mkdirSync(storageDirectory, { recursive: true });
fs.mkdirSync(tempDirectory, { recursive: true });

console.log("Starting Extension Host...");
console.log(`  Extension: ${repoRoot}`);
console.log(`  Live: ${livePath}`);
console.log(`  Host: ${hostModulePath}`);
console.log();

require(hostModulePath).initialize({
  extensions: [
    {
      path: toForwardSlash(repoRoot),
      storageDirectory: toForwardSlash(storageDirectory),
      tempDirectory: toForwardSlash(tempDirectory),
    },
  ],
});

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return;
  }

  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/u);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const separator = trimmed.indexOf("=");
    if (separator === -1) {
      continue;
    }

    const key = trimmed.slice(0, separator).trim();
    const value = trimmed.slice(separator + 1).trim().replace(/^["']|["']$/gu, "");
    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

function resolveExtensionHostDir(livePathValue) {
  const appPath = livePathValue.replace(/[\\/]+$/u, "");
  if (!fs.existsSync(appPath)) {
    throw new Error(`Path not found: ${appPath}`);
  }

  if (appPath.endsWith(".node")) {
    return path.dirname(appPath);
  }

  if (appPath.endsWith(".exe")) {
    return path.join(path.dirname(appPath), "ExtensionHost");
  }

  const winExtHost = path.join(appPath, "Program", "ExtensionHost");
  if (fs.existsSync(path.join(winExtHost, NODE_MODULE_FILE))) {
    return winExtHost;
  }

  if (fs.statSync(appPath).isDirectory() && fs.existsSync(path.join(appPath, NODE_MODULE_FILE))) {
    return appPath;
  }

  throw new Error(
    `Invalid Ableton Live path: ${livePathValue}\n` +
      "Expected an install root, Ableton Live.exe, ExtensionHost directory, or ExtensionHostNodeModule.node.",
  );
}

function toForwardSlash(value) {
  return value.replace(/\\/gu, "/");
}

function samePath(left, right) {
  return path.resolve(left).toLowerCase() === path.resolve(right).toLowerCase();
}
