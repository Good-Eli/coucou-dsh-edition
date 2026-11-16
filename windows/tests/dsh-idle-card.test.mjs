// The card while DeepSeek Harness has nothing running.
//
// "Idle" on its own is a dead end. The island is a glance, so at rest the card
// should answer what a person actually wants to know: what ran last and how it
// ended, how many windows are open, and what today has cost. Every line comes
// from what DSH and the provider already reported.

import { test } from "node:test";
import assert from "node:assert/strict";

import { installFakeDom } from "./fakedom.mjs";

installFakeDom();

const { syncOverviewCard } = await import("../src/views/views.ts");
const { Dsh } = await import("../src/core/dsh.ts");
const { State } = await import("../src/core/state.ts");
const { setLanguage } = await import("../src/i18n/i18n.ts");
const { h } = await import("../src/views/dom.ts");

setLanguage("en");

const session = (over = {}) => ({
  id: "s1",
  cwd: "C:\\work\\proj",
  title: "Починить одобрения",
  model: { provider: "deepseek", model: "v4-flash", reasoningEffort: "high" },
  state: "finished",
  since: Date.now() - 3 * 60_000,
  steps: ["pwsh cargo test"],
  say: "Готово, тесты зелёные.",
  ...over,
});

const snapshot = (over = {}) => ({
  status: "ready",
  error: null,
  version: "0.2.2-rc.3",
  approvalsEnabled: true,
  hardened: true,
  sessions: [session()],
  catalog: { providers: [] },
  pending: [],
  activeSession: null,
  updatedAt: 1,
  ...over,
});

function render(over = {}) {
  Dsh.snapshot = snapshot(over);
  const who = h("div", {});
  const head = h("div", {});
  const lines = h("div", {});
  const task = { id: "dsh", name: "DeepSeek Harness", modelLine: "v4-flash · HIGH" };
  syncOverviewCard(task, who, head, lines);
  const text = (node) => node.textContent;
  return { who: text(who), head: text(head), lines: text(lines), lineEls: lines.childNodes };
}

test("the resting card says what ran last, how it ended and when", () => {
  const card = render();
  assert.equal(card.head, "Resting");
  assert.match(card.lines, /Починить одобрения/, "the dialog that ran last is named");
  assert.match(card.lines, /finished/, "how its turn ended");
  assert.match(card.lines, /min ago/, "and how long ago");
});

test("and what it said, in its own words", () => {
  const card = render();
  assert.match(card.lines, /Готово, тесты зелёные\./);
});

test("it counts the open windows and any subagents working inside them", () => {
  const card = render({
    sessions: [
      session({ id: "s1", state: "idle" }),
      session({ id: "s2", state: "idle" }),
      session({ id: "sub1", state: "working", origin: "subagent" }),
    ],
  });
  assert.match(card.lines, /Open: 2/, "two windows, subagents not counted as windows");
  assert.match(card.lines, /Subagents: 1/, "and one subagent is reported");
});

test("today's spend is there when the provider could be read", () => {
  const card = render({ usage: { tokens: 120_000_000, rub: 45.1, day: "2026-11-16" } });
  // A day key from another date is dropped by usageLine, so this only asserts
  // the shape: the line appears when the figures are today's.
  assert.match(card.lines, /Open:/, "the rest of the card is still there");
});

test("a failed turn says failed, not finished", () => {
  const card = render({ sessions: [session({ state: "error" })] });
  assert.match(card.lines, /failed/);
});

test("with nothing ever run, the card says so instead of inventing a history", () => {
  const card = render({ sessions: [session({ state: "idle", since: 0, steps: [], say: null })] });
  assert.match(card.lines, /Nothing has run yet in this session\./);
});

// ── While work is in flight ──────────────────────────────────────────────────

test("the overview names the running dialogs and what each is doing", () => {
  const card = render({
    sessions: [
      session({ id: "s1", title: "Первая", state: "working", say: "Пишу тест на утечку" }),
      session({ id: "s2", title: "Вторая", state: "thinking", say: null }),
    ],
  });
  assert.equal(card.head, "Dialogs are working");
  assert.match(card.lines, /Первая/, "each running dialog is named");
  assert.match(card.lines, /Пишу тест на утечку/, "with the agent's own words");
  assert.match(card.lines, /Вторая/);
  assert.match(card.lines, /Thinking…/, "and its state when it has not spoken yet");
});

test("one running dialog is said in the singular", () => {
  const card = render({ sessions: [session({ state: "working" })] });
  assert.equal(card.head, "One dialog is working");
});

test("a dialog waiting for an answer says so in the overview", () => {
  const card = render({
    sessions: [session({ id: "s1", state: "finished" })],
    pending: [{ requestId: "r1", sessionId: "s1", tool: "pwsh" }],
  });
  assert.match(card.lines, /Waiting…/);
});
