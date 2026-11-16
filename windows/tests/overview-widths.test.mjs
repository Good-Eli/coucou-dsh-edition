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
  assert.match(pills, /grid-template-columns: repeat\(2, 174px\)/, "two fixed columns");
  assert.doesNotMatch(pills, /1fr/, "a stretching column is what made the card narrow");
  assert.match(rule(".overview.one-col .pills"), /174px/, "one column, same pill width");
});

test("nothing to list means no column at all", () => {
  assert.match(rule(".overview.wide > .right"), /display: none/, "the empty column goes away");
});

test("the card's name, model and now-line all fit in the wider card", () => {
  // The three things the narrow card cut. They are the card's content, not the
  // pill's, so the width has to come from the card's own layout.
  const who = rule(".who.stacked");
  assert.match(who, /padding: 0 18px 0 108px/, "the name starts beside the Mochi");
  const saying = rule(".card-body .saying");
  assert.match(saying, /margin: 5px 18px 0 108px/, "and so does the sentence");
});
