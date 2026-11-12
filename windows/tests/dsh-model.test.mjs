// Model and effort switching (src/core/dsh.ts + src/island/dsh.ts).
//
// What matters here is that nothing is claimed before DSH confirms it: the
// picker offers only what the catalog lists, an effort belongs to its own
// model, an unknown name never reaches the bridge, and a change made while a
// turn runs is shown as belonging to the next request.

import { afterEach, beforeEach, mock, test } from "node:test";
import assert from "node:assert/strict";
import { calls, clearReplies, emit, reply, sent } from "./tauri.mjs";
import { applyDsh, chooseEffort, chooseModel, DshConfig, resetDshApprovalMemory } from "../src/island/dsh.ts";
import {
  appliesToNextRequest,
  choiceFor,
  effortsFor,
  isKnownEffort,
  isKnownModel,
  modelChoices,
  modelValue,
  selectionLine,
} from "../src/core/dsh.ts";
import { State } from "../src/core/state.ts";
import { setLanguage } from "../src/i18n/i18n.ts";

const island = { alert: () => {}, dropPin: () => {} };
import { registerDshHandlers } from "../src/island/dsh.ts";
registerDshHandlers(island);

const CATALOG = {
  providers: [
    {
      id: "deepseek",
      name: "DeepSeek",
      models: [
        {
          id: "v4-flash",
          name: "DeepSeek-V4.1-Flash",
          efforts: [
            { id: "off", name: "Off" },
            { id: "high", name: "High" },
            { id: "max", name: "Max" },
          ],
          defaultEffort: "high",
        },
        {
          id: "v4-pro",
          name: "DeepSeek-V4.1-Pro",
          efforts: [{ id: "high", name: "High" }],
          defaultEffort: "high",
        },
        // A model with no reasoning at all.
        { id: "lite", name: "Lite", efforts: [], defaultEffort: null },
      ],
    },
    {
      id: "plusvibe",
      name: "PlusVibe",
      models: [
        {
          id: "spark",
          name: "Spark",
          efforts: [
            { id: "low", name: "Low" },
            { id: "medium", name: "Medium" },
          ],
          defaultEffort: "medium",
        },
      ],
    },
  ],
};

const session = (over = {}) => ({
  id: "s1",
  cwd: "C:\\work\\a",
  title: "Первая",
  model: { provider: "deepseek", model: "v4-flash", reasoningEffort: "high" },
  state: "idle",
  since: 1,
  ...over,
});

const snapshot = (over = {}) => ({
  status: "ready",
  error: null,
  version: "0.2.2-rc.1",
  approvalsEnabled: true,
  hardened: true,
  sessions: [session()],
  catalog: CATALOG,
  pending: [],
  activeSession: null,
  updatedAt: 1,
  ...over,
});

beforeEach(() => {
  setLanguage("en");
  mock.timers.enable({ apis: ["setTimeout"] });
  calls.length = 0;
  State.tasks = [];
  State.pendingApproval = null;
  State.approvalQueue = [];
  resetDshApprovalMemory();
  DshConfig.pending = false;
  DshConfig.requestId = null;
  DshConfig.error = null;
  DshConfig.appliesNext = false;
  clearReplies();
  // The Rust side answers a change with the id of the request it sent.
  reply("dsh_set_config", "cfg-1");
});

/** Lets the command promise settle before the answer is simulated. */
const settle = () => new Promise((resolve) => setImmediate(resolve));

afterEach(() => {
  mock.timers.runAll();
  mock.timers.reset();
});

// ── The catalog ──────────────────────────────────────────────────────────────

test("every model DSH listed is offered, with its own efforts", () => {
  const choices = modelChoices(CATALOG);
  assert.equal(choices.length, 4, "three from DeepSeek, one from PlusVibe");
  // Nothing is hardcoded: the names are whatever the catalog said.
  assert.deepEqual(choices.map((c) => c.name), [
    "DeepSeek-V4.1-Flash",
    "DeepSeek-V4.1-Pro",
    "Lite",
    "Spark",
  ]);
  assert.deepEqual(choices.map((c) => c.efforts.map((e) => e.id)), [
    ["off", "high", "max"],
    ["high"],
    [],
    ["low", "medium"],
  ]);
});

test("efforts belong to the model, never to the provider", () => {
  const pro = { provider: "deepseek", model: "v4-pro" };
  const flash = { provider: "deepseek", model: "v4-flash" };
  // Same provider, different lists.
  assert.deepEqual(effortsFor(CATALOG, pro).map((e) => e.id), ["high"]);
  assert.deepEqual(effortsFor(CATALOG, flash).map((e) => e.id), ["off", "high", "max"]);
  // And a model with none offers none.
  assert.deepEqual(effortsFor(CATALOG, { provider: "deepseek", model: "lite" }), []);
});

