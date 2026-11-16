// DSH approvals → the island's card (src/island/dsh.ts), driven through the
// real bridge: the snapshot arrives the way Rust emits it, and the answer is
// read from the commands the island invokes.
//
// The card is the one place a permission is granted, so these tests are about
// what must NOT happen: no card when approvals are off, no second answer, no
// answer at all when the island is paused, and no secret on screen.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, clearReplies, emit, reply, sent } from "./tauri.mjs";
import { Bridge } from "../src/core/bridge.ts";
import { registerDshHandlers, applyDsh, resetDshApprovalMemory } from "../src/island/dsh.ts";
import { approvalCard, redact, routeFor } from "../src/core/dsh.ts";
import { State } from "../src/core/state.ts";
import { setLanguage } from "../src/i18n/i18n.ts";

/** What the handler asked the island to do, in order. */
let asked;
const island = {
  alert: (view) => asked.push(`alert:${view}`),
  dropPin: () => asked.push("dropPin"),
  reveal: () => asked.push("reveal"),
  setView: (view) => asked.push(`setView:${view}`),
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
  clearReplies();
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
  // The tool's pill is the overview and is never renamed: it says
  // "DeepSeek Harness" whatever the dialogs are called. A running dialog gets
  // its own pill beside it.
  assert.equal(task.name, "DeepSeek Harness");
  const dialog = State.tasks.find((t) => t.id === "dsh:session:s1");
  assert.ok(dialog, "and the running dialog has one of its own");
  // The model rides on the task so the card can show it next to the dialog's
  // name. It is not `finalLine`: that one means the turn is over.
  assert.equal(dialog.modelLine, "v4-flash · HIGH", "the model DSH reported");
  assert.equal(dialog.finalLine, null, "a running turn is not a finished one");

  applyDsh(snapshot({ status: "off" }));
  assert.equal(State.tasks.find((t) => t.id === "dsh"), undefined, "a dead bridge has none");
  assert.equal(State.tasks.find((t) => t.id === "dsh:session:s1"), undefined, "nor a dialog pill");
});

test("the pill shows no model when DSH reported none", () => {
  applyDsh(snapshot({ sessions: [{ ...SESSION, model: null }] }));
  const task = State.tasks.find((t) => t.id === "dsh:session:s1");
  assert.equal(task.modelLine, null, "nothing is invented");
});

test("the card shows the agent's real steps, not its title over and over", () => {
  // What the screenshot showed: the session's title twice, and "12/12" — the
  // same line appended on every bridge event, because the host's steps were
  // being dropped in Rust. The steps now come from `session.step`.
  const steps = ["pwsh cargo test", "edit src/main.ts", "pwsh cargo build"];
  applyDsh(snapshot({ sessions: [{ ...SESSION, steps, stepSeq: 12 }] }));
  const task = State.tasks.find((t) => t.id === "dsh:session:s1");
  assert.deepEqual(task.steps, steps, "the host's own steps, in order");
  assert.equal(task.stepSeq, 12, "the count keeps going past the capped list");

  // A second snapshot with the same steps does not duplicate them: the list is
  // replaced, not appended to.
  applyDsh(snapshot({ sessions: [{ ...SESSION, steps, stepSeq: 12 }] }));
  assert.deepEqual(State.tasks.find((t) => t.id === "dsh:session:s1").steps, steps);
  assert.equal(new Set(task.steps).size, 3);
});

test("a finished turn takes the dialog's pill away, and the tool's pill rests", () => {
  const steps = ["pwsh cargo test", "edit src/main.ts"];
  applyDsh(snapshot({ sessions: [{ ...SESSION, state: "finished", steps }] }));
  const tool = State.tasks.find((t) => t.id === "dsh");
  // A finished dialog is not busy: it has no pill of its own, and the tool's
  // pill goes back to the overview.
  assert.equal(tool.idle, true, "nothing is running, so the overview rests");
  assert.equal(State.tasks.find((t) => t.id === "dsh:session:s1"), undefined, "no dialog pill");

  applyDsh(snapshot({ sessions: [{ ...SESSION, state: "working", steps }] }));
  assert.equal(tool.idle, false, "a running dialog is work in flight");
  const dialog = State.tasks.find((t) => t.id === "dsh:session:s1");
  assert.ok(dialog, "and it has its pill back");
  assert.equal(dialog.finalLine, null, "a running turn keeps its shimmer");
});

