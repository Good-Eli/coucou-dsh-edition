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
  /** `ask` or `never`, as DSH reported it. Under `never` no card can appear. */
  approvalPolicy?: string | null;
  /** The newest tool steps of the current turn, oldest first. */
  steps?: string[];
  /** How many steps the turn has run in total; `steps` is capped. */
  stepSeq?: number;
  /**
   * The last thing the agent said out loud, in its own words.
   *
   * The card shows this as "what is happening now": a sentence like "Добавлю
   * тест на утечку — иначе она вернётся" tells a person what is going on, while
   * a raw `cd 'C:\LocalAI\…'` command does not.
   */
  say?: string | null;
  /**
   * `subagent` when DSH opened this session for itself while answering.
   *
   * A subagent has no dialog of its own: it starts and ends inside one turn, so
   * a pill for it would appear and vanish for no reason a person can see.
   */
  origin?: string | null;
  /** The dialog a subagent was spawned from, when DSH says. */
  parentSession?: string | null;
  /** How deep in the delegation tree this session sits: 0 or absent for a dialog. */
  delegationDepth?: number | null;
}

/** Today's PlusVibeAPI spend, as the bridge read it from the provider. */
export interface DshUsage {
  /** Prompt plus completion tokens billed today. */
  tokens: number;
  /** What the provider charged today, in roubles. */
  rub: number;
  /** The local day (`YYYY-MM-DD`) the figures belong to. */
  day?: string | null;
}

/** One period of spend, as the provider counted it. */
export interface SpendTotals {
  tokens: number;
  rub: number;
  requests: number;
}

/** The first day each window covers, so the card can say what it is showing. */
export interface SpendSince {
  day: string;
  week: string;
  month: string;
}

/**
 * Today, the week and the month, for the island's own statistics card.
 *
 * Read from the provider's records, never tallied here: the account is billed by
 * PlusVibeAPI, so its numbers are the only true ones.
 */
