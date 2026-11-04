// The rules behind automation lanes, matching Shared/SA3LaneModel.h in the iPlug2 demo so a curve means
// the same thing in every frontend. The dialog owns editing; this turns its state into a request.

export const MAX_LANES = 8;
export const MAX_LANE_POINTS = 256;
export const MAX_LANE_AMOUNT = 2;

/** [position, amount]. Position runs 0..1 across what's rendered, so a curve follows the selection. */
export type LanePoint = [number, number];

export interface LaneState {
  name: string;
  prompt: string;
  points: LanePoint[];
}

export type LaneBlend = "one-song" | "distinct";

export interface LaneBlendSettings {
  isolation: number;
  isolationUntil: number;
  averageUntil: number;
}

export interface PlannedLane {
  name: string;
  prompt: string;
  /** Flat (seconds, amount) pairs on the output timeline. */
  envelope: number[];
}

export function laneBlendSettings(blend: LaneBlend): LaneBlendSettings {
  return blend === "distinct"
    ? { isolation: 4, isolationUntil: 0.9, averageUntil: 0 }
    : { isolation: 1, isolationUntil: 0, averageUntil: 0.9 };
}

function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) {
    return min;
  }
  return Math.max(min, Math.min(max, value));
}

// Thins a curve to at most maxPoints, keeping its shape: freehand strokes can exceed what one lane may
// carry. Douglas-Peucker on the amount error, loosening the tolerance until it fits.
export function simplifyLanePoints(points: LanePoint[], maxPoints = MAX_LANE_POINTS): LanePoint[] {
  if (points.length <= maxPoints || maxPoints < 2) {
    return points;
  }

  for (let tolerance = 0.002; ; tolerance *= 1.5) {
    const keep = new Array<boolean>(points.length).fill(false);
    keep[0] = true;
    keep[points.length - 1] = true;
    const spans: Array<[number, number]> = [[0, points.length - 1]];
    while (spans.length > 0) {
      const [first, last] = spans.pop()!;
      const [firstPosition, firstAmount] = points[first]!;
      const [lastPosition, lastAmount] = points[last]!;
      const span = lastPosition - firstPosition;
      let worst = 0;
      let worstIndex = first;
      for (let i = first + 1; i < last; i++) {
        const [position, amount] = points[i]!;
        const u = span > 0 ? (position - firstPosition) / span : 0;
        const error = Math.abs(amount - (firstAmount + u * (lastAmount - firstAmount)));
        if (error > worst) {
          worst = error;
          worstIndex = i;
        }
      }
      if (worst > tolerance) {
        keep[worstIndex] = true;
        spans.push([first, worstIndex], [worstIndex, last]);
      }
    }
    if (keep.filter(Boolean).length <= maxPoints) {
      return points.filter((_, index) => keep[index]);
    }
  }
}

// The (seconds, amount) pairs libsa3 reads. offsetSeconds places position 0 on the output timeline,
// which Continue needs because its time 0 is the start of the source.
export function laneEnvelopeSeconds(
  points: LanePoint[],
  offsetSeconds: number,
  durationSeconds: number,
): number[] {
  const envelope: number[] = [];
  for (const [position, amount] of simplifyLanePoints(points)) {
    envelope.push(offsetSeconds + position * durationSeconds, clamp(amount, 0, MAX_LANE_AMOUNT));
  }
  return envelope;
}

/**
 * Which lanes a render sends, and which LoRAs still run at a fixed strength. A LoRA with a lane leaves
 * the fixed list, since it would otherwise run in every pass too, even when its curve stays at 0.
 */
export function planLanes(args: {
  lanes: LaneState[];
  loras: Array<{ name: string; strength: number }>;
  availableLoras: string[];
  composePrompt: (prompt: string) => string;
  offsetSeconds: number;
  durationSeconds: number;
}): { lanes: PlannedLane[]; loras: Array<{ name: string; strength: number }> } {
  const available = new Set(args.availableLoras);
  const lanes: PlannedLane[] = [];
  const replaced = new Set<string>();
  for (const lane of args.lanes) {
    if (!available.has(lane.name)) {
      continue;
    }
    replaced.add(lane.name);
    // A curve that stays at 0 has nothing to add, and sending it would still encode its prompt.
    if (!lane.points.some(([, amount]) => amount > 0)) {
      continue;
    }
    const prompt = lane.prompt.trim();
    lanes.push({
      name: lane.name,
      prompt: prompt ? args.composePrompt(prompt) : "",
      envelope: laneEnvelopeSeconds(lane.points, args.offsetSeconds, args.durationSeconds),
    });
  }
  return {
    lanes,
    loras: args.loras.filter((lora) => available.has(lora.name) && !replaced.has(lora.name)),
  };
}

