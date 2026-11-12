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
  approvalCard,
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
}

/** A report from Rust: the whole truth about DSH right now. */
export function applyDsh(snapshot: DshSnapshot) {
  Dsh.snapshot = snapshot;
  syncTask();
  syncApprovals();
  State.notify();
}

/**
 * Keeps one `dsh` task in step with the bridge.
 *
 * The pill exists only while DSH is live: a bridge that is off, connecting or
 * failing has nothing to show, and a stale pill would claim otherwise.
 */
export function syncTask() {
  const snapshot = Dsh.snapshot;
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
    const info = { ...card, source: "dsh" as const };

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