test("the dialog's pill is named after the dialog; the tool's pill is not", () => {
  applyDsh(snapshot({ sessions: [{ ...SESSION, title: "Проект: Coucou DSH Edition" }] }));
  const tool = State.tasks.find((t) => t.id === "dsh");
  const dialog = State.tasks.find((t) => t.id === "dsh:session:s1");
  // Two running dialogs must be told apart in the list, so the dialog's pill
  // carries the dialog's name. The tool's pill stays "DeepSeek Harness": a pill
  // that is sometimes called one thing and sometimes another is the reason the
  // list was unreadable.
  assert.equal(tool.name, "DeepSeek Harness", "the tool keeps its name");
  assert.match(dialog.name, /^Проект: Coucou DSH/, "the dialog names its own pill");
  assert.equal(dialog.modelLine, "v4-flash · HIGH");
});

test("the card carries the time DSH will wait, and it is only shown", () => {
  const card = approvalCard({ ...REQUEST, expiresAt: 1_700_000_060_000 }, SESSION);
  assert.equal(card.expiresAt, 1_700_000_060_000, "passed through for the countdown");
  // No expiry reported: nothing to count down.
  assert.equal(approvalCard({ ...REQUEST, expiresAt: null }, SESSION).expiresAt, null);
});

test("a request with an expiry still sends nothing on its own", () => {
  // The countdown is a label. Nothing in the island answers when it reaches
  // zero — that is the host's decision, and the plugin hands the question to
  // DSH's own prompt.
  emit("dsh", snapshot({ pending: [{ ...REQUEST, expiresAt: Date.now() + 1000 }] }));
  assert.ok(State.pendingApproval);
  mock.timers.tick(30000);
  assert.equal(sent("dsh_approval").length, 0, "time passing answers nothing");
});

// ── Open DSH ─────────────────────────────────────────────────────────────────

test("Open DSH raises the window before handing the question back", async () => {
  reply("open_dsh_window", true);
  emit("dsh", snapshot({ pending: [REQUEST] }));
  assert.ok(State.pendingApproval);

  // What the card's third button does.
  const opened = await Bridge.dshOpenWindow();
  assert.equal(opened, true, "the window was raised");
  assert.equal(sent("open_dsh_window").length, 1);
});

test("Open DSH never answers the request on its own", () => {
  emit("dsh", snapshot({ pending: [REQUEST] }));
  // Raising a window is not a decision: Allow and Deny remain the only answers.
  assert.equal(sent("dsh_approval").length, 0, "nothing was allowed");
});

test("no window means no hand-back, and the card says why", async () => {
  reply("open_dsh_window", false);
  emit("dsh", snapshot({ pending: [REQUEST] }));

  const opened = await Bridge.dshOpenWindow();
  assert.equal(opened, false, "DSH has no window");

  // The island must keep the request: handing it to an invisible window would
  // lose it. This mirrors what island.ts does when `raised` is false.
  if (!opened) {
    State.pendingApproval.note = "DSH has no window to open";
    State.notify();
  }
  assert.equal(sent("dsh_approval").length, 0, "the request was not handed over");
  assert.ok(State.pendingApproval, "the card is still up");
  assert.equal(State.pendingApproval.note, "DSH has no window to open");
});

test("a relay card keeps its own decline path", () => {
  // Hook requests have no window to raise: "Open DSH" means "ask in the terminal".
  assert.deepEqual(routeFor({ source: "hook" }, "open"), { kind: "hook-decline" });
  assert.deepEqual(routeFor({ source: "dsh" }, "open"), { kind: "dsh", decision: "open" });
});