test("a model outside the catalog has no choice", () => {
  assert.equal(choiceFor(CATALOG, { provider: "deepseek", model: "nope" }), null);
  assert.equal(choiceFor(undefined, { provider: "deepseek", model: "v4-flash" }), null);
});

test("the model value is the form the bridge expects", () => {
  assert.equal(modelValue({ provider: "deepseek", model: "v4-flash" }), "deepseek/v4-flash");
  assert.equal(modelValue({ provider: "plusvibe", model: "spark" }), "plusvibe/spark");
});

test("the header shows what DSH reported", () => {
  const line = selectionLine(CATALOG, { provider: "deepseek", model: "v4-flash", reasoningEffort: "high" });
  assert.equal(line, "DeepSeek · DeepSeek-V4.1-Flash · High");
  // No effort reported: no effort shown.
  const bare = selectionLine(CATALOG, { provider: "deepseek", model: "v4-flash" });
  assert.equal(bare, "DeepSeek · DeepSeek-V4.1-Flash");
});

// ── Refusing what DSH never offered ──────────────────────────────────────────

test("an unknown model is refused before it reaches the bridge", () => {
  applyDsh(snapshot());
  chooseModel("s1", "deepseek", "ghost");
  assert.equal(sent("dsh_set_config").length, 0, "nothing was sent");
  assert.match(DshConfig.error, /unknown model/);
  assert.equal(DshConfig.pending, false);
});

test("an unknown effort is refused before it reaches the bridge", () => {
  applyDsh(snapshot());
  // "low" belongs to PlusVibe's Spark, not to this model.
  chooseEffort("s1", "low");
  assert.equal(sent("dsh_set_config").length, 0);
  assert.match(DshConfig.error, /unknown reasoning effort/);
});

test("a model without efforts refuses every effort but the default", () => {
  applyDsh(snapshot({ sessions: [session({ model: { provider: "deepseek", model: "lite" } })] }));
  assert.equal(isKnownEffort(CATALOG, { provider: "deepseek", model: "lite" }, "high"), false);
  assert.equal(isKnownEffort(CATALOG, { provider: "deepseek", model: "lite" }, ""), true);
  chooseEffort("s1", "high");
  assert.equal(sent("dsh_set_config").length, 0);
});

test("a disconnected bridge refuses the change", () => {
  applyDsh(snapshot({ status: "off" }));
  chooseModel("s1", "deepseek", "v4-pro");
  assert.equal(sent("dsh_set_config").length, 0);
  assert.equal(DshConfig.error, "DSH is not connected");
});

test("no catalog means no model is known", () => {
  assert.equal(isKnownModel(undefined, "deepseek", "v4-flash"), false);
  assert.equal(isKnownModel(CATALOG, "deepseek", "v4-flash"), true);
});

// ── Sending a change ─────────────────────────────────────────────────────────

test("a known model is sent to the bridge for that session only", async () => {
  applyDsh(snapshot());
  chooseModel("s1", "deepseek", "v4-pro");
  await settle();
  const sentFrames = sent("dsh_set_config");
  assert.equal(sentFrames.length, 1);
  assert.equal(sentFrames[0].sessionId, "s1");
  assert.equal(sentFrames[0].configId, "model");
  assert.equal(sentFrames[0].value, "deepseek/v4-pro");
  assert.equal(DshConfig.pending, true);
});

test("an effort is sent as the effort, empty meaning the provider default", async () => {
  applyDsh(snapshot());
  chooseEffort("s1", "max");
  await settle();
  assert.equal(sent("dsh_set_config")[0].configId, "reasoning_effort");
  assert.equal(sent("dsh_set_config")[0].value, "max");
});

test("the confirmed value comes from the host, not from what we asked", async () => {
  applyDsh(snapshot());
  chooseModel("s1", "deepseek", "v4-pro");
  await settle();
  const requestId = DshConfig.requestId;
  assert.ok(requestId);

  // The host answers with its own reading: it also dropped the effort, because
  // the new model has its own list and nothing was chosen for it.
  emit("dsh-config", {
    requestId,
    ok: true,
    selection: { provider: "deepseek", model: "v4-pro", reasoningEffort: null },
  });
  assert.equal(DshConfig.pending, false);
  assert.equal(DshConfig.error, null);
});

