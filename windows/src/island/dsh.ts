// DSH's reports → the island.
//
// The bridge connection lives in Rust (src-tauri/src/dsh); it emits one `dsh`
// event per change and this file turns that into the pill the island already
// draws for the other agents.
//
// Only what DSH published is shown: the session's own state, its model and its
// effort. Nothing is inferred from a provider table.

import { onEvent, Bridge } from "../core/bridge";
import {
  DSH_PILL_ID,
  Dsh,
  activeSession,
  appliesToNextRequest,
  approvalCard,
  isKnownEffort,
  isKnownModel,
  islandState,
  isLive,
  modelLabel,
  sessionFor,
  sessionLine,
  type DshSnapshot,
} from "../core/dsh";
import { pillDefinition } from "../core/pills";
import { State } from "../core/state";
import { dropPendingCard } from "./hooks";
import type { Island } from "./island";
// ── Model and effort switching ───────────────────────────────────────────────

/** What the host answered to one `session.setConfig`. */
export interface ConfigResult {
  requestId: string;
  ok: boolean;
  error?: string | null;
  selection?: { provider: string; model: string; reasoningEffort?: string | null } | null;
}

/**
 * The state of the last change the user asked for.
 *
 * `note` says a change applies to the next request, never to the one already
 * running: DSH records a selection and sends it with the next request.
 */
export const DshConfig = {
  pending: false,
  requestId: null as string | null,
  error: null as string | null,
  /** Set when a change was accepted while a turn was running. */
  appliesNext: false,
  /** Cleared as soon as the next turn starts, when the change is in effect. */
  sessionId: null as string | null,
};

/** How long to wait for the host to answer a change before calling it failed. */
const CONFIG_TIMEOUT_MS = 6000;
let configTimer: ReturnType<typeof setTimeout> | null = null;
/**
 * An answer that arrived before the command returned its id.
 *
 * The host can reply in the same millisecond it is asked, so the event can
 * reach the page before `dsh_set_config` has resolved. Dropping it would turn a
 * successful change into a false timeout.
 */
let earlyResult: ConfigResult | null = null;

function clearConfigTimer() {
  if (configTimer) clearTimeout(configTimer);
  configTimer = null;
}

function resetConfig() {
  clearConfigTimer();
  earlyResult = null;
  DshConfig.pending = false;
  DshConfig.requestId = null;
  DshConfig.sessionId = null;
}

/** A change was accepted: nothing is claimed until the host confirms it. */
function settleConfig(result: ConfigResult) {
  if (!DshConfig.requestId) {
    // Not yet known which request this belongs to: hold it until it is.
    if (DshConfig.pending) earlyResult = result;
    return;
  }
  if (result.requestId !== DshConfig.requestId) return;
  resetConfig();
  if (!result.ok) {
    DshConfig.error = result.error || "DSH refused the change";
    State.notify();
    return;
  }
  // The snapshot carries the value the host read back; there is nothing to
  // assert here beyond clearing the error.
  DshConfig.error = null;
  State.notify();
}

function startConfig(sessionId: string, appliesNext: boolean): string | null {
  const snapshot = Dsh.snapshot;
  if (!snapshot || !isLive(snapshot)) {
    DshConfig.error = "DSH is not connected";
    State.notify();
    return null;
  }
  resetConfig();
  DshConfig.error = null;
  DshConfig.pending = true;
  DshConfig.appliesNext = appliesNext;
  DshConfig.sessionId = sessionId;
  return sessionId;
}

/**
 * Switches one session to another model.
 *
 * The model has to be in the catalog DSH published: sending a name it never
 * mentioned would leave the session pointing at a route that cannot resolve.
 */
