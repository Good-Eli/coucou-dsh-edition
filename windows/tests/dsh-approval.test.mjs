// DSH approvals → the island's card (src/island/dsh.ts), driven through the
// real bridge: the snapshot arrives the way Rust emits it, and the answer is
// read from the commands the island invokes.
//
// The card is the one place a permission is granted, so these tests are about
// what must NOT happen: no card when approvals are off, no second answer, no
// answer at all when the island is paused, and no secret on screen.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, emit, sent } from "./tauri.mjs";
import { registerDshHandlers, applyDsh, resetDshApprovalMemory } from "../src/island/dsh.ts";
import { approvalCard, redact, routeFor } from "../src/core/dsh.ts";
import { State } from "../src/core/state.ts";
import { setLanguage } from "../src/i18n/i18n.ts";

/** What the handler asked the island to do, in order. */
let asked;
const island = {
  alert: (view) => asked.push(`alert:${view}`),
  dropPin: () => asked.push("dropPin"),
};
registerDshHandlers(island);

const SESSION = {
  id: "s1",
  cwd: "C:\\work\\proj",
  title: "Проект: Coucou DSH Edition",
  model: { provider: "deepseek", model: "v4-flash", reasoningEffort: "high" },
  state: "working",
  since: 1,
};

const REQUEST = {
  requestId: "r1",
  sessionId: "s1",
  tool: "pwsh",
  reason: "escalate",
  command: "cargo build --release",
  files: ["C:\\work\\proj\\src\\main.rs"],
  expiresAt: Date.now() + 60000,
};

/** A snapshot the way Rust sends it. */
const snapshot = (over = {}) => ({
  status: "ready",
  error: null,
  version: "0.2.2-rc.1",
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
  asked = [];
  calls.length = 0;
  State.tasks = [];
  State.focusId = null;
  State.mode = "hidden";
  State.view = "overview";
  State.paused = false;
  State.isPinned = false;
  State.pendingApproval = null;
  State.approvalQueue = [];
  State.focusBeforeApproval = null;
  resetDshApprovalMemory();
});

afterEach(() => {
  mock.timers.runAll();
  mock.timers.reset();
});

// ── The card ─────────────────────────────────────────────────────────────────

test("a request puts a card up and is acknowledged", () => {
  emit("dsh", snapshot({ pending: [REQUEST] }));

  const card = State.pendingApproval;
  assert.ok(card, "the card is up");
  assert.equal(card.requestId, "r1");
  assert.equal(card.source, "dsh", "the answer must go back down the DSH path");
  assert.equal(card.pillId, "dsh");
  assert.equal(card.tool, "pwsh");
  assert.equal(card.command, "cargo build --release");
  assert.deepEqual(card.files, ["C:\\work\\proj\\src\\main.rs"]);
  assert.deepEqual(asked, ["alert:approval"], "the island is brought forward");

  // Until the card is confirmed the plugin hands the question to DSH's own
  // prompt, so the acknowledgement has to be sent.
  const acks = sent("dsh_approval_ack");
  assert.equal(acks.length, 1);
  assert.equal(acks[0].requestId, "r1");
  // And nothing has been decided.
  assert.equal(sent("dsh_approval").length, 0, "no decision without a click");
});

test("nothing is shown when the plugin says approvals are off", () => {
  emit("dsh", snapshot({ approvalsEnabled: false, pending: [REQUEST] }));
  assert.equal(State.pendingApproval, null);
  assert.equal(sent("dsh_approval_ack").length, 0, "no card, so nothing to acknowledge");
});

test("nothing is shown when the bridge is not ready", () => {
  emit("dsh", snapshot({ status: "error", pending: [REQUEST] }));
  assert.equal(State.pendingApproval, null);
  assert.equal(sent("dsh_approval_ack").length, 0);
});

test("a paused island hands the question back instead of holding it", () => {
  State.paused = true;
  emit("dsh", snapshot({ pending: [REQUEST] }));

  assert.equal(State.pendingApproval, null, "no card while paused");
  assert.equal(sent("dsh_approval_ack").length, 0, "no promise that somebody is looking");
  const answers = sent("dsh_approval");
  assert.equal(answers.length, 1);
  assert.equal(answers[0].decision, "open", "DSH asks its own question");
});

// ── One at a time ────────────────────────────────────────────────────────────

test("two requests show one card and queue the other", () => {
  const second = { ...REQUEST, requestId: "r2", command: "git push" };
  emit("dsh", snapshot({ pending: [REQUEST, second] }));

  assert.equal(State.pendingApproval.requestId, "r1");
  assert.deepEqual(State.approvalQueue.map((r) => r.requestId), ["r2"]);
  assert.equal(sent("dsh_approval_ack").length, 1, "only the card on screen is acknowledged");
});