export function sanitizeLanes(raw: unknown): LaneState[] {
  if (!Array.isArray(raw)) {
    return [];
  }

  const lanes: LaneState[] = [];
  const names = new Set<string>();
  for (const item of raw) {
    const record = item as { name?: unknown; prompt?: unknown; points?: unknown } | null;
    const name = typeof record?.name === "string" ? record.name.trim() : "";
    if (!name || names.has(name) || lanes.length >= MAX_LANES) {
      continue;
    }
    const points: LanePoint[] = [];
    if (Array.isArray(record?.points)) {
      for (const point of record.points as unknown[]) {
        if (Array.isArray(point) && Number.isFinite(point[0]) && Number.isFinite(point[1])) {
          points.push([clamp(Number(point[0]), 0, 1), clamp(Number(point[1]), 0, MAX_LANE_AMOUNT)]);
        }
      }
    }
    points.sort((left, right) => left[0] - right[0]);
    names.add(name);
    lanes.push({
      name,
      prompt: typeof record?.prompt === "string" ? record.prompt : "",
      points: simplifyLanePoints(points),
    });
  }
  return lanes;
}

const BPM_TAG = /\b(?:[0-9]+(?:\.[0-9]+)?\s*bpm|bpm\s*[:=]?\s*[0-9]+(?:\.[0-9]+)?)\b/giu;

// Same as sa3::strip_prompt_bpm: a tempo already in the prompt is replaced rather than doubled.
export function stripPromptBpm(prompt: string): string {
  if (prompt.search(BPM_TAG) === -1) {
    return prompt;
  }
  BPM_TAG.lastIndex = 0;
  return prompt
    .split(/[,;]/u)
    .map((part) => part.trim().replace(BPM_TAG, "").trim())
    .filter(Boolean)
    .join(", ");
}

const KEY_ROOTS = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

/** Root -1 follows Live's Scale Mode, 0 is no key, and 1..12 are C..B. */
export function keyScaleText(root: number, mode: number, liveKeyScale: string): string {
  if (root < 0) {
    return liveKeyScale.trim();
  }
  const name = KEY_ROOTS[root - 1];
  return name ? `${name} ${mode ? "minor" : "major"}` : "";
}

// The same order and spacing as the demo, so the same settings ask the model the same thing.
export function composePrompt(prompt: string, tempo: number, keyScale: string): string {
  const parts = [stripPromptBpm(prompt.trim()), `${Math.round(tempo > 0 ? tempo : 120)} bpm`, keyScale.trim()];
  return parts.filter(Boolean).join(" ");
}

export const METERS = ["2/4", "3/4", "4/4", "5/4", "6/4", "7/4", "5/8", "6/8", "7/8", "9/8", "12/8"];

/** Live's beats are quarter notes, so a bar of 6/8 is 3 of them. */
export function beatsPerBarFromMeter(meter: string): number {
  const [numerator, denominator] = meter.split("/").map(Number);
  return numerator && denominator ? (numerator * 4) / denominator : 4;
}

/**
 * Min/max pairs across a 16-bit WAV, starting startSeconds in, for the strip above the lanes.
 * Returns nothing for a file it can't read, since a missing backdrop only hides a drawing.
 */
export function waveformPeaks(wav: Uint8Array, startSeconds: number, columns = 320): number[] {
  const view = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (offset: number) => String.fromCharCode(...wav.subarray(offset, offset + 4));
  if (wav.length < 12 || tag(0) !== "RIFF" || tag(8) !== "WAVE") {
    return [];
  }

  let channels = 0;
  let sampleRate = 0;
  let bits = 0;
  let dataStart = 0;
  let dataBytes = 0;
  for (let offset = 12; offset + 8 <= wav.length;) {
    const size = view.getUint32(offset + 4, true);
    if (tag(offset) === "fmt " && offset + 24 <= wav.length) {
      channels = view.getUint16(offset + 10, true);
      sampleRate = view.getUint32(offset + 12, true);
      bits = view.getUint16(offset + 22, true);
    } else if (tag(offset) === "data") {
      dataStart = offset + 8;
      dataBytes = Math.min(size, wav.length - dataStart);
      break;
    }
    offset += 8 + size + (size % 2);
  }
  if (bits !== 16 || channels < 1 || sampleRate < 1 || dataBytes < 1) {
    return [];
  }

  const frames = Math.floor(dataBytes / (channels * 2));
  const first = Math.min(frames, Math.max(0, Math.round(startSeconds * sampleRate)));
  const count = frames - first;
  if (count <= 0) {
    return [];
  }

  const peaks: number[] = [];
  for (let column = 0; column < columns; column++) {
    const from = first + Math.floor((count * column) / columns);
    const to = first + Math.floor((count * (column + 1)) / columns);
    let low = 0;
    let high = 0;
    // A long render has far more frames than a column can show, so sample rather than read them all.
    const step = Math.max(1, Math.floor((to - from) / 256));
    for (let frame = from; frame < to; frame += step) {
      for (let channel = 0; channel < channels; channel++) {
        const value = view.getInt16(dataStart + (frame * channels + channel) * 2, true) / 32768;
        low = Math.min(low, value);
        high = Math.max(high, value);
      }
    }
    peaks.push(Math.round(low * 1000) / 1000, Math.round(high * 1000) / 1000);
  }
  return peaks;
}
