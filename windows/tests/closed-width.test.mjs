// The closed island's width has to be measured where it can actually grow.
//
// The bug this guards: the line was measured on the element that lives inside
// the window being resized. `overflow: hidden` clamps `scrollWidth` to that
// window, so a longer line measured as the old width and was cut off instead of
// widening the island — "84,1M / 24,61…" instead of the full total.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const island = readFileSync(new URL("../src/island/island.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

test("the closed island's text is measured off-screen, not in its own window", () => {
  const measure = island.slice(island.indexOf("const textWidth"), island.indexOf("const w = closedWidth"));
  assert.match(measure, /this\.closedMeasure\.scrollWidth/, "the off-screen copy is what gets measured");
  assert.doesNotMatch(measure, /this\.closedText\.scrollWidth/, "measuring the real element cannot work");
});

test("the measuring copy exists, shares the font and takes no space", () => {
  assert.match(island, /this\.closedMeasure = h\("div", \{ id: "closed-measure" \}\)/, "it is created");
  assert.match(island, /this\.closedMeasure\.textContent = content\.text/, "it carries the same text");
  const rule = css.slice(css.indexOf("#closed-measure {"));
  const body = rule.slice(0, rule.indexOf("}")).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(body, /position: absolute/, "out of the layout");
  assert.match(body, /left: -10000px/, "off-screen");
  assert.match(body, /visibility: hidden/, "not drawn");
  assert.match(body, /white-space: nowrap/, "one line, as the island draws it");
  assert.match(body, /font-size: 12px/, "the island's font");
  assert.match(body, /font-weight: 600/, "the island's weight");
  // closedWidth() adds CLOSED_PAD itself; padding here would count it twice.
  assert.doesNotMatch(body, /padding/, "no padding on the measure copy");
});

test("the line it measures fits inside the island's own cap", async () => {
  const { closedWidth, CLOSED_MAX_W } = await import("../src/core/closed.ts");
  // A realistic day: the text is ~120 px in the island's font.
  const width = closedWidth(120, 0);
  assert.ok(width <= CLOSED_MAX_W, `a normal total must not hit the cap (${width} > ${CLOSED_MAX_W})`);
  assert.ok(width >= 120 + 32, "the padding is added on top of the text");
});
