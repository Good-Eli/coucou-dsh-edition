// Today's PlusVibeAPI spend, as the island shows it.
//
// The number is the provider's, never computed here: the bridge reads it and
// this file only decides how it reads on a 24-pixel island and in the settings.
// What it must never do is invent a zero for a day nobody reported, or keep
// showing yesterday's total as today's.

import { test } from "node:test";
import assert from "node:assert/strict";

import { compactTokens, rubles, usageLine } from "../src/core/dsh.ts";
import { closedContent, closedIsland, CLOSED_ISLANDS } from "../src/core/closed.ts";
import { compactIslandMode } from "../src/core/state.ts";

const NOW = new Date(2026, 10, 16, 14, 5, 0);
const TODAY = "2026-11-16";

test("tokens read short enough for a 24-pixel island", () => {
  assert.equal(compactTokens(0), "0");
  assert.equal(compactTokens(999), "999");
  assert.equal(compactTokens(8_400), "8,4K");
  assert.equal(compactTokens(55_300_000), "55,3M");
  // A round number does not grow a pointless decimal.
  assert.equal(compactTokens(55_000_000), "55M");
  assert.equal(compactTokens(1_200_000), "1,2M");
});

test("roubles keep the kopecks, and a tiny charge is not rounded away", () => {
  assert.equal(rubles(0), "0 ₽");
  assert.equal(rubles(33.41), "33,41 ₽");
  assert.equal(rubles(1234.5), "1234,50 ₽");
  // A day with one short request must not read as a free day.
  assert.equal(rubles(0.004), "<0,01 ₽");
});

test("the line is the shape that was asked for", () => {
  assert.equal(usageLine({ tokens: 55_300_000, rub: 33.41, day: TODAY }, NOW), "55,3M / 33,41 ₽");
});

test("no report is not a zero", () => {
  assert.equal(usageLine(null, NOW), null, "nothing was read: nothing is shown");
  assert.equal(usageLine(undefined, NOW), null);
});

test("yesterday's total is dropped, not shown as today's", () => {
  assert.equal(usageLine({ tokens: 55_300_000, rub: 33.41, day: "2026-11-15" }, NOW), null);
  // A total with no day at all is still today's by construction: the bridge
  // stamps it when it reads the account.
  assert.equal(usageLine({ tokens: 1000, rub: 1 }, NOW), "1K / 1,00 ₽");
});

test("the closed island offers the spend, and shows nothing without a figure", () => {
  assert.ok(CLOSED_ISLANDS.includes("usage"), "the setting can pick it");
  assert.equal(closedIsland("usage"), "usage");
  const content = closedContent("usage", {
    now: NOW,
    planUsage: null,
    usage: "55,3M / 33,41 ₽",
    music: null,
  });
  assert.equal(content?.text, "55,3M / 33,41 ₽");
  // No date, no clock beside it: that was the point of the setting.
  assert.doesNotMatch(content?.text ?? "", /\d{1,2}:\d{2}/);
  assert.equal(content?.note, false);

  const empty = closedContent("usage", { now: NOW, planUsage: null, usage: null, music: null });
  assert.equal(empty, null, "an unanswered provider leaves the island's empty shape");
});

test("the compact island's middle reads the old clock switch as a value", () => {
  // A file written before this setting existed has "" and a boolean.
  assert.equal(compactIslandMode({ compactIsland: "", showClock: true }), "clock");
  assert.equal(compactIslandMode({ compactIsland: "", showClock: false }), "none");
  // Once the new field is written it wins, whatever the old switch says.
  assert.equal(compactIslandMode({ compactIsland: "usage", showClock: true }), "usage");
  assert.equal(compactIslandMode({ compactIsland: "clock", showClock: false }), "clock");
  // A value this build does not know falls back rather than breaking the island.
  assert.equal(compactIslandMode({ compactIsland: "nonsense", showClock: true }), "clock");
});
