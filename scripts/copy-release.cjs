const fs = require("node:fs");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const source = path.join(repoRoot, "dist", "gary-extension.ablx");
const targetDir = path.join(repoRoot, "releases");
const target = path.join(targetDir, "gary-extension.ablx");

fs.mkdirSync(targetDir, { recursive: true });
fs.copyFileSync(source, target);

console.log(`[gary-extension] copied ${path.relative(repoRoot, source)} -> ${path.relative(repoRoot, target)}`);
