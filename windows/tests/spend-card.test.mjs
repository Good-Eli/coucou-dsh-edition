// The spend card as it renders: three periods, the provider's numbers, and the
// states between "asking" and "there are none".
//
// A card that shows 0 ₽ while it waits, or after the provider refused, is a lie
// about a real account: those two states have to look different from a zero.

import { test } from "node:test";
import assert from "node:assert/strict";

import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { buildSpend, averagePerDay } = await import("../src/views/spend.ts");
const { Spend } = await import("../src/island/dsh.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");

setLanguage("en");

const actions = { blip() {}, setView() {}, openSettingsWindow() {} };

const stats = {
  day: { tokens: 1_200_000, rub: 12.5, requests: 40 },
  week: { tokens: 9_000_000, rub: 95.5, requests: 300 },
  month: { tokens: 90_000_000, rub: 955, requests: 3000 },
  since: { day: "2026-11-16", week: "2026-11-10", month: "2026-11-01" },
  truncated: false,
};

/** Every piece of text in the card, in order. */
function texts(el) {
  const out = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.nodeType === 3) out.push(child.data);
      else {
        if (child.tagName === "BUTTON" && child.attributes.get("text")) out.push(child.attributes.get("text"));
        walk(child);
      }
    }
  };
  walk(el);
  return out;
}

const card = () => {
  const view = buildSpend(actions);
  view.sync();
  return view;
};

test.beforeEach(() => {
  Spend.stats = null;
  Spend.loading = false;
  Spend.error = null;
  Spend.period = "day";
});

test("the card shows the provider's roubles, tokens and requests", () => {
  Spend.stats = stats;
  const view = card();
  const shown = texts(view.el).join(" | ");
  assert.match(shown, /12,50 ₽/, "today's roubles, with kopecks");
  assert.match(shown, /1,2M/, "today's tokens, short enough for the card");
  assert.match(shown, /40/, "today's requests");
});

test("all three periods are on one page, with no switching", () => {
  Spend.stats = stats;
  const view = card();
  const shown = texts(view.el).join(" | ");
  // One page: today, the week and the month are all there at once. Switching
  // between them would hide two thirds of the answer, which is the opposite of
  // what a glance is for.
  assert.match(shown, /12,50 ₽/, "today");
  assert.match(shown, /95,50 ₽/, "the week");
  assert.match(shown, /955,00 ₽/, "the month");
  const buttons = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName === "BUTTON") buttons.push(child);
      walk(child);
    }
  };
  walk(view.el);
  const labels = buttons.map((b) => b.textContent.trim());
  assert.deepEqual(labels, ["Refresh"], `only Refresh is a button, saw: ${labels.join(", ")}`);
});

test("while the figures are on their way, the card says so and shows no zero", () => {
  Spend.loading = true;
  const view = card();
  const shown = texts(view.el).join(" | ");
  assert.match(shown, /Reading the provider's records/);
  assert.doesNotMatch(shown, /₽/, "no rouble figure is invented while waiting");
});

test("a provider that could not be read says why, and still shows no zero", () => {
  Spend.error = "the usage API answered 401";
  const view = card();
  const shown = texts(view.el).join(" | ");
  assert.match(shown, /401/);
  assert.doesNotMatch(shown, /0 ₽/, "an unread account is not a free one");
});

test("the card names its source, so a figure can be checked", () => {
  Spend.stats = stats;
  const view = card();
  const shown = texts(view.el).join(" | ");
  assert.match(shown, /PlusVibeAPI's own records/);
});

test("a figure is labelled, never declined: the number does not bend the noun", () => {
  Spend.stats = stats;
  const view = card();
  const shown = texts(view.el).join(" | ");
  // "291,9M токены" is wrong Russian; "Токены 291,9M" is right for every number
  // and every language. The label comes from the dictionary, the figure after it.
  assert.match(shown, /Tokens \| 1,2M/, "the label, then the figure");
  assert.match(shown, /Requests \| 40/, "the same for requests");
  assert.doesNotMatch(shown, /1,2M tokens/i, "the noun is not glued to the number");
});

test("the window is a date a person reads, not an ISO string", () => {
  Spend.stats = { ...stats, since: { day: "2026-11-16", week: "2026-11-10", month: "2026-11-01" } };
  const view = card();
  const shown = texts(view.el).join(" | ");
  assert.doesNotMatch(shown, /2026-11-16/, "no raw day key on the card");
  assert.match(shown, /Nov 16|16 Nov|16\.11/, `a formatted date, saw: ${shown}`);
});

test("the month is also said per day, so a figure can be judged", () => {
  Spend.stats = stats;
  const view = card();
  const shown = texts(view.el).join(" | ");
  // The three totals say what was spent; the average says whether that is a lot.
  assert.match(shown, /Average per day: \d+,\d\d ₽/, `saw: ${shown}`);
});

test("the average divides the month by the days it covers", () => {
  // Fixed dates, so the figure is the same on every run: 330 ₽ over the 1st to
  // the 11th of November is 30 ₽ a day — eleven days, both ends counted.
  const fixed = {
    ...stats,
    month: { tokens: 1, rub: 330, requests: 1 },
    since: { day: "2026-11-11", week: "2026-11-05", month: "2026-11-01" },
  };
  assert.equal(averagePerDay(fixed, new Date("2026-11-11T12:00:00")), 30);
  // A window that has only just opened divides by one, not by zero.
  assert.equal(
    averagePerDay({ ...fixed, since: { ...fixed.since, month: "2026-11-11" } }, new Date("2026-11-11T12:00:00")),
    330,
  );
});

test("no average is invented for a month with no spend", () => {
  Spend.stats = {
    ...stats,
    month: { tokens: 0, rub: 0, requests: 0 },
  };
  const view = card();
  const shown = texts(view.el).join(" | ");
  assert.doesNotMatch(shown, /Average per day/, "a zero average would be a claim nobody made");
});

test("opening the card is what asks for the figures", async () => {
  // A background poll of a month of history would spend the account's requests
  // on a card nobody opened, so the read starts with the card.
  const { Spend: live, refreshSpend } = await import("../src/island/dsh.ts");
  live.stats = null;
  live.loading = false;
  const asked = [];
  const original = globalThis.__dshSpendCalls;
  globalThis.__dshSpendCalls = asked;
  try {
    refreshSpend();
    assert.equal(live.loading, true, "the card says it is reading");
    // The call itself goes through the bridge, which is not present here; what
    // matters is that asking twice does not start a second read.
    refreshSpend();
    assert.equal(asked.length, 0);
  } finally {
    globalThis.__dshSpendCalls = original;
    live.loading = false;
  }
});
