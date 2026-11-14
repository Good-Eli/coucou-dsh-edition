// DeepSeek Harness as the main tool (src/core/pills.ts, src/island/dsh.ts).
//
// The main pill is the one that is always on and takes no slot. DSH used to be
// selectable only as a declared pill, which this build exists to avoid: the
// agent the island is for was the one thing it could not be about.
//
// The second half is the trap that came with it: `syncTask` used to delete the
// DSH pill whenever the bridge was not live. That is right for a pill that only
// exists while DSH is running, and wrong for the main tool, which must stay.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { clearReplies, emit } from "./tauri.mjs";
import { applyDsh, registerDshHandlers, resetDshApprovalMemory } from "../src/island/dsh.ts";
import { Dsh } from "../src/core/dsh.ts";
import { chooseMainPill, mainPillChoices, pillDefinition, sanitizeDeclared } from "../src/core/pills.ts";
import { State } from "../src/core/state.ts";
import { setLanguage } from "../src/i18n/i18n.ts";

const island = {
  alert: (view) => asked.push(`alert:${view}`),
  dropPin: () => asked.push("dropPin"),
  reveal: () => asked.push("reveal"),
  setView: (view) => asked.push(`setView:${view}`),
};
let asked = [];
registerDshHandlers(island);

const SESSION = { id: "s1", cwd: "C:\\work\\proj", title: "A task", state: "working", since: 1 };

const snapshot = (over = {}) => ({
  status: "ready",
  error: null,
  version: "0.2.2-rc.3",
  approvalsEnabled: true,
  hardened: true,
  sessions: [SESSION],
  catalog: { providers: [] },
  pending: [],
  activeSession: null,
  updatedAt: 1,
  ...over,
});

beforeEach(() => {
  setLanguage("en");
  mock.timers.enable({ apis: ["setTimeout"] });
  clearReplies();
  resetDshApprovalMemory();
  asked = [];
  State.tasks = [];
  State.focusId = null;
  State.paused = false;
  State.pendingApproval = null;
  State.approvalQueue = [];
  State.os = "windows";
  State.settings = { ...State.settings, mainPill: "dsh", activeIntegrations: [] };
});

afterEach(() => {
  mock.timers.runAll();
  mock.timers.reset();
});

test("DeepSeek Harness is offered as a main tool on Windows", () => {
  assert.ok(mainPillChoices("windows").some((p) => p.id === "dsh"));
  assert.equal(pillDefinition("dsh").main, true);
});

test("choosing it takes it out of the declared slots, so it never counts twice", () => {
  const next = chooseMainPill({ mainPill: "agent_codex", activeIntegrations: ["dsh"] }, "dsh", "windows");
  assert.deepEqual(next, { mainPill: "dsh", activeIntegrations: [] });
  // A declaration that still lists the main pill loses the duplicate.
  assert.deepEqual(
    sanitizeDeclared({ mainPill: "dsh", activeIntegrations: ["dsh", "agent_gemini"] }, "windows"),
    { mainPill: "dsh", activeIntegrations: ["agent_gemini"] },
  );
});

test("as the main tool it stays on when the bridge is not live", () => {
  applyDsh(snapshot());
  assert.ok(State.tasks.some((t) => t.id === "dsh"), "the pill is up while DSH is live");

  applyDsh(snapshot({ status: "off", sessions: [], approvalsEnabled: false }));
  const pill = State.tasks.find((t) => t.id === "dsh");
  assert.ok(pill, "the main pill must not vanish when DSH goes away");
  assert.equal(pill.state, "idle", "and it must not claim work it cannot see");
  assert.equal(pill.sessionId, null);
});

test("as a declared pill it still comes and goes with the bridge", () => {
  State.settings = { ...State.settings, mainPill: "agent_codex", activeIntegrations: ["dsh"] };
  applyDsh(snapshot());
  assert.ok(State.tasks.some((t) => t.id === "dsh"));

  // Declared, not main: the pill is not kept once DSH has nothing to show.
  State.settings = { ...State.settings, activeIntegrations: [] };
  applyDsh(snapshot({ status: "off", sessions: [], approvalsEnabled: false }));
  assert.equal(State.tasks.some((t) => t.id === "dsh"), false);
});

// ── Alerts ───────────────────────────────────────────────────────────────────

test("a turn that ends opens the island, like a hook pill's Stop", () => {
  applyDsh(snapshot());
  State.focusId = "dsh";
  State.mode = "hidden";
  asked = [];
  applyDsh(snapshot({ sessions: [{ ...SESSION, state: "finished" }] }));
  assert.deepEqual(asked, ["alert:finished"], "the island is brought forward");
});

test("a failure says so instead of saying it finished", () => {
  applyDsh(snapshot());
  State.focusId = "dsh";
  asked = [];
  applyDsh(snapshot({ sessions: [{ ...SESSION, state: "error" }] }));
  assert.deepEqual(asked, ["alert:error"]);
});

test("connecting is not a session ending", () => {
  // The first snapshot lists every session afresh; alerting on it would pop the
  // island every time the bridge reconnects.
  Dsh.snapshot = null;
  applyDsh(snapshot({ sessions: [{ ...SESSION, state: "finished" }] }));
  assert.deepEqual(asked, [], "no alert for a state we never saw change");
});

test("a pill that is not focused keeps a badge unless every pill may alert", () => {
  State.settings = { ...State.settings, mainPill: "agent_codex", activeIntegrations: ["dsh"] };
  applyDsh(snapshot());
  State.focusId = "agent_codex";
  State.tasks.push({ id: "agent_codex", name: "Codex", color: "#2DD4BF", state: "idle", stepIndex: 0, steps: [], source: "agent", isIntegration: true });
  asked = [];
  applyDsh(snapshot({ sessions: [{ ...SESSION, state: "finished" }] }));
  assert.deepEqual(asked, [], "no alert for a pill nobody is looking at");
  assert.equal(State.tasks.find((t) => t.id === "dsh").pillBadge, "finished");
});
