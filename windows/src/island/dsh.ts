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
  busyDialogs,
  idleSummary,
  isSubagent,
  isKnownEffort,
  isKnownModel,
  islandState,
  isLive,
  modelLabel,
  sessionColor,
  sessionFor,
  sessionHeading,
  type DshSnapshot,
  type SpendStats,
} from "../core/dsh";
import { pillDefinition } from "../core/pills";
import { Sound } from "../core/sound";
import { State, type AgentTask } from "../core/state";
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
    // A subagent ends a turn every time its parent asks it something. Sounding
    // the island and opening it for that would make the island chime all through
    // one answer, for work nobody opened a window for.
    if (isSubagent(session)) continue;
    const was = previous.sessions.find((s) => s.id === session.id)?.state ?? null;
    const now = session.state ?? null;
    if (!was || was === now) continue;

    if (now === "finished" || now === "error") {
      Sound.play(now === "error" ? "error" : "finish");
      // One alert per snapshot: a burst of sessions ending together must not
      // open and close the island several times over.
      const shown =
        !alerted && surfaceAlert(island, DSH_PILL_ID, now === "error" ? "error" : "finished");
      // The badge sits on the dialog's own pill while it still has one — a turn
      // that ended leaves the pill at once, so in practice this is the tool's
      // resting pill, which is where "the last thing that ran" belongs.
      const own = State.tasks.find((t) => t.sessionId === session.id);
      if (shown) alerted = true;
      else State.setPillBadge(own?.id ?? DSH_PILL_ID, now === "error" ? "error" : "finished");
      void Bridge.log(
        `dsh: ${session.id} → ${now} (${shown ? "island alerted" : "badge only"})`,
      );
    } else if (now === "thinking" || now === "working") {
      // A turn started: whatever the last one left behind is stale.
      State.setPillBadge(DSH_PILL_ID, null);
      State.setPillBadge(dshSessionPillId(session.id), null);
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

/**
 * Keeps the island's pills in step with what DSH is doing.
 *
 * Two rules, and they are the whole of it:
 *
 * 1. **The tool's pill is always there and never changes its name.** It is
 *    "DeepSeek Harness", it is where DSH lives in the list, and its card is the
 *    overview: resting when nothing runs, and who is working when something
 *    does. It used to be renamed after whichever dialog was busiest, which is
 *    exactly what made the list unreadable — a pill called "DeepSeek Harness"
 *    would suddenly be called "Починить одобрения" and then change back.
 *
 * 2. **Every busy dialog gets its own pill, named after the dialog.** Busy is
 *    working, thinking, or waiting for an answer. One dialog, one pill; three
 *    dialogs, three pills; nothing running, no dialog pills at all.
 *
 * That is what makes the list predictable: a dialog's pill appears when its turn
 * starts and goes away when it ends, and the number of them is exactly the
 * number of dialogs that are running.
 *
 * Subagents never get a pill. DSH opens them for itself inside one turn, they
 * have no dialog of their own, and a pill that appears and vanishes mid-answer
 * is exactly the "unexplainable logic" this replaces. The overview counts them.
 */
export function syncTask() {
  const snapshot = Dsh.snapshot;
  logPills();
  const definition = pillDefinition(DSH_PILL_ID);

  if (!isLive(snapshot)) {
    // No bridge, no dialogs: every dialog pill goes with it.
    clearSessionPills(new Set());
    // Recomputed after the removals above: a splice shifts what came after it.
    const gone = State.tasks.findIndex((task) => task.id === DSH_PILL_ID);
    if (gone < 0) return;
    // The pill exists only while DSH is live — unless it is the main tool, which
    // is always on and must not disappear when the bridge is down.
    if (State.isKept(DSH_PILL_ID)) {
      restPill(State.tasks[gone], definition, null);
      return;
    }
    State.tasks.splice(gone, 1);
    return;
  }

  // The tool's own pill: always present, always the same name, always the
  // overview of everything DSH is doing.
  let index = State.tasks.findIndex((task) => task.id === DSH_PILL_ID);
  if (index < 0) {
    State.tasks.push({
      id: DSH_PILL_ID,
      name: definition?.name ?? "DeepSeek Harness",
      color: definition?.color ?? "#4C8DFF",
      state: "idle",
      stepIndex: 0,
      steps: [],
      source: "agent",
      isIntegration: false,
      idle: true,
    });
    index = State.tasks.length - 1;
  }
  restPill(State.tasks[index], definition, snapshot);

  syncSessionPills(snapshot, busyDialogs(snapshot));
}

/** The fields one busy dialog gives a pill. */
function dialogFields(session: ReturnType<typeof activeSession>, snapshot: DshSnapshot | null) {
  const definition = pillDefinition(DSH_PILL_ID);
  const steps = session?.steps ?? [];
  const state = islandState(session);
  const waiting = (snapshot?.pending ?? []).some((p) => p.sessionId === session?.id);
  return {
    // The dialog's own title names the pill: "Проект: Coucou DSH Edition" says
    // which dialog this is, "DeepSeek Harness" twice over does not. The title is
    // kept whole: how much of it fits is the pill's business, not the model's.
    name: sessionName(session) || (definition?.name ?? "DeepSeek Harness"),
    // Each dialog wears its own colour, derived from its id: two running dialogs
    // must be told apart at a glance, and the Mochi beside the name is the one
    // place the list has room for colour.
    color: sessionColor(session?.id),
    state,
    steps: [...steps],
    stepIndex: Math.max(0, steps.length - 1),
    stepSeq: session?.stepSeq ?? steps.length,
    sessionCwd: session?.cwd ?? null,
    sessionId: session?.id ?? null,
    // A running turn keeps its shimmer; the sentence is the card's "now" line.
    finalLine: null,
    modelLine: modelLabel(session, snapshot?.catalog),
    sayLine: session?.say?.trim() || null,
    pillBadge: waiting ? ("approval" as const) : null,
    idle: false,
  };
}

/** What the resting pill shows: the tool, and the model the next turn would run. */
function idleFields(snapshot: DshSnapshot | null) {
  const summary = idleSummary(snapshot);
  // The dialog that ran last says what will run next; with nothing run yet, the
  // session the island would show if something did.
  const model = summary?.model ?? modelLabel(activeSession(snapshot), snapshot?.catalog);
  return {
    finalLine: null,
    modelLine: model,
    sayLine: null,
    sessionId: null,
    sessionCwd: null,
    pillBadge: null,
    stepSeq: 0,
  };
}

/** Puts the tool's own pill to rest: no session, no steps, no badge of its own. */
function restPill(
  task: AgentTask,
  definition: ReturnType<typeof pillDefinition>,
  snapshot: DshSnapshot | null = null,
) {
  const busy = busyDialogs(snapshot);
  task.name = definition?.name ?? "DeepSeek Harness";
  task.color = definition?.color ?? "#4C8DFF";
  // The pill keeps the overview: at rest it is "idle", with work in flight it
  // shimmers like any other running pill. Its name never changes.
  task.state = busy.length > 0 ? "working" : "idle";
  task.steps = [];
  task.stepIndex = 0;
  task.stepSeq = 0;
  task.finalLine = null;
  task.idle = busy.length === 0;
  task.sessionId = null;
  task.sessionCwd = null;
  const fields = idleFields(snapshot);
  task.modelLine = fields.modelLine;
  task.sayLine = null;
  // The badge is left alone on purpose: a turn that just ended sets it right
  // after this (see noteSessionStates), and clearing it here would make it
  // flicker away on the next unrelated snapshot.
}

// ── One pill per busy dialog ─────────────────────────────────────────────────

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
 * Whether a pill id stands for one dialog rather than for the tool.
 *
 * The big Mochi wears a dialog's colour, so it needs to know the difference: the
 * tool's own pill is not a dialog and has no colour of its own to wear.
 */
export function isDshSessionPill(id: string): boolean {
  return id.startsWith(DSH_SESSION_PREFIX);
}

/** Drops every dialog pill that is not in `keep`. */
function clearSessionPills(keep: Set<string>) {
  for (let i = State.tasks.length - 1; i >= 0; i -= 1) {
    const id = State.tasks[i].id;
    if (id.startsWith(DSH_SESSION_PREFIX) && !keep.has(id)) State.tasks.splice(i, 1);
  }
}

/**
 * Gives each busy dialog its own pill.
 *
 * No linger, no timer, no "worth showing" heuristics and no cap: `busyDialogs`
 * is the whole rule, so a pill is here exactly while its dialog is running or
 * waiting. The count is the number of dialogs at work, which is what makes the
 * list predictable.
 */
export function syncSessionPills(snapshot: DshSnapshot | null, busy: ReturnType<typeof busyDialogs>) {
  const keep = new Set(busy.map((s) => dshSessionPillId(s.id)));
  clearSessionPills(keep);

  for (const session of busy) {
    const id = dshSessionPillId(session.id);
    const fields = { ...dialogFields(session, snapshot), isDshSession: true };
    const existing = State.tasks.find((t) => t.id === id);
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

/**
 * The name a pill and the overview use for one dialog: its title, whole.
 *
 * It used to be cut to 24 characters here, which is why a pill showed
 * "Починить запросы одобре…" even when there was room for more: the ellipsis was
 * added before any layout ran, so the pill could never use the space it had.
 * Cutting is now CSS's job — `text-overflow` knows the real width, and it does
 * not run when there is nothing to cut.
 */
export function sessionName(session: { title?: string | null; cwd?: string } | null): string {
  return sessionHeading(session as never) || "";
}

/** Kept for the callers that want the old, cut name; unused by pills now. */
export function shortHeading(session: { title?: string | null; cwd?: string } | null): string {
  const raw = sessionName(session);
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