// The island's pills while DeepSeek Harness works.
//
// The rule this file pins down is one sentence: one pill per busy dialog, and
// none at all when nothing is busy. "Busy" is working, thinking, or waiting for
// an answer — the states a person can act on. Subagents never get a pill: DSH
// opens them for itself inside one turn, so a pill for one would appear and
// vanish mid-answer for no reason the person can see.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DSH_SESSION_PREFIX,
  dshSessionPillId,
  isDshPill,
  syncTask,
} from "../src/island/dsh.ts";
import { State } from "../src/core/state.ts";
import { Dsh, busyDialogs, idleSummary, isSubagent } from "../src/core/dsh.ts";
import { setLanguage } from "../src/i18n/i18n.ts";

setLanguage("en");

const session = (over = {}) => ({
  id: "s1",
  cwd: "C:\\work\\proj",
  title: "Проект: Coucou DSH Edition",
  model: { provider: "deepseek", model: "v4-flash", reasoningEffort: "high" },
  state: "working",
  since: Date.now(),
  steps: ["pwsh cargo test"],
  stepSeq: 1,
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

function apply(over = {}) {
  Dsh.snapshot = snapshot(over);
  syncTask();
  return State.tasks;
}

const sessionPills = () => State.tasks.filter((t) => t.id.startsWith(DSH_SESSION_PREFIX));
const toolPill = () => State.tasks.find((t) => t.id === "dsh");

test.beforeEach(() => {
  State.tasks = [];
  State.focusId = null;
  Dsh.snapshot = null;
});

test("nothing running: no dialog pills, and the tool's pill rests", () => {
  const tasks = apply({ sessions: [session({ state: "idle", steps: [], stepSeq: 0 })] });
  assert.equal(sessionPills().length, 0, "an idle dialog gets no pill");
  const pill = tasks.find((t) => t.id === "dsh");
  assert.ok(pill, "the tool keeps its pill: resting is a state worth seeing");
  assert.equal(pill.idle, true);
  assert.equal(pill.state, "idle");
  assert.equal(pill.name, "DeepSeek Harness", "at rest the pill is the tool, not a dialog");
});

test("one busy dialog: one pill, named after the dialog", () => {
  apply({ sessions: [session({ id: "s1", state: "working" })] });
  const pills = sessionPills();
  assert.equal(pills.length, 1, "one dialog, one pill of its own");
  assert.equal(pills[0].sessionId, "s1");
  assert.match(pills[0].name, /^Проект: Coucou DSH/, "named after the dialog");
  // The tool's pill stays the tool's: the list keeps a fixed entry for DSH.
  assert.equal(toolPill().name, "DeepSeek Harness", "and the tool keeps its own name");
  assert.equal(toolPill().idle, false, "which shimmers while work is in flight");
});

test("two busy dialogs: one pill each", () => {
  apply({
    sessions: [
      session({ id: "s1", title: "Первая", state: "working" }),
      session({ id: "s2", title: "Вторая", state: "thinking" }),
    ],
  });
  const pills = sessionPills();
  assert.equal(pills.length, 2, "two dialogs, two pills");
  assert.deepEqual(pills.map((p) => p.sessionId).sort(), ["s1", "s2"]);
  assert.deepEqual(pills.map((p) => p.name).sort(), ["Вторая", "Первая"]);
});

test("three busy dialogs: three pills", () => {
  apply({
    sessions: [
      session({ id: "s1", title: "A", state: "working" }),
      session({ id: "s2", title: "B", state: "working" }),
      session({ id: "s3", title: "C", state: "working" }),
    ],
  });
  const ids = sessionPills().map((p) => p.sessionId);
  assert.deepEqual(ids.sort(), ["s1", "s2", "s3"], "three dialogs, three pills");
});

test("a dialog that stops working loses its pill at once", () => {
  apply({
    sessions: [
      session({ id: "s1", state: "working" }),
      session({ id: "s2", title: "Вторая", state: "working" }),
    ],
  });
  assert.equal(sessionPills().length, 2, "both had a pill while they worked");
  apply({
    sessions: [
      session({ id: "s1", state: "working" }),
      session({ id: "s2", title: "Вторая", state: "finished" }),
    ],
  });
  assert.deepEqual(
    sessionPills().map((p) => p.sessionId),
    ["s1"],
    "and the one that stopped loses it the moment its turn ends",
  );
});

test("a dialog waiting for an answer counts as busy, and says why", () => {
  apply({
    sessions: [
      session({ id: "s1", state: "working" }),
      session({ id: "s2", title: "Ждёт", state: "finished" }),
    ],
    pending: [{ requestId: "r1", sessionId: "s2", tool: "pwsh" }],
  });
  // Both have a pill: the one still working and the one that needs an answer.
  const waiting = sessionPills().find((p) => p.sessionId === "s2");
  assert.ok(waiting, "a dialog that needs you keeps its pill");
  assert.equal(waiting.pillBadge, "approval", "and says why");
  assert.ok(sessionPills().some((p) => p.sessionId === "s1"), "the working one keeps its own");
});

test("the busiest dialog leads the list: waiting, then working, then thinking", () => {
  apply({
    sessions: [
      session({ id: "s1", state: "thinking" }),
      session({ id: "s2", state: "working" }),
      session({ id: "s3", state: "working" }),
    ],
    pending: [{ requestId: "r1", sessionId: "s3", tool: "pwsh" }],
  });
  // The order is the order of the pills, so the one that needs you is first.
  assert.deepEqual(sessionPills().map((p) => p.sessionId), ["s3", "s2", "s1"]);
});

test("a subagent never gets a pill, and never takes one", () => {
  const sub = session({ id: "sub1", title: "subagent", state: "working", origin: "subagent" });
  const child = session({ id: "child1", title: "child", state: "working", parentSession: "s1" });
  assert.ok(isSubagent(sub));
  assert.ok(isSubagent(child));

  apply({ sessions: [session({ id: "s1", state: "working" }), sub, child] });
  assert.deepEqual(
    sessionPills().map((p) => p.sessionId),
    ["s1"],
    "only the dialog a person opened has a pill",
  );
});

test("only subagents running is still resting: nothing a person opened is working", () => {
  apply({
    sessions: [
      session({ id: "s1", state: "idle" }),
      session({ id: "sub1", state: "working", origin: "subagent" }),
    ],
  });
  assert.equal(toolPill().idle, true, "a subagent's work is its parent's turn");
  assert.equal(sessionPills().length, 0);
});

test("the busiest dialog leads: waiting, then working, then thinking", () => {
  const order = busyDialogs(
    snapshot({
      sessions: [
        session({ id: "s1", state: "thinking" }),
        session({ id: "s2", state: "working" }),
        session({ id: "s3", state: "working" }),
      ],
      pending: [{ requestId: "r1", sessionId: "s3", tool: "pwsh" }],
    }),
  );
  assert.deepEqual(order.map((s) => s.id), ["s3", "s2", "s1"]);
});

test("the bridge going away takes every pill with it", () => {
  apply({
    sessions: [session({ id: "s1" }), session({ id: "s2", title: "Вторая", state: "working" })],
  });
  assert.ok(sessionPills().length > 0, "there were pills");
  Dsh.snapshot = snapshot({ status: "off", sessions: [] });
  syncTask();
  assert.equal(sessionPills().length, 0, "no bridge, no dialogs");
});

test("the idle summary answers what a glance is for", () => {
  const last = session({
    id: "s1",
    title: "Починить одобрения",
    state: "finished",
    since: Date.now() - 3 * 60_000,
    say: "Готово, тесты зелёные.",
  });
  const summary = idleSummary(
    snapshot({
      sessions: [last, session({ id: "s2", state: "idle" })],
      usage: { tokens: 120_000_000, rub: 45.1, day: "x" },
    }),
  );
  assert.equal(summary.dialogs, 2, "both windows are counted");
  assert.equal(summary.subagents, 0);
  assert.equal(summary.lastTitle, "Починить одобрения", "what ran last is named");
  assert.equal(summary.lastState, "finished");
  assert.equal(summary.lastLine, "Готово, тесты зелёные.", "and what it said");
  assert.ok(summary.lastAt > 0, "with a time, so the card can say how long ago");
});

test("the idle summary counts running subagents without giving them a pill", () => {
  const summary = idleSummary(
    snapshot({
      sessions: [
        session({ id: "s1", state: "idle" }),
        session({ id: "sub1", state: "working", origin: "subagent" }),
        session({ id: "sub2", state: "thinking", parentSession: "s1" }),
      ],
    }),
  );
  assert.equal(summary.dialogs, 1, "one window the person opened");
  assert.equal(summary.subagents, 2, "two subagents working inside it");
});

test("a dialog pill is a DSH pill, and any other id is not", () => {
  assert.ok(isDshPill("dsh"));
  assert.ok(isDshPill(dshSessionPillId("abc")));
  assert.equal(isDshPill("agent_codex"), false);
  assert.equal(isDshPill("integration_claude"), false);
});
