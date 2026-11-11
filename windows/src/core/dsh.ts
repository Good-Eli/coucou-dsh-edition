// What DeepSeek Harness reports, as the island sees it.
//
// The Rust side (src-tauri/src/dsh) owns the bridge connection and emits one
// `dsh` event per change. This module holds the last snapshot and turns it into
// what the island already knows how to draw.
//
// Rule that cannot break: the model and the effort shown are the ones DSH
// published for that session. When the host does not say, the island shows
// nothing rather than a plausible guess.

export interface DshEffort {
  id: string;
  name?: string;
}

export interface DshModel {
  id: string;
  name?: string;
  efforts: DshEffort[];
  defaultEffort?: string | null;
  contextWindow?: number | null;
}

export interface DshProvider {
  id: string;
  name?: string;
  models: DshModel[];
}

/** The model one session is actually running with. */
export interface DshSelection {
  provider: string;
  model: string;
  reasoningEffort?: string | null;
}

export interface DshSession {
  id: string;
  cwd?: string;
  title?: string | null;
  agentPreset?: string | null;
  createdAt?: number | null;
  model?: DshSelection | null;
  state?: string | null;
  since?: number | null;
}

/** A question waiting for a click. */
export interface DshApproval {
  requestId: string;
  sessionId?: string | null;
  callId?: string | null;
  tool: string;
  reason?: string;
  title?: string | null;
  command?: string | null;
  files?: string[];
  expiresAt?: number | null;
}

export interface DshCatalog {
  providers: DshProvider[];
  fetchedAt?: number | null;
}

/** Mirrors `Snapshot` in src-tauri/src/dsh/client.rs. */
export interface DshSnapshot {
  status: "connecting" | "ready" | "incompatible" | "off" | "error";
  error?: string | null;
  version?: string | null;
  approvalsEnabled: boolean;
  hardened: boolean;
  sessions: DshSession[];
  catalog: DshCatalog;
  pending: DshApproval[];
  activeSession?: string | null;
  updatedAt: number;
}

/** The pill DSH owns in the island (see core/pills.ts). */
export const DSH_PILL_ID = "dsh";

export const Dsh = {
  snapshot: null as DshSnapshot | null,
};

export function isLive(snapshot: DshSnapshot | null): boolean {
  return snapshot?.status === "ready" || snapshot?.status === "incompatible";
}

/** The session the island is looking at: the chosen one, else the busiest. */
export function activeSession(snapshot: DshSnapshot | null): DshSession | null {
  if (!snapshot || snapshot.sessions.length === 0) return null;
  const chosen = snapshot.sessions.find((s) => s.id === snapshot.activeSession);
  if (chosen) return chosen;
  const rank = (state: string | null | undefined) =>
    state === "working" ? 0 : state === "thinking" ? 1 : state === "error" ? 2 : 3;
  return [...snapshot.sessions].sort((a, b) => rank(a.state) - rank(b.state))[0];
}

/** The session a pending approval belongs to, for the card's title. */
export function sessionFor(snapshot: DshSnapshot | null, sessionId: string | null | undefined): DshSession | null {
  if (!snapshot || !sessionId) return null;
  return snapshot.sessions.find((s) => s.id === sessionId) ?? null;
}

/** A model's display name, from the catalog, never invented. */
function modelName(providerId: string, modelId: string, catalog: DshCatalog | undefined): string {
  const provider = catalog?.providers.find((p) => p.id === providerId);
  const model = provider?.models.find((m) => m.id === modelId);
  return model?.name || modelId;
}

/**
 * "DeepSeek-V4.1-Flash · HIGH", or as much of it as DSH actually reported.
 *
 * No provider name is appended on purpose: the provider is an account, not a
 * model, and showing it would read like a different model.
 */
export function modelLabel(session: DshSession | null, catalog?: DshCatalog): string | null {
  const selection = session?.model;
  if (!selection) return null;
  const name = modelName(selection.provider, selection.model, catalog);
  const effort = selection.reasoningEffort;
  return effort ? `${name} · ${effort.toUpperCase()}` : name;
}

/** The efforts this exact model accepts, so the menu cannot offer a foreign one. */
export function effortsFor(
  catalog: DshCatalog | undefined,
  selection: DshSelection | null | undefined,
): DshEffort[] {
  if (!catalog || !selection) return [];
  const provider = catalog.providers.find((p) => p.id === selection.provider);
  const model = provider?.models.find((m) => m.id === selection.model);
  return model?.efforts ?? [];
}

/** One short line for the island: the task, else the folder, else the state. */
export function sessionLine(session: DshSession | null): string {
  if (!session) return "";
  const title = session.title?.trim();
  if (title) return title;
  const folder = session.cwd?.split(/[\\/]/).filter(Boolean).pop();
  return folder ?? "";
}

/** The island's own state names, so DSH draws with the same animation. */
export function islandState(session: DshSession | null): "idle" | "working" | "thinking" | "error" | "finished" {
  switch (session?.state) {
    case "working":
      return "working";
    case "thinking":
      return "thinking";
    case "error":
      return "error";
    case "finished":
      return "finished";
    default:
      return "idle";
  }
}