export function chooseModel(sessionId: string, provider: string, model: string) {
  const snapshot = Dsh.snapshot;
  if (!isKnownModel(snapshot?.catalog, provider, model)) {
    DshConfig.error = `unknown model: ${provider}/${model}`;
    State.notify();
    return;
  }
  const session = sessionFor(snapshot, sessionId);
  if (!startConfig(sessionId, appliesToNextRequest(session))) return;
  void sendConfig(sessionId, "model", `${provider}/${model}`);
}

/** Switches the effort of one session, among the ones its model supports. */
export function chooseEffort(sessionId: string, effort: string) {
  const snapshot = Dsh.snapshot;
  const session = sessionFor(snapshot, sessionId);
  if (!isKnownEffort(snapshot?.catalog, session?.model, effort)) {
    DshConfig.error = `unknown reasoning effort: ${effort || "(default)"}`;
    State.notify();
    return;
  }
  if (!startConfig(sessionId, appliesToNextRequest(session))) return;
  void sendConfig(sessionId, "reasoning_effort", effort);
}

async function sendConfig(sessionId: string, configId: "model" | "reasoning_effort", value: string) {
  try {
    const requestId = await Bridge.dshSetConfig(sessionId, configId, value);
    // The answer may have arrived before the command returned.
    if (!DshConfig.pending) return;
    DshConfig.requestId = requestId;
    if (earlyResult && earlyResult.requestId === requestId) {
      const held = earlyResult;
      earlyResult = null;
      settleConfig(held);
      return;
    }
    earlyResult = null;
    clearConfigTimer();
    configTimer = setTimeout(() => {
      if (!DshConfig.pending) return;
      resetConfig();
      DshConfig.error = "DSH did not answer; nothing was changed";
      State.notify();
    }, CONFIG_TIMEOUT_MS);
  } catch (error) {
    resetConfig();
    DshConfig.error = String((error as Error)?.message ?? error);
    State.notify();
  }
}

/** Forgets a reported error once the user has seen it. */
export function clearConfigError() {
  if (!DshConfig.error) return;
  DshConfig.error = null;
  State.notify();
}

/**
 * The island puts the card up, exactly as it does for a hook request, and takes
 * it down through the same path.
 */
let host: Island | null = null;
/** Requests the island has already answered or handed back, so they never return. */
const settled = new Set<string>();

/** Forgets what was settled. A new connection is a new conversation. */
export function resetDshApprovalMemory() {
  settled.clear();
}

export function registerDshHandlers(island: Island) {
  host = island;
  void onEvent<DshSnapshot>("dsh", (snapshot) => applyDsh(snapshot));
  void onEvent<ConfigResult>("dsh-config", (result) => settleConfig(result));
}

/** A report from Rust: the whole truth about DSH right now. */
export function applyDsh(snapshot: DshSnapshot) {
  Dsh.snapshot = snapshot;
  syncTask();
  syncApprovals();
  State.notify();
}

/**
 * Puts the DSH pill back after the task list was rebuilt from the settings.
 *
 * `loadIntegrationTasks` keeps only the pills the user declared, and DSH is not
 * one of them: it appears because the bridge is live, not because it was
 * checked in Settings. Without this the pill would vanish on the next settings
 * load and stay gone until DSH happened to send something.
 */
export function refreshDsh() {
  if (!Dsh.snapshot) return;
  syncTask();
}

/**
 * Keeps one `dsh` task in step with the bridge.
 *
 * The pill exists only while DSH is live: a bridge that is off, connecting or
 * failing has nothing to show, and a stale pill would claim otherwise.
 */
/** The last pill list written to the log, so only changes reach it. */
let lastPillList: string | null = null;

/**
 * Writes the pill list to the log when it changes.
 *
 * "There are two DSH pills and I do not know where the second came from" is not
 * answerable from a screenshot: the ids say which one the bridge owns and which
 * one something else put there. Logged here rather than in the state module,
 * because this is where a transport is already in hand.
 */
export function logPills() {
  const line = State.tasks.map((t) => `${t.id}(${t.name})`).join(", ");
  if (line === lastPillList) return;
  lastPillList = line;
  void Bridge.log(`pills: ${line || "(none)"}`);
}

