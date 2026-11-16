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
  sessionHeading,
  type DshSnapshot,
  type SpendStats,
} from "../core/dsh";
import { pillDefinition } from "../core/pills";
import { Sound } from "../core/sound";
import { State } from "../core/state";
import { dropPendingCard, surfaceAlert } from "./hooks";
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
  void onEvent<SpendAnswer>("dsh-spend", (answer) => settleSpend(answer));
}

/** What Rust answered when the island asked for the spend statistics. */
export interface SpendAnswer {
  ok: boolean;
  stats?: SpendStats | null;
  error?: string | null;
}

/**
 * The spend card's own state: the figures, whether they are on their way, and
 * why there are none.
 *
 * A card that shows zeros while it waits would be a lie about a real account, so
 * "loading" and "unavailable" are states of their own.
 */
export const Spend = {
  stats: null as SpendStats | null,
  loading: false,
  error: null as string | null,
  /** Which period the card is showing: the user picks it, and it is remembered. */
  period: "day" as "day" | "week" | "month",
};

/** How long to wait for the figures before saying so instead of spinning. */
const SPEND_TIMEOUT_MS = 90_000;
let spendTimer: ReturnType<typeof setTimeout> | null = null;

/** Asks Rust for the figures, unless they are already here and fresh. */
export function refreshSpend(force = false) {
  if (Spend.loading) return;
  if (!force && Spend.stats) return;
  Spend.loading = true;
  Spend.error = null;
  if (spendTimer) clearTimeout(spendTimer);
  spendTimer = setTimeout(() => {
    if (!Spend.loading) return;
    Spend.loading = false;
    Spend.error = "DSH did not answer in time";
    State.notify();
  }, SPEND_TIMEOUT_MS);
  // A pending wait must not keep a Node process alive (the tests): in the
  // webview this changes nothing.
  (spendTimer as unknown as { unref?: () => void }).unref?.();
  void Bridge.dshSpendStats().catch((error: unknown) => {
    settleSpend({ ok: false, error: String(error) });
  });
  State.notify();
}

function settleSpend(answer: SpendAnswer) {
  if (spendTimer) {
    clearTimeout(spendTimer);
    spendTimer = null;
  }
  Spend.loading = false;
  if (answer.ok && answer.stats) {
    Spend.stats = answer.stats;
    Spend.error = null;
  } else {
    Spend.error = answer.error ?? "no figures are available";
  }
  State.notify();
}

/** A report from Rust: the whole truth about DSH right now. */
export function applyDsh(snapshot: DshSnapshot) {
  const previous = Dsh.snapshot;
  Dsh.snapshot = snapshot;
  syncTask();
  syncApprovals();
  noteSessionStates(previous, snapshot);
  State.notify();
}

/**
 * Alerts the island when a DSH session ends a turn or fails.
 *
 * Hook pills get this from `handleHook`: a finish plays the sound, opens the
 * island on that pill (or leaves a badge when another pill holds the front),
 * and the badge clears when the next turn starts. DSH publishes the same facts
 * over its own bridge, so it gets the same treatment — otherwise a session
 * that finished while the island was closed was indistinguishable from one
 * that never ran.
 *
 * Only a real transition counts: the first snapshot after connecting, and the
 * one after a reconnect, list every session afresh and must stay silent.
 */
