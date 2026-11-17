// The closed island's width, and the two ways it used to come out too small.
//
// Bug one: the line was measured on the element that lives inside the window
// being resized. `overflow: hidden` clamps `scrollWidth` to that window, so a
// longer line measured as the old width and was cut off instead of widening the
// island — "84,1M / 24,61…" instead of the full total. Fixed by measuring a
// copy that is out of the layout.
//
// Bug two, and the one that looked random: `scrollWidth` is a whole number. A
// line whose true width is 88.4 reports 88, the island was sized 0.4 px short,
// and because the text element ellipsises on *any* overflow, "19,15 ₽" came out
// as "19,15…" — for some values and not others, since the fraction changes with
// the digits.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const island = readFileSync(new URL("../src/island/island.ts", import.meta.url), "utf8");
const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

test("the closed island's text is measured off-screen, not in its own window", () => {
  const start = island.indexOf("private measureClosedText");
  const method = island.slice(start, island.indexOf("\n  }", start));
  assert.match(method, /this\.closedMeasure\.getBoundingClientRect\(\)\.width/, "the copy is what gets measured");
  assert.doesNotMatch(method, /this\.closedText\./, "measuring the real element cannot work");
  // scrollWidth rounds to a whole pixel; the rounding is what cut the line.
  assert.doesNotMatch(method, /scrollWidth/, "scrollWidth loses the fraction");
  // And the island really does size itself from it.
  assert.match(island, /const textWidth = content \? this\.measureClosedText\(\) : 0/);
});

test("a line that is a fraction of a pixel too wide still fits", async () => {
  const { closedWidth, CLOSED_PAD, CLOSED_SLACK } = await import("../src/core/closed.ts");
  // Every case that used to be cut: the true width has a fraction, and rounding
  // it down is what made the island short.
  for (const trueWidth of [88.4, 78.2, 96.55, 120.01, 99.9]) {
    const islandWidth = closedWidth(trueWidth, 0);
    const needed = trueWidth + CLOSED_PAD * 2;
    assert.ok(
      islandWidth >= needed,
      `${trueWidth} px of text needs ${needed.toFixed(2)} px of island, got ${islandWidth}`,
    );
  }
  assert.equal(CLOSED_SLACK > 0, true, "there is slack to cover the rounding");
});

test("the width is still capped, so a long song title does not run across the screen", async () => {
  const { closedWidth, CLOSED_MAX_W } = await import("../src/core/closed.ts");
  assert.equal(closedWidth(900, 0), CLOSED_MAX_W, "a very long line stops at the cap");
});

test("no layout means no width: an unmeasurable copy must not be committed", () => {
  // The other way the island came out too small: the copy has no layout yet
  // (a hidden or detached ancestor) and reports 0. `closedWidth(0)` is the
  // minimum, and with the key committed the island would keep that minimum
  // until the line happened to change.
  const block = island.slice(island.indexOf("const textWidth = content ? this.measureClosedText()"));
  const body = block.slice(0, block.indexOf("const w = closedWidth"));
  assert.match(body, /if \(content && !\(textWidth > 0\)\)/, "a zero measurement is caught");
  assert.match(body, /return;/, "and nothing is committed");
  // The key must be committed after the check, not before it.
  const keyAt = island.indexOf("this.closedKey = key;");
  const checkAt = island.indexOf("if (content && !(textWidth > 0))");
  assert.ok(checkAt < keyAt, "the key is set only once the measurement is usable");
});

test("the zero case is real: closedWidth(0) is the minimum, not the text", async () => {
  const { closedWidth, CLOSED_MIN_W } = await import("../src/core/closed.ts");
  assert.equal(closedWidth(0, 0), CLOSED_MIN_W, "0 measures as the minimum island");
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
