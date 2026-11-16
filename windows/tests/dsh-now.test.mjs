// What the card says the agent is doing, and the spend card's figures.
//
// Both come from the host: the sentence is the agent's own, the numbers are
// PlusVibeAPI's. Nothing here may invent either — an empty card is honest, a
// made-up line or a zero nobody reported is not.

import { test } from "node:test";
import assert from "node:assert/strict";

import { nowLine } from "../src/views/views.ts";
import { rubles, compactTokens, usageLine } from "../src/core/dsh.ts";
import { setLanguage } from "../src/i18n/i18n.ts";

setLanguage("en");

const task = (over = {}) => ({
  id: "dsh",
  name: "DeepSeek Harness",
  color: "#4C8DFF",
  state: "working",
  stepIndex: 0,
  steps: [],
  stepSeq: 0,
  source: "agent",
  isIntegration: false,
  ...over,
});

test("the agent's own sentence is what the card shows as 'now'", () => {
  // The whole point of the change: a sentence about the work, not a shell
  // command cut at 40 characters.
  const line = nowLine(task({ sayLine: "Добавлю тест на утечку — иначе она вернётся" }));
  assert.equal(line, "Добавлю тест на утечку — иначе она вернётся");
});

test("without a sentence the state says what it can, and never a raw command", () => {
  assert.equal(nowLine(task({ state: "thinking" })), "Thinking…");
  // Working with a known last action: the state, not the action. The ticker
  // directly below already lists the actions, so repeating the last one here said
  // the same thing twice — and when DSH sent a tool with no title, what got
  // repeated was the bare tool name.
  assert.equal(nowLine(task({ state: "working", steps: ["pwsh cargo test"] })), "Working…");
  assert.equal(nowLine(task({ state: "working" })), "Working…");
  assert.equal(nowLine(task({ state: "error" })), "The turn failed");
  // A finished turn keeps its ticker, so the line above it would only repeat it.
  assert.equal(nowLine(task({ state: "finished", steps: ["pwsh cargo test"] })), null);
  assert.equal(nowLine(task({ state: "idle" })), null);
});

test("a bare tool name is never shown as what is happening", () => {
  // What the screenshot showed: the now-line read `todo_write`, and the ticker
  // repeated it one row below. That is the raw identifier this line replaced a
  // shell command with, which is not an improvement.
  const line = nowLine(task({ state: "working", steps: ["todo_write"] }));
  assert.equal(line, "Working…", "the state, never the tool's name");
  assert.doesNotMatch(line ?? "", /todo_write|_/, "no identifier reaches the card");
});

test("a sentence wins over the state, even while it is still being written", () => {
  const line = nowLine(task({ state: "thinking", sayLine: "Сейчас проверю" }));
  assert.equal(line, "Сейчас проверю", "the agent's words, not the state");
});

test("the spend card's figures are the provider's own", () => {
  assert.equal(rubles(95.5), "95,50 ₽");
  assert.equal(compactTokens(90_000), "90K");
  assert.equal(usageLine({ tokens: 1000, rub: 1.5, day: "2026-11-16" }, new Date(2026, 10, 16)), "1K / 1,50 ₽");
});
