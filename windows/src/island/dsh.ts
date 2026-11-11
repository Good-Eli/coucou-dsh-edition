// DSH's reports → the island.
//
// The bridge connection lives in Rust (src-tauri/src/dsh); it emits one `dsh`
// event per change and this file turns that into the pill the island already
// draws for the other agents.
//
// Only what DSH published is shown: the session's own state, its model and its
// effort. Nothing is inferred from a provider table.

import { onEvent } from "../core/bridge";
import {
  DSH_PILL_ID,
  Dsh,
  activeSession,
  islandState,
  isLive,
  modelLabel,
  sessionLine,
  type DshSnapshot,
} from "../core/dsh";
import { pillDefinition } from "../core/pills";
import { State } from "../core/state";

export function registerDshHandlers() {
  void onEvent<DshSnapshot>("dsh", (snapshot) => applyDsh(snapshot));
}

/** A report from Rust: the whole truth about DSH right now. */
export function applyDsh(snapshot: DshSnapshot) {
  Dsh.snapshot = snapshot;
  syncTask();
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