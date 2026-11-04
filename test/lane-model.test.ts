import assert from "node:assert/strict";
import { test } from "node:test";

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { Readable } from "node:stream";

import { importEmbeddedLoraFile, promptsFromPoolJson } from "../src/embedded-sa3.js";
import {
  beatsPerBarFromMeter,
  composePrompt,
  keyScaleText,
  laneBlendSettings,
  laneEnvelopeSeconds,
  MAX_LANE_POINTS,
  planLanes,
  sanitizeLanes,
  simplifyLanePoints,
  stripPromptBpm,
  waveformPeaks,
  type LanePoint,
} from "../src/lane-model.js";

test("blends match Shared/SA3LaneModel.h", () => {
  assert.deepEqual(laneBlendSettings("one-song"), { isolation: 1, isolationUntil: 0, averageUntil: 0.9 });
  assert.deepEqual(laneBlendSettings("distinct"), { isolation: 4, isolationUntil: 0.9, averageUntil: 0 });
});

test("a curve spans the render, and Continue starts it after the source", () => {
  const points: LanePoint[] = [[0, 0], [0.5, 2], [1, 1]];
  assert.deepEqual(laneEnvelopeSeconds(points, 0, 10), [0, 0, 5, 2, 10, 1]);
  assert.deepEqual(laneEnvelopeSeconds(points, 8, 10), [8, 0, 13, 2, 18, 1]);
});

test("amounts sent to libsa3 stay within a lane's range", () => {
  assert.deepEqual(laneEnvelopeSeconds([[0, 5], [1, -1]], 0, 1), [0, 2, 1, 0]);
});

test("a freehand curve is thinned to the limit and keeps its ends and peak", () => {
  const points: LanePoint[] = [];
  for (let i = 0; i <= 2000; i++) {
    const position = i / 2000;
    points.push([position, 1 + Math.sin(position * 40)]);
  }
  points[1000] = [0.5, 2];
  const thinned = simplifyLanePoints(points);
  assert.ok(thinned.length <= MAX_LANE_POINTS);
  assert.deepEqual(thinned[0], points[0]);
  assert.deepEqual(thinned.at(-1), points.at(-1));
  assert.ok(thinned.some(([position, amount]) => position === 0.5 && amount === 2));
});

const plan = (lanes: Parameters<typeof planLanes>[0]["lanes"], availableLoras: string[]) => planLanes({
  lanes,
  loras: [{ name: "kev", strength: 1 }, { name: "keygen", strength: 0.5 }, { name: "gone", strength: 1 }],
  availableLoras,
  composePrompt: (prompt) => `${prompt} 120 bpm`,
  offsetSeconds: 0,
  durationSeconds: 10,
});

test("a lane replaces its LoRA's fixed strength", () => {
  const result = plan([{ name: "kev", prompt: "", points: [[0, 0], [1, 1]] }], ["kev", "keygen"]);
  assert.deepEqual(result.lanes, [{ name: "kev", prompt: "", envelope: [0, 0, 10, 1] }]);
  assert.deepEqual(result.loras, [{ name: "keygen", strength: 0.5 }]);
});

test("a lane flat at 0 stays out of the render, and so does its LoRA", () => {
  const result = plan([{ name: "kev", prompt: "words", points: [[0, 0], [1, 0]] }], ["kev", "keygen"]);
  assert.deepEqual(result.lanes, []);
  assert.deepEqual(result.loras, [{ name: "keygen", strength: 0.5 }]);
});

test("lanes and strengths for missing LoRAs are not sent", () => {
  const result = plan([{ name: "gone", prompt: "", points: [[0, 1], [1, 1]] }], ["kev", "keygen"]);
  assert.deepEqual(result.lanes, []);
  assert.deepEqual(result.loras.map((lora) => lora.name), ["kev", "keygen"]);
});

test("a lane's prompt gets the same tempo and key as the base, and an empty one stays empty", () => {
  const result = plan([
    { name: "kev", prompt: "  drums ", points: [[0, 1]] },
    { name: "keygen", prompt: " ", points: [[0, 1]] },
  ], ["kev", "keygen"]);
  assert.equal(result.lanes[0]!.prompt, "drums 120 bpm");
  assert.equal(result.lanes[1]!.prompt, "");
});

test("saved lanes are cleaned up on the way back in", () => {
  assert.deepEqual(sanitizeLanes("nope"), []);
  assert.deepEqual(sanitizeLanes([
    { name: "kev", prompt: "p", points: [[0.5, 1], [0.25, 9], "bad", [2, -1]] },
    { name: "kev", prompt: "duplicate", points: [] },
    { name: "", points: [] },
  ]), [{ name: "kev", prompt: "p", points: [[0.25, 2], [0.5, 1], [1, 0]] }]);
});