export interface SpendStats {
  day: SpendTotals;
  week: SpendTotals;
  month: SpendTotals;
  since: SpendSince;
  /** The month had more history than the bridge read: the figures are partial. */
  truncated?: boolean;
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
  /** The host's default approval policy (`ask` / `never`), when it says. */
  approvalPolicy?: string | null;
  hardened: boolean;
  sessions: DshSession[];
  catalog: DshCatalog;
  /** Today's PlusVibeAPI spend, when the bridge could read it. */
  usage?: DshUsage | null;
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

/**
 * Whether DSH opened this session for itself: a subagent, not a dialog.
 *
 * A subagent starts and ends inside one turn of the dialog that spawned it, so
 * it is not something the person opened and not something they can watch: the
 * island counts it (in the idle summary) but never gives it a pill.
 */
export function isSubagent(session: DshSession | null | undefined): boolean {
  if (!session) return false;
  return (
    session.origin === "subagent" ||
    !!session.parentSession ||
    (session.delegationDepth ?? 0) > 0
  );
}

/** The dialogs a person opened: every session that is not a subagent. */
export function dialogs(snapshot: DshSnapshot | null): DshSession[] {
  if (!snapshot) return [];
  return snapshot.sessions.filter((s) => !isSubagent(s));
}

/** Whether this dialog is doing something right now, or waiting for an answer. */
export function isBusy(session: DshSession, snapshot: DshSnapshot | null): boolean {
  const waiting = (snapshot?.pending ?? []).some((p) => p.sessionId === session.id);
  if (waiting) return true;
  return session.state === "working" || session.state === "thinking";
}

/** How urgent a dialog is: waiting for you beats working beats thinking. */
function busyRank(session: DshSession, snapshot: DshSnapshot | null): number {
  const waiting = (snapshot?.pending ?? []).some((p) => p.sessionId === session.id);
  if (waiting) return 0;
  return session.state === "working" ? 1 : 2;
}

/**
 * The dialogs that are busy right now, the one that needs you first.
 *
 * This list is the whole of the pill rule: one pill per busy dialog, and none at
 * all when it is empty — which is what "nothing is running" looks like.
 */
export function busyDialogs(snapshot: DshSnapshot | null): DshSession[] {
  return dialogs(snapshot)
    .filter((s) => isBusy(s, snapshot))
    .sort((a, b) => busyRank(a, snapshot) - busyRank(b, snapshot));
}

/** What the island shows while no dialog is busy: the facts worth a glance. */
export interface DshIdle {
  /** Dialogs DSH has open (idle ones included): the person's own windows. */
  dialogs: number;
  /** Subagents running inside some dialog's turn, if any. */
  subagents: number;
  /** The dialog that spoke last, and what it said last. */
  lastTitle: string | null;
  lastLine: string | null;
  lastState: string | null;
  lastAt: number | null;
  /** The model the next turn would run, from the last dialog that ran. */
  model: string | null;
}

/**
 * The idle summary: what to show when nothing is running.
 *
 * "Nothing is happening" is not useful on its own — the island is a glance, so
 * the glance should answer what a person actually wants to know at rest: what
 * ran last, how it ended, how many windows are open, and what today has cost.
 * The spend is read from `Dsh.snapshot.usage`, which the bridge refreshes itself.
 */
export function idleSummary(snapshot: DshSnapshot | null): DshIdle | null {
  if (!snapshot || !isLive(snapshot)) return null;
  const own = dialogs(snapshot);
  const running = snapshot.sessions.filter((s) => isSubagent(s) && isBusy(s, snapshot)).length;
  // The most recent thing that actually ran: a dialog with a state and a time.
  const ran = own
    .filter((s) => (s.since ?? 0) > 0 && s.state && s.state !== "idle")
    .sort((a, b) => (b.since ?? 0) - (a.since ?? 0));
  const last = ran[0] ?? null;
  return {
    dialogs: own.length,
    subagents: running,
    lastTitle: last ? sessionHeading(last) : null,
    lastLine: last?.say?.trim() || last?.steps?.at(-1)?.trim() || null,
    lastState: last?.state ?? null,
    lastAt: last?.since ?? null,
    model: modelLabel(last, snapshot.catalog),
  };
}

/** The session the island is looking at: the chosen one, else the busiest. */
export function activeSession(snapshot: DshSnapshot | null): DshSession | null {
  const own = dialogs(snapshot);
  if (own.length === 0) return null;
  const chosen = own.find((s) => s.id === snapshot?.activeSession);
  if (chosen) return chosen;
  const rank = (state: string | null | undefined) =>
    state === "working" ? 0 : state === "thinking" ? 1 : state === "error" ? 2 : 3;
  return [...own].sort((a, b) => rank(a.state) - rank(b.state))[0];
}

/**
 * The colours a dialog's Mochi may wear.
 *
 * Chosen to be told apart on the dark card and from each other: eight tones that
 * stay readable as a 24-pixel body, a name beside it, and a 58-pixel Mochi in
 * the card. None of them is the tool's own blue, so the overview pill is never
 * mistaken for a dialog.
 */
const SESSION_COLORS = [
  "#4C8DFF",
  "#2DD4BF",
  "#A78BFA",
  "#F59E0B",
  "#4ADE80",
  "#F472B6",
  "#38BDF8",
  "#FB7185",
];

/**
 * The colour of one dialog, derived from its id.
 *
 * Derived, not assigned at random: a dialog must keep its colour across a
 * restart, or the person who learned "the teal one is the build fix" has to
 * learn the list again every morning. A hash is not a guarantee of uniqueness —
 * two dialogs can share a tone — but it is stable, which is what matters.
 */
export function sessionColor(sessionId: string | null | undefined): string {
  if (!sessionId) return SESSION_COLORS[0];
  let hash = 0;
  for (let i = 0; i < sessionId.length; i += 1) {
    hash = (Math.imul(hash, 31) + sessionId.charCodeAt(i)) | 0;
  }
  return SESSION_COLORS[Math.abs(hash) % SESSION_COLORS.length];
}

/** The session a pending approval belongs to, for the card's title. */
export function sessionFor(snapshot: DshSnapshot | null, sessionId: string | null | undefined): DshSession | null {
  if (!snapshot || !sessionId) return null;
  return snapshot.sessions.find((s) => s.id === sessionId) ?? null;
}

/**
 * Whether DSH will never ask this session for approval.
 *
 * DSH decides the policy before any answerer is consulted: under `never` every
 * request is rejected outright, so no card can appear however healthy the
 * bridge is. From the island the two look identical, which is why the policy is
 * carried at all. The session's own value wins; the host default is the
 * fallback, and no report at all means no claim either way.
 */
export function neverAsks(snapshot: DshSnapshot | null, session: DshSession | null): boolean {
  const policy = session?.approvalPolicy ?? snapshot?.approvalPolicy ?? null;
  return policy === "never";
}

/**
 * Today's spend as the closed island shows it: "55M / 33,41 ₽".
 *
 * The number comes from the provider's own records, so it is reported, never
 * computed here. A total from an earlier day is dropped rather than shown as
 * today's — the day key is local, which is what the person reading it means.
 * No figures at all returns null, and the island falls back to its other face.
 */
export function usageLine(usage: DshUsage | null | undefined, now = new Date()): string | null {
  if (!usage) return null;
  if (usage.day && usage.day !== localDayKey(now)) return null;
  const tokens = Number(usage.tokens);
  const rub = Number(usage.rub);
  if (!Number.isFinite(tokens) && !Number.isFinite(rub)) return null;
  const left = Number.isFinite(tokens) && tokens > 0 ? compactTokens(tokens) : "0";
  const right = Number.isFinite(rub) && rub > 0 ? rubles(rub) : "0 ₽";
  return `${left} / ${right}`;
}

/** `YYYY-MM-DD` of a local date. */
function localDayKey(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 55_300_000 → "55M", 1_240_000 → "1,2M", 8_400 → "8,4K". */
export function compactTokens(tokens: number): string {
  const n = Math.max(0, Math.round(tokens));
  if (n < 1000) return String(n);
  const [value, suffix] = n < 1_000_000 ? [n / 1000, "K"] : [n / 1_000_000, "M"];
  // One decimal, and only when it says something: "55M", not "55,0M".
  const rounded = Math.round(value * 10) / 10;
  return `${Number.isInteger(rounded) ? rounded : rounded.toFixed(1).replace(".", ",")}${suffix}`;
}

/** 33.41 → "33,41 ₽"; 0 → "0 ₽"; below a kopeck → "<0,01 ₽". */
export function rubles(rub: number): string {
  if (!(rub > 0)) return "0 ₽";
  if (rub < 0.01) return "<0,01 ₽";
  return `${rub.toFixed(2).replace(".", ",")} ₽`;
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

/**
 * What the session's card is about: the dialog's own title, else its folder.
 *
 * DSH names a session after the project it runs in; that name is the one thing
 * that tells two open dialogs apart, so it leads the card. The pill keeps the
 * tool's name — the card is where the session itself is named.
 */
export function sessionHeading(session: DshSession | null): string {
  return sessionLine(session);
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

/**
 * What a secret looks like in a command line, a URL or a path.
 *
 * The card is the one place a command is shown at length, so it is also the one
 * place a token could leak onto a screen someone else is looking at. Anything
 * that looks like a credential is replaced before the card is built — the
 * request itself is untouched, only what is displayed.
 */
const SECRET_PATTERNS: [RegExp, string][] = [
  // --token=abc, --api-key abc, PASSWORD=abc, "secret": "abc"
  [/((?:token|secret|password|passwd|pwd|api[_-]?key|access[_-]?key|private[_-]?key|auth)[a-z_-]*\s*(?:[=:]\s*|\s+))("?)([^\s"',;]{4,})\2/gi, "$1$2••••$2"],
  // A bare bearer token after a header name.
  [/(bearer\s+)[A-Za-z0-9._\-]{8,}/gi, "$1••••"],
  // Long high-entropy runs: sk-…, ghp_…, xoxb-…, AWS keys, JWT-ish blobs.
  [/\b(sk|pk|ghp|gho|ghs|github_pat|xox[baprs]|AKIA|ASIA)[-_A-Za-z0-9]{12,}\b/g, "••••"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "••••"],
  // A URL with credentials in it.
  [/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1••••:••••@"],
];

/** The same text with credentials replaced. Display only. */
export function redact(text: string): string {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** One request, shaped the way the island's approval card expects it. */
export function approvalCard(request: DshApproval, session: DshSession | null): {
  requestId: string;
  sessionId: string;
  pillId: string;
  tool: string;
  command: string;
  files: string[];
  expiresAt: number | null;
} {
  const command = request.command ? redact(request.command) : "";
  return {
    requestId: request.requestId,
    sessionId: request.sessionId ?? session?.id ?? "",
    pillId: DSH_PILL_ID,
    tool: request.tool || "tool",
    // The card's one code line: the command when there is one, else the tool.
    command: command || request.tool || "",
    files: (request.files ?? []).map(redact),
    expiresAt: request.expiresAt ?? null,
  };
}

// ── Model and effort switching ───────────────────────────────────────────────

/** One choice in the picker: a model of a provider, with its own efforts. */
export interface ModelChoice {
  provider: string;
  providerName: string;
  model: string;
  name: string;
  efforts: DshEffort[];
  defaultEffort?: string | null;
}

/** Every model DSH reported, flattened, in the order it listed them. */
export function modelChoices(catalog: DshCatalog | undefined): ModelChoice[] {
  if (!catalog) return [];
  const out: ModelChoice[] = [];
  for (const provider of catalog.providers) {
    for (const model of provider.models) {
      out.push({
        provider: provider.id,
        providerName: provider.name || provider.id,
        model: model.id,
        name: model.name || model.id,
        // Never merged with another model's list: a model that reports no
        // efforts has none to offer.
        efforts: model.efforts ?? [],
        defaultEffort: model.defaultEffort ?? null,
      });
    }
  }
  return out;
}

/** The picker entry matching a selection, or null when the catalog lacks it. */
export function choiceFor(
  catalog: DshCatalog | undefined,
  selection: DshSelection | null | undefined,
): ModelChoice | null {
  if (!selection) return null;
  return (
    modelChoices(catalog).find(
      (c) => c.provider === selection.provider && c.model === selection.model,
    ) ?? null
  );
}

/** The value the bridge expects for a model: `provider/model`. */
export function modelValue(choice: { provider: string; model: string }): string {
  return `${choice.provider}/${choice.model}`;
}

/** The value the bridge expects for an effort. Empty means the provider default. */
export function effortValue(effort: string | null | undefined): string {
  return effort ?? "";
}

/** Whether a model exists in the catalog. The picker only offers known ones. */
export function isKnownModel(catalog: DshCatalog | undefined, provider: string, model: string): boolean {
  return modelChoices(catalog).some((c) => c.provider === provider && c.model === model);
}

/** Whether an effort belongs to this exact model. */
export function isKnownEffort(
  catalog: DshCatalog | undefined,
  selection: DshSelection | null | undefined,
  effort: string,
): boolean {
  if (effort === "") return true;
  return effortsFor(catalog, selection).some((e) => e.id === effort);
}

/** "Provider · model · effort" for the picker's header, from what DSH reported. */
export function selectionLine(
  catalog: DshCatalog | undefined,
  selection: DshSelection | null | undefined,
): string {
  if (!selection) return "";
  const choice = choiceFor(catalog, selection);
  const model = choice?.name ?? selection.model;
  const provider = choice?.providerName ?? selection.provider;
  const effort = selection.reasoningEffort
    ? (choice?.efforts.find((e) => e.id === selection.reasoningEffort)?.name ?? selection.reasoningEffort)
    : "";
  return [provider, model, effort].filter(Boolean).join(" · ");
}

/**
 * DSH records a selection and applies it to the *next* request: its own
 * projection keeps `lastUsed` (what the running request sent) apart from
 * `pending` (what comes next).
 *
 * So a change made while a turn is running must not be shown as already in
 * effect for that turn. This is the rule the picker follows.
 */
export function appliesToNextRequest(session: DshSession | null): boolean {
  return session?.state === "working" || session?.state === "thinking";
}

/** Which bridge an answer has to travel down. */
export type AnswerRoute =
  | { kind: "dsh"; decision: "allow" | "deny" | "open" }
  | { kind: "hook"; decision: "allow" | "deny" }
  | { kind: "hook-decline" };

/**
 * The command a click turns into.
 *
 * A request answered down the wrong path would either be lost or — worse — be
 * read as an answer to a different question, so the source decides it and there
 * is no default.
 */
export function routeFor(
  request: { source?: "hook" | "dsh" } | null,
  decision: "allow" | "deny" | "open",
): AnswerRoute | null {
  if (!request) return null;
  if (request.source === "dsh") return { kind: "dsh", decision };
  // The relay only knows allow and deny; "open" is its own command there.
  if (decision === "open") return { kind: "hook-decline" };
  return { kind: "hook", decision };
}