test("a request that is gone takes its card down", () => {
  emit("dsh", snapshot({ pending: [REQUEST] }));
  assert.ok(State.pendingApproval);

  // The host resolved it some other way (its own prompt, a timeout, a cancel).
  emit("dsh", snapshot({ pending: [] }));
  assert.equal(State.pendingApproval, null);
  assert.equal(sent("dsh_approval").length, 0, "the island never answers on its own");
});

test("a settled request cannot come back as a card", () => {
  emit("dsh", snapshot({ pending: [REQUEST] }));
  emit("dsh", snapshot({ pending: [] }));
  // The host re-sends its list; an id the island already let go must not return.
  emit("dsh", snapshot({ pending: [REQUEST] }));
  assert.equal(State.pendingApproval, null);
});

// ── Which bridge gets the answer ─────────────────────────────────────────────

test("a DSH request is answered over the DSH bridge", () => {
  assert.deepEqual(routeFor({ source: "dsh" }, "allow"), { kind: "dsh", decision: "allow" });
  assert.deepEqual(routeFor({ source: "dsh" }, "deny"), { kind: "dsh", decision: "deny" });
  assert.deepEqual(routeFor({ source: "dsh" }, "open"), { kind: "dsh", decision: "open" });
});

test("a relay request still goes to the relay", () => {
  assert.deepEqual(routeFor({ source: "hook" }, "allow"), { kind: "hook", decision: "allow" });
  assert.deepEqual(routeFor({}, "deny"), { kind: "hook", decision: "deny" });
  // "Open DSH" is DSH's own answer; on the relay it means "ask in the terminal".
  assert.deepEqual(routeFor({ source: "hook" }, "open"), { kind: "hook-decline" });
});

test("there is no route without a request", () => {
  assert.equal(routeFor(null, "allow"), null);
});

// ── What the card shows ──────────────────────────────────────────────────────

test("the command is shown and credentials are not", () => {
  const card = approvalCard(
    {
      ...REQUEST,
      command: "curl -H 'Authorization: Bearer sk-abcdef1234567890abcdef' https://api.example.com",
      files: ["C:\\work\\proj\\.env"],
    },
    SESSION,
  );
  assert.ok(!card.command.includes("sk-abcdef1234567890abcdef"), card.command);
  assert.ok(card.command.includes("curl"), "the command itself is still readable");
  // The path is what the user is authorising, so it stays.
  assert.deepEqual(card.files, ["C:\\work\\proj\\.env"]);
});

test("tokens, passwords and URL credentials are masked", () => {
  const cases = [
    "pwsh --token=abc123def456",
    "deploy --api-key s3cr3t-value",
    "psql postgres://user:hunter2@db.local/app",
    "gh auth login --with-token ghp_abcdefghijklmnopqrstuvwxyz0123",
  ];
  for (const command of cases) {
    const shown = redact(command);
    assert.ok(
      !/abc123def456|s3cr3t-value|hunter2|ghp_abcdefghijklmnopqrstuvwxyz0123/.test(shown),
      `${command} → ${shown}`,
    );
  }
});

test("an ordinary command is left alone", () => {
  for (const command of ["cargo build --release", "git status", "npm test", "C:\\work\\proj\\a.rs"]) {
    assert.equal(redact(command), command);
  }
});

test("a request without a command falls back to the tool's name", () => {
  const card = approvalCard({ ...REQUEST, command: null, files: [] }, SESSION);
  assert.equal(card.command, "pwsh");
  assert.deepEqual(card.files, []);
});

// ── The pill ─────────────────────────────────────────────────────────────────

test("the pill exists only while the bridge is live", () => {
  applyDsh(snapshot());
  const task = State.tasks.find((t) => t.id === "dsh");
  assert.ok(task, "a live bridge has a pill");
  assert.equal(task.sessionId, "s1");
  assert.equal(task.finalLine, "v4-flash · HIGH", "the model DSH reported");

  applyDsh(snapshot({ status: "off" }));
  assert.equal(State.tasks.find((t) => t.id === "dsh"), undefined, "a dead bridge has none");
});

test("the pill shows no model when DSH reported none", () => {
  applyDsh(snapshot({ sessions: [{ ...SESSION, model: null }] }));
  const task = State.tasks.find((t) => t.id === "dsh");
  assert.equal(task.finalLine, null, "nothing is invented");
});