export function syncTask() {
  const snapshot = Dsh.snapshot;
  logPills();
  const definition = pillDefinition(DSH_PILL_ID);
  const index = State.tasks.findIndex((task) => task.id === DSH_PILL_ID);

  if (!isLive(snapshot)) {
    if (index >= 0) State.tasks.splice(index, 1);
    return;
  }

  const session = activeSession(snapshot);
  const label = modelLabel(session, snapshot?.catalog);
  const line = sessionLine(session);
  const state = islandState(session);

  if (index < 0) {
    State.tasks.push({
      id: DSH_PILL_ID,
      name: definition?.name ?? "DeepSeek Harness",
      color: definition?.color ?? "#4C8DFF",
      state,
      stepIndex: 0,
      steps: line ? [line] : [],
      source: "agent",
      isIntegration: false,
      sessionCwd: session?.cwd ?? null,
      sessionId: session?.id ?? null,
      // The model line is the one thing worth showing next to the pill.
      finalLine: label,
      pillBadge: snapshot && snapshot.approvalsEnabled && snapshot.pending.length > 0 ? "approval" : null,
    });
    return;
  }

  const task = State.tasks[index];
  task.state = state;
  task.sessionCwd = session?.cwd ?? null;
  task.sessionId = session?.id ?? null;
  task.finalLine = label;
  task.pillBadge = snapshot && snapshot.approvalsEnabled && snapshot.pending.length > 0 ? "approval" : null;
  if (line) {
    task.steps = task.steps.length ? [...task.steps.slice(-20), line] : [line];
    task.stepIndex = task.steps.length - 1;
  }
}

/**
 * Puts DSH's questions on screen, one card at a time.
 *
 * The plugin holds the tool call for a moment and then hands it to DSH's own
 * prompt unless the card is confirmed (`approval.ack`). So the order matters:
 * the card goes up first, and only then is it acknowledged. If Coucou cannot
 * show it, no ack is sent and DSH asks the question itself — the fallback is
 * silence from us, never a decision on the user's behalf.
 */
export function syncApprovals() {
  const snapshot = Dsh.snapshot;
  const pending = snapshot && isLive(snapshot) && snapshot.approvalsEnabled ? snapshot.pending : [];

  // A request that vanished from the bridge was answered elsewhere, expired or
  // withdrawn: take its card down and remember it, so a late frame cannot bring
  // it back.
  const live = new Set(pending.map((p) => p.requestId));
  for (const request of [...State.approvalQueue, State.pendingApproval].filter(Boolean)) {
    if (request!.source !== "dsh") continue;
    if (live.has(request!.requestId)) continue;
    settled.add(request!.requestId);
  }
  State.approvalQueue = State.approvalQueue.filter((r) => r.source !== "dsh" || live.has(r.requestId));
  if (State.pendingApproval?.source === "dsh" && !live.has(State.pendingApproval.requestId) && host) {
    dropPendingCard(host);
  }

  for (const request of pending) {
    if (settled.has(request.requestId)) continue;
    if (State.pendingApproval?.requestId === request.requestId) continue;
    if (State.approvalQueue.some((r) => r.requestId === request.requestId)) continue;

    const session = sessionFor(snapshot, request.sessionId);
    const card = approvalCard(request, session);
    const info = { ...card, source: "dsh" as const, note: null };

    if (State.pendingApproval) {
      State.approvalQueue.push(info);
      continue;
    }

    // Paused means the island is not answering anybody: hand the question back
    // to DSH instead of leaving it waiting.
    if (State.paused) {
      settled.add(request.requestId);
      void Bridge.dshApproval(request.requestId, "open");
      continue;
    }

    State.beginApproval(info);
    host?.alert("approval");
    // The card exists now; the plugin may keep holding the call.
    void Bridge.dshApprovalAck(request.requestId);
  }
}