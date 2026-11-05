import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const html = readFileSync(new URL("../src/transform-dialog.html", import.meta.url), "utf8");

// A click anywhere in a label also clicks the first control inside it. A prompt box is a div, so a
// label around a box and the dice button turned every click on the box into a dice roll.
test("no label holds a button", () => {
  const labels = html.match(/<label\b[\s\S]*?<\/label>/gu) ?? [];
  assert.ok(labels.length > 0);
  for (const label of labels) {
    assert.doesNotMatch(label, /<button\b/u);
  }
});
