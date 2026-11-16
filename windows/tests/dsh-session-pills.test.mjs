// One pill per open DeepSeek Harness dialog.
//
// The tool's own pill is the dialog the card is about; these are the others. The
// rules that matter: a pill never appears for a dialog that has done nothing, a
// pill is never taken away while its dialog is waiting for an answer, and the
// list on the right stays short enough to read.

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DSH_SESSION_PREFIX,
  dshSessionPillId,
  isDshPill,
  syncTask,
} from "../src/island/dsh.ts";
import { State } from "../src/core/state.ts";
import { Dsh } from "../src/core/dsh.ts";
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

test.beforeEach(() => {
  State.tasks = [];
  State.focusId = null;
  Dsh.snapshot = null;
});

test("a second dialog gets its own pill, named after the dialog", () => {
  const tasks = apply({
    sessions: [session({ id: "s1" }), session({ id: "s2", title: "Другой диалог", state: "working" })],
  });
  // The tool's own pill is the active dialog (the busiest one).
  assert.ok(tasks.find((t) => t.id === "dsh"), "the tool keeps its pill");
  const pills = sessionPills();
  assert.equal(pills.length, 1, "the other dialog has one of its own");
  assert.equal(pills[0].id, dshSessionPillId(pills[0].sessionId));
  assert.equal(pills[0].isDshSession, true);
});

test("a dialog that never started a turn gets no pill", () => {
  apply({
    sessions: [
      session({ id: "s1" }),
      session({ id: "s2", state: "idle", steps: [], stepSeq: 0 }),
    ],
  });
  assert.equal(sessionPills().length, 0, "nothing to explain, so nothing to show");
});

test("a dialog waiting for an answer keeps its pill", () => {
  const tasks = apply({
    sessions: [
      session({ id: "s1" }),
      session({ id: "s2", state: "finished", since: Date.now() - 60 * 60_000 }),
    ],
    pending: [{ requestId: "r1", sessionId: "s2", tool: "pwsh" }],
  });
  const pill = sessionPills().find((t) => t.sessionId === "s2");
  assert.ok(pill, "a waiting dialog is always reachable");
  assert.equal(pill.pillBadge, "approval", "and it says why");
  void tasks;
});

test("a dialog that stopped long ago loses its pill", () => {
  apply({
    sessions: [
      session({ id: "s1" }),
      session({ id: "s2", state: "finished", since: Date.now() - 11 * 60_000 }),
    ],
  });
  assert.equal(sessionPills().length, 0, "ten minutes is no longer 'active'");
});

test("the dialog list stays short: three pills at most, working ones first", () => {
  apply({
    sessions: [
      session({ id: "s0", state: "working" }),
      session({ id: "s1", state: "thinking" }),
      session({ id: "s2", state: "working" }),
      session({ id: "s3", state: "working" }),
      session({ id: "s4", state: "working" }),
    ],
  });
  const pills = sessionPills();
  assert.equal(pills.length, 3, "the right-hand list is four slots wide");
  // The tool's own pill holds one slot; the rest go to dialogs that work.
  assert.ok(pills.every((p) => p.state === "working" || p.state === "thinking"));
});

test("the bridge going away takes every dialog pill with it", () => {
  apply({
    sessions: [session({ id: "s1" }), session({ id: "s2", state: "working" })],
  });
  assert.ok(sessionPills().length > 0, "there were pills");
  Dsh.snapshot = snapshot({ status: "off", sessions: [] });
  syncTask();
  assert.equal(sessionPills().length, 0, "no bridge, no dialogs");
});

test("a dialog's pill carries its own sentence, not the focused dialog's", () => {
  apply({
    sessions: [
      session({ id: "s1", say: "Проверю сборку" }),
      session({ id: "s2", state: "working", say: "Добавлю тест на утечку" }),
    ],
  });
  const pill = sessionPills().find((t) => t.sessionId === "s2");
  assert.equal(pill.sayLine, "Добавлю тест на утечку");
});

test("a dialog pill is a DSH pill, and any other id is not", () => {
  assert.ok(isDshPill("dsh"));
  assert.ok(isDshPill(dshSessionPillId("abc")));
  assert.equal(isDshPill("agent_codex"), false);
  assert.equal(isDshPill("integration_claude"), false);
});
