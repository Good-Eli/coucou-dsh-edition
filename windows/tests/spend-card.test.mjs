// The spend card as it renders: three periods, the provider's numbers, and the
// states between "asking" and "there are none".
//
// A card that shows 0 ₽ while it waits, or after the provider refused, is a lie
// about a real account: those two states have to look different from a zero.

import { test } from "node:test";
import assert from "node:assert/strict";

import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { buildSpend } = await import("../src/views/spend.ts");
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

test("switching the period shows that period's figures", () => {
  Spend.stats = stats;
  const view = card();
  Spend.period = "month";
  view.sync();
  const shown = texts(view.el).join(" | ");
  assert.match(shown, /955,00 ₽/, "the month's roubles");
  assert.match(shown, /90M/, "the month's tokens");
  assert.match(shown, /3[,\s]?000/, "the month's requests");
  assert.match(shown, /2026-11-01/, "and the day the window starts");
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

test("a period tab switches what the card shows", () => {
  Spend.stats = stats;
  const view = card();
  const buttons = [];
  const walk = (node) => {
    for (const child of node.childNodes ?? []) {
      if (child.tagName === "BUTTON") buttons.push(child);
      walk(child);
    }
  };
  walk(view.el);
  // A button's label is its own text content, not an attribute.
  const month = buttons.find((b) => b.textContent.trim() === "Month");
  assert.ok(month, `the card offers the month, saw: ${buttons.map((b) => b.textContent).join(", ")}`);
  month.fire("click");
  assert.equal(Spend.period, "month", "clicking the tab changes the period");
  view.sync();
  assert.match(texts(view.el).join(" | "), /955,00 ₽/, "and the card follows");
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
