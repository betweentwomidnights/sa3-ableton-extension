import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { embeddedEffectiveDirs, listEmbeddedLoras, removeEmbeddedLora } from "../src/embedded-sa3.ts";

function fixture(): { options: { modelsDir: string; adaptersDir: string; variant: string }; variantDir: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "gary-lora-remove-"));
  const options = { modelsDir: path.join(root, "models"), adaptersDir: path.join(root, "loras"), variant: "medium" };
  const variantDir = embeddedEffectiveDirs(options).lorasVariantDir;
  fs.mkdirSync(variantDir, { recursive: true });
  return { options, variantDir };
}

function write(directory: string, ...names: string[]): void {
  fs.mkdirSync(directory, { recursive: true });
  for (const name of names) {
    fs.writeFileSync(path.join(directory, name), "x");
  }
}

test("removing a lora takes its folder when nothing else is in it", async () => {
  const { options, variantDir } = fixture();
  write(path.join(variantDir, "koan"), "koan.gguf", "koan.safetensors", "koan.json", "prompts.json", "a.txt", "b.gguf.part");
  write(path.join(variantDir, "other"), "other.gguf");

  assert.deepEqual(await removeEmbeddedLora(options, "koan"), { itemsLeft: 0 });

  assert.equal(fs.existsSync(path.join(variantDir, "koan")), false);
  assert.deepEqual(await listEmbeddedLoras(options), ["other"]);
});

test("removing a lora leaves what isn't part of it", async () => {
  const { options, variantDir } = fixture();
  const folder = path.join(variantDir, "koan");
  write(folder, "koan.safetensors", "koan.json", "take.wav", "koan.ckpt");
  write(path.join(folder, "dataset"), "clip.txt", "clip.safetensors");

  assert.deepEqual(await removeEmbeddedLora(options, "koan"), { itemsLeft: 3 });

  assert.deepEqual(fs.readdirSync(folder).sort(), ["dataset", "koan.ckpt", "take.wav"]);
  assert.equal(fs.existsSync(path.join(folder, "dataset", "clip.safetensors")), true);
  assert.deepEqual(await listEmbeddedLoras(options), []);
});

test("every flat file of that name goes, so it can't step back onto the list", async () => {
  const { options, variantDir } = fixture();
  write(variantDir, "lora-koan.gguf", "lora-koan-f16.gguf", "lora-koan-v2.gguf", "lora-other.gguf");

  assert.deepEqual(await removeEmbeddedLora(options, "koan"), { itemsLeft: 0 });

  assert.deepEqual(fs.readdirSync(variantDir), ["lora-other.gguf"]);
});

test("a folder and a flat file of one name both go", async () => {
  const { options, variantDir } = fixture();
  write(path.join(variantDir, "koan"), "koan.gguf");
  write(variantDir, "lora-koan.gguf");

  await removeEmbeddedLora(options, "KOAN");

  assert.deepEqual(fs.readdirSync(variantDir), []);
});

test("a name that isn't on the list reaches nothing", async () => {
  const { options, variantDir } = fixture();
  write(path.join(variantDir, "_disabled"), "disabled.gguf");
  write(path.join(variantDir, "..", "small-music", "elsewhere"), "elsewhere.gguf");

  for (const name of ["_disabled", "../small-music/elsewhere", "..", "", "missing"]) {
    await assert.rejects(removeEmbeddedLora(options, name), /isn't on the list/u);
  }

  assert.equal(fs.existsSync(path.join(variantDir, "_disabled", "disabled.gguf")), true);
  assert.equal(fs.existsSync(path.join(variantDir, "..", "small-music", "elsewhere", "elsewhere.gguf")), true);
});