function noteSessionStates(previous: DshSnapshot | null, next: DshSnapshot) {
  if (!host || !previous || !isLive(previous) || !isLive(next)) return;
  const island = host;

  let alerted = false;
  for (const session of next.sessions) {
    const was = previous.sessions.find((s) => s.id === session.id)?.state ?? null;
    const now = session.state ?? null;
    if (!was || was === now) continue;

    if (now === "finished" || now === "error") {
      Sound.play(now === "error" ? "error" : "finish");
      // One alert per snapshot: a burst of sessions ending together must not
      // open and close the island several times over.
      const shown =
        !alerted && surfaceAlert(island, DSH_PILL_ID, now === "error" ? "error" : "finished");
      if (shown) alerted = true;
      else State.setPillBadge(DSH_PILL_ID, now === "error" ? "error" : "finished");
      void Bridge.log(
        `dsh: ${session.id} → ${now} (${shown ? "island alerted" : "badge only"})`,
      );
    } else if (now === "thinking" || now === "working") {
      // A turn started: whatever the last one left behind is stale.
      State.setPillBadge(DSH_PILL_ID, null);
      if (State.mode === "hidden") island.reveal();
    }
  }
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
export function logPills(tasks: readonly { id: string; name: string }[] = State.tasks) {
  const line = tasks.map((t) => `${t.id}(${t.name})`).join(", ");
  if (line === lastPillList) return;
  lastPillList = line;
  void Bridge.log(`pills: ${line || "(none)"}`);
}

export function syncTask() {
  const snapshot = Dsh.snapshot;
  logPills();
  const definition = pillDefinition(DSH_PILL_ID);

  if (!isLive(snapshot)) {
    // No bridge, no dialogs: every session pill goes with it.
    for (let i = State.tasks.length - 1; i >= 0; i -= 1) {
      if (State.tasks[i].id.startsWith(DSH_SESSION_PREFIX)) State.tasks.splice(i, 1);
    }
    // Recomputed after the removals above: a splice shifts what came after it.
    const gone = State.tasks.findIndex((task) => task.id === DSH_PILL_ID);
    if (gone < 0) return;
    // The pill exists only while DSH is live — unless it is the main tool, which
    // is always on and must not disappear when the bridge is down.
    if (State.isKept(DSH_PILL_ID)) {
      const kept = State.tasks[gone];
      kept.state = "idle";
      kept.steps = [];
      kept.stepIndex = 0;
      kept.stepSeq = 0;
      kept.finalLine = null;
      kept.modelLine = null;
      kept.sayLine = null;
      kept.pillBadge = null;
      kept.sessionId = null;
      return;
    }
    State.tasks.splice(gone, 1);
    return;
  }

  const index = State.tasks.findIndex((task) => task.id === DSH_PILL_ID);

  const session = activeSession(snapshot);
  const label = modelLabel(session, snapshot?.catalog);
  const state = islandState(session);
  // The steps are the host's own: what the agent actually did. The session's
  // title used to be appended here as a "step" on every event, which is why the
  // card showed the same line twice and counted 12 of them.
  const steps = session?.steps ?? [];
  const stepSeq = session?.stepSeq ?? steps.length;
  // A finished turn holds its last action still, the way a hook pill holds the
  // agent's final message; a running one keeps the shimmer.
  const over = state === "finished" || state === "error";
  const finalLine = over ? (steps.at(-1) ?? label) : null;
  // What the agent says it is doing, in its own words. This is the card's
  // "now" line: a sentence beats `cd 'C:\LocalAI\…'` every time.
  const said = session?.say?.trim() || null;
  const badge = snapshot && snapshot.approvalsEnabled && snapshot.pending.length > 0 ? "approval" : null;

  if (index < 0) {
    State.tasks.push({
      id: DSH_PILL_ID,
      name: definition?.name ?? "DeepSeek Harness",
      color: definition?.color ?? "#4C8DFF",
      state,
      stepIndex: Math.max(0, steps.length - 1),
      steps: [...steps],
      stepSeq,
      source: "agent",
      isIntegration: false,
      sessionCwd: session?.cwd ?? null,
      sessionId: session?.id ?? null,
      finalLine,
      modelLine: label,
      sayLine: said,
      pillBadge: badge,
    });
    syncSessionPills(snapshot, session);
    return;
  }

  const task = State.tasks[index];
  task.state = state;
  task.sessionCwd = session?.cwd ?? null;
  task.sessionId = session?.id ?? null;
  task.finalLine = finalLine;
  task.modelLine = label;
  task.sayLine = said;
  task.pillBadge = badge;
  // Replaced, never appended: the host re-sends the whole turn's steps, so
  // appending would grow the list on every frame.
  task.steps = [...steps];
  task.stepIndex = Math.max(0, steps.length - 1);
  task.stepSeq = stepSeq;

  syncSessionPills(snapshot, session);
}

// ── One pill per open dialog ─────────────────────────────────────────────────

/** The prefix of a pill that stands for one dialog rather than for the tool. */
export const DSH_SESSION_PREFIX = "dsh:session:";

/** The pill id for one dialog. */
export function dshSessionPillId(sessionId: string): string {
  return `${DSH_SESSION_PREFIX}${sessionId}`;
}

/** Whether a pill id belongs to a DSH dialog (the tool's own pill included). */
export function isDshPill(id: string): boolean {
  return id === DSH_PILL_ID || id.startsWith(DSH_SESSION_PREFIX);
}

/**
 * How long a dialog that stopped working keeps its own pill.
 *
 * A dialog that finished ten minutes ago is no longer "active", and the list on
 * the right is four slots wide: keeping it would push out something live.
 */
const SESSION_PILL_LINGER_MS = 10 * 60_000;

/** At most this many dialog pills at once, so the right-hand list stays readable. */
const MAX_SESSION_PILLS = 3;

/**
 * Gives every open DSH dialog its own pill, and takes the pill away again.
 *
 * The tool's own pill is the focused dialog (see `syncTask`); these are the
 * others. A pill closes when its dialog closes, when it has been quiet for
 * `SESSION_PILL_LINGER_MS`, or when a live dialog needs the slot — but never
 * while that dialog is waiting for an answer, because a card nobody can see is
 * the one thing worse than no card.
 */
export function syncSessionPills(snapshot: DshSnapshot | null, active: ReturnType<typeof activeSession>) {
  const live = isLive(snapshot) ? (snapshot?.sessions ?? []) : [];
  const others = live.filter((s) => s.id !== active?.id);
  const now = Date.now();

  /** A dialog is worth a pill while it works, or shortly after it stopped. */
  const worthShowing = (session: (typeof others)[number]): boolean => {
    const waiting = (snapshot?.pending ?? []).some((p) => p.sessionId === session.id);
    if (waiting) return true;
    const state = session.state ?? "idle";
    if (state === "working" || state === "thinking") return true;
    if (state === "finished" || state === "error") {
      const since = session.since ?? 0;
      return since > 0 && now - since < SESSION_PILL_LINGER_MS;
    }
    // Never started a turn, or its state is unknown: no pill to explain.
    return false;
  };

  const wanted = others
    .filter(worthShowing)
    .sort((a, b) => rankSession(a) - rankSession(b))
    .slice(0, MAX_SESSION_PILLS);

  const keep = new Set(wanted.map((s) => dshSessionPillId(s.id)));

  // Drop the pills whose dialog closed, or stopped being worth one.
  for (let i = State.tasks.length - 1; i >= 0; i -= 1) {
    const id = State.tasks[i].id;
    if (id.startsWith(DSH_SESSION_PREFIX) && !keep.has(id)) State.tasks.splice(i, 1);
  }

  for (const session of wanted) {
    const id = dshSessionPillId(session.id);
    const definition = pillDefinition(DSH_PILL_ID);
    const steps = session.steps ?? [];
    const state = islandState(session);
    const over = state === "finished" || state === "error";
    const said = session.say?.trim() || null;
    const waiting = (snapshot?.pending ?? []).some((p) => p.sessionId === session.id);
    const existing = State.tasks.find((t) => t.id === id);
    const fields = {
      // The dialog's own title names the pill: "Проект: Coucou DSH Edition" says
      // which dialog this is, "DeepSeek Harness" four times over does not.
      name: shortHeading(session) || (definition?.name ?? "DeepSeek Harness"),
      color: definition?.color ?? "#4C8DFF",
      state,
      steps: [...steps],
      stepIndex: Math.max(0, steps.length - 1),
      stepSeq: session.stepSeq ?? steps.length,
      sessionCwd: session.cwd ?? null,
      sessionId: session.id,
      finalLine: over ? (steps.at(-1) ?? null) : null,
      modelLine: modelLabel(session, snapshot?.catalog),
      sayLine: said,
      pillBadge: waiting ? ("approval" as const) : null,
      isDshSession: true,
    };
    if (existing) Object.assign(existing, fields);
    else {
      State.tasks.push({
        id,
        source: "agent",
        isIntegration: false,
        ...fields,
      });
    }
  }
}

/** Working dialogs first, so a slot goes to the one that is doing something. */
function rankSession(session: { state?: string | null }): number {
  switch (session.state) {
    case "working":
      return 0;
    case "thinking":
      return 1;
    case "error":
      return 2;
    default:
      return 3;
  }
}

/** A pill label has room for about 20 characters before it is cut. */
function shortHeading(session: { title?: string | null; cwd?: string }): string {
  const raw = sessionHeading(session as never) || "";
  return raw.length > 24 ? `${raw.slice(0, 23)}…` : raw;
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