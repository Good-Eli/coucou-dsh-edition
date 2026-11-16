// The colours a dialog's Mochi may wear, and the rows of an empty ticker.
//
// Two things the screenshots showed: a handful of dialogs all came out blue and
// pink, and a card with no steps yet drew "…" twice. Both are cheap to get wrong
// and cheap to keep wrong, so both are pinned here.

import { test } from "node:test";
import assert from "node:assert/strict";

import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { sessionColor } = await import("../src/core/dsh.ts");
const { Ticker } = await import("../src/views/ticker.ts");

/** Hue of a `#rrggbb` colour, in degrees. */
function hue(hex) {
  const v = parseInt(hex.replace("#", ""), 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return 0;
  let h;
  if (max === r) h = ((g - b) / d) % 6;
  else if (max === g) h = (b - r) / d + 2;
  else h = (r - g) / d + 4;
  return ((h * 60) % 360 + 360) % 360;
}

/** Saturation, 0..1 — a grey has no hue worth spreading. */
function saturation(hex) {
  const v = parseInt(hex.replace("#", ""), 16);
  const r = ((v >> 16) & 255) / 255;
  const g = ((v >> 8) & 255) / 255;
  const b = (v & 255) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return max === 0 ? 0 : (max - min) / max;
}

/** The palette, as the id→colour function actually uses it. */
function palette() {
  const seen = new Map();
  for (let i = 0; i < 5000; i += 1) {
    const id = `session-${i.toString(16).padStart(8, "0")}-0000-0000-0000-000000000000`;
    const colour = sessionColor(id);
    if (!seen.has(colour)) seen.set(colour, id);
  }
  return [...seen.keys()];
}

test("the palette is spread around the colour wheel, not two blues and two pinks", () => {
  const colours = palette();
  assert.ok(colours.length >= 10, `the palette is used, saw ${colours.length} tones`);
  const hues = colours.map(hue).sort((a, b) => a - b);
  // No two tones may be a near-repeat: the old palette had #F472B6 and #FB7185
  // (12° apart) and two blues (about 20° apart), which is why everything looked
  // blue and pink.
  for (let i = 1; i < hues.length; i += 1) {
    const gap = hues[i] - hues[i - 1];
    assert.ok(gap >= 20, `hues ${hues[i - 1]} and ${hues[i]} are ${gap}° apart, too close`);
  }
  // Wrapping around the wheel counts too.
  const wrap = 360 - hues.at(-1) + hues[0];
  assert.ok(wrap >= 20, `the wrap-around gap is ${wrap}°, too close`);
  // And they really do cover the wheel rather than one quadrant.
  assert.ok(hues.at(-1) - hues[0] > 240, `the palette spans ${hues.at(-1) - hues[0]}°`);
});

test("every tone is readable on the dark card", () => {
  for (const colour of palette()) {
    assert.ok(saturation(colour) > 0.3, `${colour} is nearly grey`);
    const v = parseInt(colour.replace("#", ""), 16);
    const r = (v >> 16) & 255;
    const g = (v >> 8) & 255;
    const b = v & 255;
    // A 24-pixel body on a near-black card: too dark a tone disappears.
    const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
    assert.ok(luma > 0.35, `${colour} is too dark for the card (luma ${luma.toFixed(2)})`);
  }
});

test("the same dialog keeps its colour, and the palette is used evenly", () => {
  assert.equal(sessionColor("session-abc"), sessionColor("session-abc"));
  const counts = new Map();
  for (let i = 0; i < 3000; i += 1) {
    const colour = sessionColor(`session-${i}-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`);
    counts.set(colour, (counts.get(colour) ?? 0) + 1);
  }
  // A hash that leans on one tone would make the list monochrome again.
  const expected = 3000 / counts.size;
  for (const [colour, n] of counts) {
    assert.ok(
      n > expected * 0.6 && n < expected * 1.4,
      `${colour} was picked ${n} times, expected about ${expected.toFixed(0)}`,
    );
  }
});

// ── The empty ticker ─────────────────────────────────────────────────────────

const rowText = (ticker) => {
  const out = [];
  const walk = (node) => {
    if (node.classList?.contains("ticker-row")) {
      out.push({ text: node.textContent, empty: node.classList.contains("empty") });
    }
    for (const child of node.childNodes ?? []) walk(child);
  };
  walk(ticker.el);
  return out;
};

test("a ticker with no steps draws nothing, not two ellipses", () => {
  const ticker = new Ticker(() => {});
  ticker.sync({ id: "dsh", state: "working", steps: [], stepSeq: 0 });
  const rows = rowText(ticker);
  assert.ok(rows.length >= 2, "the rows exist to hold the next steps");
  for (const row of rows) {
    assert.equal(row.text, "", `a row with no step must be empty, saw "${row.text}"`);
    assert.equal(row.empty, true, "and hidden, so it takes no space");
  }
});

test("a ticker with steps shows them and nothing else", () => {
  const ticker = new Ticker(() => {});
  ticker.sync({ id: "dsh", state: "working", steps: ["pwsh cargo test"], stepSeq: 1 });
  const rows = rowText(ticker);
  const shown = rows.filter((r) => !r.empty);
  assert.equal(shown.length, 1, "one step, one row");
  // The row holds two copies of the text — the shimmering one and the dim one it
  // crossfades into — so the row's text is the step twice over, not once.
  assert.match(shown[0].text, /pwsh cargo test/);
});
