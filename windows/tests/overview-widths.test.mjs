// The overview's two columns: fixed pills, and a card that takes the rest.
//
// The bug this guards: a fixed 322-pixel card with a two-wide grid left a wide
// empty strip whenever fewer than two pills were running. The first fix made the
// pill column stretch instead, which turned the card into the narrow one — a
// 268-pixel card beside 420-pixel pills, so the dialog's name and its model were
// cut while the list had room to spare. The rule that holds is the opposite: a
// pill is a fixed-size list row, and the card is what grows.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { EXPANDED_W, OVERVIEW_W, PANEL_W, VIEW_LAYOUTS } from "../src/core/layout.ts";

const css = readFileSync(new URL("../src/style.css", import.meta.url), "utf8");

/** One CSS rule's body, with comments stripped. */
function rule(selector) {
  // Anchored at a line start: `.pills {` also occurs inside
  // `.overview.one-col .pills {`, and finding that one would test the wrong rule.
  const at = css.search(new RegExp(`^${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} \\{`, "m"));
  assert.ok(at >= 0, `no rule for ${selector}`);
  const body = css.slice(at + selector.length + 2);
  return body.slice(0, body.indexOf("}")).replace(/\/\*[\s\S]*?\*\//g, "");
}

test("the card is the column that grows, and the pills are the one that does not", () => {
  const left = rule(".overview > .left");
  const right = rule(".overview > .right");
  assert.match(left, /flex: 1 1 auto/, "the card takes the free space");
  assert.doesNotMatch(left, /width: 322px/, "a fixed card is what left the empty strip");
  assert.match(right, /flex: 0 0 auto/, "the pill column is sized by its content");
});

test("a pill is a fixed size, in both layouts", () => {
  const pills = rule(".pills");
  assert.match(pills, /grid-template-columns: repeat\(2, 134px\)/, "two fixed columns");
  assert.doesNotMatch(pills, /1fr/, "a stretching column is what made the card narrow");
  assert.match(rule(".overview.one-col .pills"), /174px/, "one column, wider pill");
  assert.match(rule(".overview.two-col .pills"), /repeat\(2, 134px\)/, "two columns");
});

test("the card ends up 75 pixels wider in the two-column layout", () => {
  // The arithmetic that has to hold, because it is what the widening was for:
  // the island grew by 75, and the pills in two columns must still cost what they
  // cost before (288), so all of the growth reaches the card.
  const ISLAND = OVERVIEW_W;
  const CONTENT_PADDING = 20; // #content: 10 left + 10 right
  const COLUMN_GAP = 10; // .overview gap
  const PILL_PADDING = 16; // .pills: 8 + 8
  const PILL_GAP = 4;
  const pills = 2 * 134 + PILL_GAP + PILL_PADDING;
  const card = ISLAND - CONTENT_PADDING - pills - COLUMN_GAP;
  assert.equal(pills, 288, "the pills cost what they cost before");
  assert.equal(card, 397, "which is the 322 the card had, plus 75");
});

test("nothing to list means no column at all", () => {
  assert.match(rule(".overview.wide > .right"), /display: none/, "the empty column goes away");
});

test("the pill column is a box, not a second card around the pills", () => {
  // The frame that was there: a `.card` with 20-pixel corners and hidden
  // overflow, holding 14-pixel pills inset by 8 — two curves 8 pixels apart,
  // neither concentric (the inner one should be 20 − 8 = 12). And the hidden
  // overflow cut the glow a hovered pill casts, ending the highlight in a hard
  // edge. The column is now transparent and does not clip.
  const column = rule(".pill-column");
  assert.doesNotMatch(column, /border-radius/, "no second curve");
  assert.doesNotMatch(column, /overflow: hidden/, "the pill's glow must not be cut");
  assert.match(column, /overflow: visible/);
  // And the markup really is a plain div, not the `card()` helper.
  const views = readFileSync(new URL("../src/views/views.ts", import.meta.url), "utf8");
  assert.match(views, /const right = h\("div", \{ class: "pill-column" \}, pills\)/);
  assert.doesNotMatch(views, /const right = card\(null, pills\)/, "the card is gone");
});

test("the island is 75 pixels wider, and only the overview asks for it", () => {
  // With four or more pills the card was squeezed to 322 pixels and its own
  // dialog name and model no longer fitted.
  assert.equal(OVERVIEW_W, EXPANDED_W + 75, "the overview is the standard width plus 75");
  assert.ok(PANEL_W >= OVERVIEW_W, "the window fits the widest island");
  assert.equal(VIEW_LAYOUTS.overview.width, OVERVIEW_W, "the overview asks for it");
  // Every other card was laid out for the standard width; stretching them would
  // leave a strip of nothing on the right.
  const stretched = Object.entries(VIEW_LAYOUTS)
    .filter(([, layout]) => layout.width != null)
    .map(([name]) => name);
  assert.deepEqual(stretched, ["overview"], "no other view changes width");
});

test("the overview is tall enough for three rows of pills", () => {
  // Two columns of pills is three rows: 3 × 36 plus two 4-pixel gaps = 116. The
  // card gets the island's height less the content padding (8 + 10) and the
  // header (34), and at the Mac's 160 that was 108 — the third row was cut off
  // by the island's own edge, which is what the screenshot showed.
  const ROW_H = 36;
  const GAP = 4;
  const rows = 3;
  const needed = rows * ROW_H + (rows - 1) * GAP;
  const card = VIEW_LAYOUTS.overview.height - 18 - 34;
  assert.ok(card >= needed, `the card has ${card}px and the rows need ${needed}px`);
});

test("the card's name, model and now-line all fit in the wider card", () => {
  // The three things the narrow card cut. They are the card's content, not the
  // pill's, so the width has to come from the card's own layout.
  const who = rule(".who.stacked");
  assert.match(who, /padding: 0 18px 0 108px/, "the name starts beside the Mochi");
  const saying = rule(".card-body .saying");
  assert.match(saying, /margin: 5px 18px 0 108px/, "and so does the sentence");
});