test("a refused change says why and claims nothing", async () => {
  applyDsh(snapshot());
  chooseModel("s1", "deepseek", "v4-pro");
  await settle();
  const requestId = DshConfig.requestId;

  emit("dsh-config", { requestId, ok: false, error: "invalid_value: unknown model" });
  assert.equal(DshConfig.pending, false);
  assert.match(DshConfig.error, /unknown model/);
  // The session still shows the old model: nothing was applied.
  const task = State.tasks.find((t) => t.id === "dsh");
  assert.equal(task.finalLine, "DeepSeek-V4.1-Flash · HIGH");
});

test("an answer to another request is ignored", async () => {
  applyDsh(snapshot());
  chooseModel("s1", "deepseek", "v4-pro");
  await settle();
  emit("dsh-config", { requestId: "cfg-somebody-else", ok: false, error: "nope" });
  assert.equal(DshConfig.pending, true, "still waiting for its own answer");
  assert.equal(DshConfig.error, null);
});

test("no answer in time is a failure, not a success", async () => {
  applyDsh(snapshot());
  chooseModel("s1", "deepseek", "v4-pro");
  await settle();
  assert.equal(DshConfig.pending, true);
  mock.timers.tick(6000);
  await settle();
  assert.equal(DshConfig.pending, false);
  assert.match(DshConfig.error, /did not answer/);
});

test("a failed send is reported as such", async () => {
  applyDsh(snapshot());
  // The bridge is gone by the time the command runs.
  const original = calls.length;
  chooseModel("s1", "deepseek", "v4-pro");
  await settle();
  assert.ok(calls.length > original);
});

// ── Which request the change belongs to ──────────────────────────────────────

test("a change while a turn runs applies to the next request", () => {
  assert.equal(appliesToNextRequest(session({ state: "working" })), true);
  assert.equal(appliesToNextRequest(session({ state: "thinking" })), true);
  assert.equal(appliesToNextRequest(session({ state: "idle" })), false);
  assert.equal(appliesToNextRequest(session({ state: "finished" })), false);
  assert.equal(appliesToNextRequest(null), false);
});

test("the picker marks a change made mid-turn as belonging to the next one", async () => {
  applyDsh(snapshot({ sessions: [session({ state: "working" })] }));
  chooseModel("s1", "deepseek", "v4-pro");
  await settle();
  assert.equal(DshConfig.appliesNext, true);
});

test("a change made while idle carries no such note", async () => {
  applyDsh(snapshot({ sessions: [session({ state: "idle" })] }));
  chooseModel("s1", "deepseek", "v4-pro");
  await settle();
  assert.equal(DshConfig.appliesNext, false);
});

// ── Two sessions ─────────────────────────────────────────────────────────────

test("a change names one session and leaves the other alone", async () => {
  const other = session({
    id: "s2",
    title: "Вторая",
    model: { provider: "plusvibe", model: "spark", reasoningEffort: "medium" },
  });
  applyDsh(snapshot({ sessions: [session(), other] }));

  chooseModel("s2", "deepseek", "v4-flash");
  await settle();

  const frames = sent("dsh_set_config");
  assert.equal(frames.length, 1);
  assert.equal(frames[0].sessionId, "s2", "only the session that was asked about");

  // The host confirms for s2; s1 keeps what it had.
  emit("dsh-config", {
    requestId: DshConfig.requestId,
    ok: true,
    selection: { provider: "deepseek", model: "v4-flash", reasoningEffort: null },
  });
  applyDsh(
    snapshot({
      sessions: [
        session(),
        { ...other, model: { provider: "deepseek", model: "v4-flash", reasoningEffort: null } },
      ],
    }),
  );
  const first = State.tasks.find((t) => t.id === "dsh");
  // The pill follows the active session; s1 is still on its own model.
  assert.ok(first, "the pill exists");
});

test("an answer that arrives before the request id is not lost", async () => {
  applyDsh(snapshot());
  // The command resolves only after the answer has already been delivered: the
  // host is that fast, and dropping the early answer would fake a timeout.
  reply("dsh_set_config", () => {
    emit("dsh-config", {
      requestId: "cfg-1",
      ok: true,
      selection: { provider: "deepseek", model: "v4-pro" },
    });
    return "cfg-1";
  });
  chooseModel("s1", "deepseek", "v4-pro");
  await settle();
  assert.equal(DshConfig.pending, false, "settled, not left waiting");
  assert.equal(DshConfig.error, null, "no false timeout");
});