test("a tempo in a prompt is replaced, in any of its forms", () => {
  assert.equal(stripPromptBpm("warm pads, 120 bpm, tape hiss"), "warm pads, tape hiss");
  assert.equal(stripPromptBpm("bpm: 90 drums"), "drums");
  assert.equal(stripPromptBpm("no tempo, here"), "no tempo, here");
  assert.equal(composePrompt("warm pads 90 BPM", 128.4, "C minor"), "warm pads 128 bpm C minor");
  assert.equal(composePrompt("", 120, ""), "120 bpm");
});

test("the key follows Live, is off, or is chosen", () => {
  assert.equal(keyScaleText(-1, 0, "A Minor"), "A Minor");
  assert.equal(keyScaleText(-1, 0, ""), "");
  assert.equal(keyScaleText(0, 1, "A Minor"), "");
  assert.equal(keyScaleText(1, 1, "A Minor"), "C minor");
  assert.equal(keyScaleText(12, 0, ""), "B major");
});

test("a bar is measured in Live's quarter-note beats", () => {
  assert.equal(beatsPerBarFromMeter("4/4"), 4);
  assert.equal(beatsPerBarFromMeter("3/4"), 3);
  assert.equal(beatsPerBarFromMeter("6/8"), 3);
  assert.equal(beatsPerBarFromMeter("7/8"), 3.5);
  assert.equal(beatsPerBarFromMeter("nonsense"), 4);
});

test("a prompt pool is read from either shape, and adapter settings aren't one", () => {
  assert.deepEqual(promptsFromPoolJson({ version: 1, source: { lora: "koan" }, dice: { a: ["one", "two"], b: ["three", 4] } }),
    ["one", "two", "three"]);
  assert.deepEqual(promptsFromPoolJson(["one", 2]), ["one"]);
  assert.deepEqual(promptsFromPoolJson({ rank: 16, alpha: 16, adapter_type: "dora-rows", include: null }), []);
  assert.deepEqual(promptsFromPoolJson(null), []);
});

test("an import can't leave the lora's own folder, and sorts a pool from adapter settings", async () => {
  const folder = await fs.mkdtemp(path.join(os.tmpdir(), "gary-import-テスト-"));
  const options = { modelsDir: folder, adaptersDir: folder, variant: "medium" };
  const send = (name: string, file: string, text: string) =>
    importEmbeddedLoraFile(options, name, file, Readable.from([Buffer.from(text)]));
  try {
    for (const name of ["..", "../up", "a/b", "_off", ".off", "c:d", ""]) {
      await assert.rejects(send(name, "x.txt", "hi"), /can't be a lora name/, name);
    }
    await assert.rejects(send("koan", "../x.txt", "hi"), /can't import/);
    await assert.rejects(send("koan", "evil.exe", "hi"), /can't import/);
    await assert.rejects(send("koan", "koan.ckpt", "hi"), /can't import/);
    await assert.rejects(send("koan", "broken.json", "{"), /valid JSON/);

    await send("コアン", "コアン.json", JSON.stringify({ dice: { a: ["one", "two"] } }));
    await send("コアン", "settings.json", JSON.stringify({ rank: 16 }));
    await send("コアン", "caption.txt", "three, 120 bpm\nignored");
    await send("コアン", "コアン.safetensors", "bytes");
    const dir = path.join(folder, "medium", "コアン");
    assert.deepEqual((await fs.readdir(dir)).sort(), [
      "caption.txt", "prompts.json", "settings.json", "コアン.safetensors",
    ].sort());
  } finally {
    await fs.rm(folder, { recursive: true, force: true });
  }
});

function wav(samples: number[], sampleRate = 100, channels = 1): Uint8Array {
  const bytes = new Uint8Array(44 + samples.length * 2);
  const view = new DataView(bytes.buffer);
  const tag = (offset: number, text: string) => [...text].forEach((c, i) => view.setUint8(offset + i, c.charCodeAt(0)));
  tag(0, "RIFF");
  view.setUint32(4, 36 + samples.length * 2, true);
  tag(8, "WAVE");
  tag(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels * 2, true);
  view.setUint16(32, channels * 2, true);
  view.setUint16(34, 16, true);
  tag(36, "data");
  view.setUint32(40, samples.length * 2, true);
  samples.forEach((sample, i) => view.setInt16(44 + i * 2, sample, true));
  return bytes;
}

test("peaks follow the audio, from where they're asked to start", () => {
  const audio = wav([...new Array(100).fill(0), ...new Array(100).fill(16384)]);
  assert.deepEqual(waveformPeaks(audio, 0, 2), [0, 0, 0, 0.5]);
  assert.deepEqual(waveformPeaks(audio, 1, 2), [0, 0.5, 0, 0.5]);
  assert.deepEqual(waveformPeaks(audio, 5, 2), []);
  assert.deepEqual(waveformPeaks(new Uint8Array(4), 0), []);
});
