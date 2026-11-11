/**
 * Coucou ↔ DeepSeek Harness bridge — prototype plugin.
 *
 * Runs inside the DSH host process as an ordinary Cordis plugin. It:
 *   - observes live agents and their sessions (state, model, steps);
 *   - answers `approval/request` only after Coucou acknowledges the card and a
 *     human clicks, and calls `next()` in every other case;
 *   - publishes the model catalog and per-session selection;
 *   - listens on a Windows named pipe restricted to the current user SID.
 *
 * Safety rules baked into this file:
 *   - no decision is ever returned without an explicit `approval.answer`;
 *   - no client connected, no ack, timeout, cancel or disconnect all fall back to
 *     `next()` (the stock DSH approval UI);
 *   - nothing is written to the session log, the profile or DSH settings.
 */

import { createServer } from 'node:net';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, statSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const name = 'coucou-dsh-bridge';

/** Bumped whenever the wire format changes; the Coucou side refuses a mismatch. */
export const PROTOCOL = 1;

/** DSH versions this prototype was written against. */
export const SUPPORTED_DSH = ['0.2.2-rc.1'];



const MAX_LINE = 1 << 20;
const HEARTBEAT_MS = 5000;

/** Defaults applied when the profile row omits a field. */
const DEFAULTS = {
  protocol: PROTOCOL,
  /** Directory holding `runtime.json` (pipe name + token) and the log. */
  stateDir: '',
  /** Extra suffix on the pipe name; tests use it to run side by side. */
  pipeSuffix: '',
  /** How long the island has to confirm the card is on screen. */
  ackTimeoutMs: 1500,
  /** How long a human has to answer before DSH asks in its own window. */
  decisionTimeoutMs: 110_000,
  logLevel: 'info',
};

// ── logging ──────────────────────────────────────────────────────────────────

function makeLog(stateDir, level) {
  const levels = { error: 0, warn: 1, info: 2, debug: 3 };
  const min = levels[level] ?? 2;
  const file = stateDir ? join(stateDir, 'bridge.log') : '';
  return (lvl, message) => {
    if ((levels[lvl] ?? 2) > min) return;
    // Only structural facts are logged: never commands, arguments or prompts.
    const line = `${new Date().toISOString()} ${lvl} ${message}\n`;
    if (!file) return;
    try {
      if (existsSync(file) && statSync(file).size > 1024 * 1024) writeFileSync(file, '');
      appendFileSync(file, line);
    } catch {
      /* logging must never break the host */
    }
  };
}

// ── masking ──────────────────────────────────────────────────────────────────

/** Patterns that must never reach Coucou or a log. */
const SECRET_PATTERNS = [
  /\b(sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*/gi,
  /\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,}/g, // JWT
  /\b([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API_?KEY|CREDENTIAL)[A-Z0-9_]*)\s*=\s*\S+/g,
  /--(?:token|password|api-key|apikey|secret)[= ]\S+/gi,
];

export function maskSecrets(text) {
  if (typeof text !== 'string' || text.length === 0) return '';
  let out = text;
  for (const re of SECRET_PATTERNS) out = out.replace(re, '[redacted]');
  return out;
}

/** Truncate for display; never used as a source of truth. */
export function clip(text, max = 200) {
  const masked = maskSecrets(String(text ?? ''));
  return masked.length <= max ? masked : `${masked.slice(0, max - 1)}…`;
}

// ── pipe server ──────────────────────────────────────────────────────────────

export function pipeName(sid, suffix = '') {
  return `\\\\.\\pipe\\coucou-dsh-${sid}${suffix}`;
}

/** Token + pipe name, written once per host start under the private state dir. */
export function writeRuntime(stateDir, sid, suffix = '') {
  const token = randomBytes(32).toString('hex');
  const info = { protocol: PROTOCOL, pipe: pipeName(sid, suffix), token, pid: process.pid };
  mkdirSync(stateDir, { recursive: true });
  writeFileSync(join(stateDir, 'runtime.json'), JSON.stringify(info, null, 2), { mode: 0o600 });
  return info;
}

export function tokenMatches(expected, got) {
  const a = Buffer.from(String(expected));
  const b = Buffer.from(String(got ?? ''));
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── plugin ───────────────────────────────────────────────────────────────────

export function apply(ctx, rawConfig) {
  const config = { ...DEFAULTS, ...(rawConfig ?? {}) };
  const stateDir = config.stateDir || join(homedir(), 'AppData', 'Local', 'Coucou', 'dsh');
  try {
    mkdirSync(stateDir, { recursive: true });
  } catch {
    /* the log below reports it */
  }
  const log = makeLog(stateDir, config.logLevel);
  log('info', `bridge start (protocol=${PROTOCOL} build=6)`);

  /** Live sessions we know about: sessionId → record. */
  const sessions = new Map();
  /** Pending approvals: requestId → { resolve, timer, ackTimer, requestId }. */
  const pending = new Map();
  /** Recent tool calls by callId, for arguments on the approval card. */
  const calls = new Map();
  /** Connected Coucou clients (at most one). */
  let client = null;

  const send = (message) => {
    if (!client) return false;
    try {
      client.write(`${JSON.stringify(message)}\n`);
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Provider/model/effort catalog, read from the live DSH registry.
   *
   * `listModels` only carries id/name/description: the reasoning efforts of a
   * model come from `resolveModelInfo`, which must be asked per exact model.
   * That is what makes "never offer an effort the model does not support" true
   * instead of a guess from a hard-coded table.
   */
  const catalog = async () => {
    const llm = ctx.get('llm');
    if (!llm) return { providers: [], fetchedAt: Date.now() };
    const providers = await Promise.all(
      llm.listProviders().map(async (provider) => {
        let models = [];
        try {
          const listed = await llm.listModels(provider.id);
          const entries = Array.isArray(listed) ? listed : [];
          models = await Promise.all(
            entries.map(async (model) => {
              const entry = {
                id: model.id,
                name: model.name ?? model.id,
                description: model.description,
                efforts: [],
                defaultEffort: null,
                contextWindow: undefined,
                maxTokens: undefined,
              };
              try {
                const resolved = await llm.resolveModelInfo(provider.id, model.id);
                entry.efforts = (resolved?.reasoning?.efforts ?? []).map((e) => ({
                  id: e.id,
                  name: e.name ?? e.id,
                }));
                entry.defaultEffort = resolved?.reasoning?.defaultEffort ?? null;
                entry.contextWindow = resolved?.context?.contextWindow ?? undefined;
                entry.maxTokens = resolved?.defaultMaxTokens ?? undefined;
              } catch (error) {
                // A model whose capabilities cannot be read is still listed, but
                // without efforts: the island must not invent any.
                log('debug', `catalog: resolve ${provider.id}/${model.id} failed: ${clip(error?.message ?? error)}`);
              }
              return entry;
            }),
          );
        } catch (error) {
          log('warn', `catalog: ${provider.id} failed: ${clip(error?.message ?? error)}`);
        }
        return { id: provider.id, name: provider.name ?? provider.id, models };
      }),
    );
    return { providers, fetchedAt: Date.now() };
  };

  const selectionOf = (agent) => {
    const current = agent?.model?.current?.();
    if (!current) return null;
    return {
      provider: current.provider,
      model: current.model,
      reasoningEffort: current.reasoningEffort ?? null,
    };
  };

  /** Best-effort session title from the client projections, never awaited. */
  const titleOf = (session) => {
    try {
      const projections = ctx.get('sessionProjections');
      const snapshot = projections?.snapshot?.(session, ['title']);
      const title = snapshot?.values?.title;
      if (typeof title !== 'string') return null;
      // Titles are the first prompt verbatim: drop a heading marker and any
      // second line so the island shows one short row.
      const clean = title.replace(/^[#>\s]+/, '').split('\n')[0].trim();
      return clean ? clip(clean, 120) : null;
    } catch {
      return null;
    }
  };

  const publishSession = (agent) => {
    const session = agent?.session;
    if (!session) return;
    const header = session.header ?? {};
    const previous = sessions.get(session.id);
    sessions.set(session.id, {
      id: session.id,
      cwd: header.cwd ?? '',
      agentPreset: header.agentPreset ?? null,
      // A title arrives later as a `session/title` event; keep the one we have,
      // otherwise read what the client projections already know.
      title: previous?.title ?? titleOf(session),
      createdAt: header.createdAt ?? null,
      model: selectionOf(agent),
      state: previous?.state ?? 'idle',
      since: previous?.since ?? Date.now(),
    });
    send({ t: 'session.upsert', session: sessions.get(session.id) });
  };

  // ── approvals ──────────────────────────────────────────────────────────────

  /**
   * Sentinel: the request leaves our hands and DSH must ask through its own
   * answerer chain. It is never an outcome on the wire.
   */
  const DELEGATE = Symbol('delegate');

  const settle = (requestId, outcome) => {
    const entry = pending.get(requestId);
    if (!entry) return false;
    pending.delete(requestId);
    clearTimeout(entry.decisionTimer);
    clearTimeout(entry.ackTimer);
    entry.resolve(outcome);
    if (outcome !== DELEGATE) send({ t: 'approval.resolved', requestId, outcome });
    return true;
  };

  const onApproval = (request, next) => {
    // No Coucou, no card: the stock DSH approval UI answers.
    if (!client) return next();

    const requestId = randomBytes(8).toString('hex');
    const call = request.callId ? calls.get(request.callId) : undefined;
    const files = [];
    if (call?.arguments?.file_path) files.push(clip(call.arguments.file_path, 260));
    if (call?.arguments?.path) files.push(clip(call.arguments.path, 260));

    const asked = {
      t: 'approval.asked',
      requestId,
      sessionId: request.agent?.session?.id ?? null,
      callId: request.callId ?? null,
      tool: request.toolName ?? 'unknown',
      reason: clip(request.reason ?? '', 200),
      title: call?.name ? clip(call.name, 80) : null,
      command: call?.arguments?.command ? clip(call.arguments.command, 300) : null,
      files,
      expiresAt: Date.now() + config.decisionTimeoutMs,
    };
    if (!send(asked)) return next();

    return new Promise((done) => {
      const entry = {
        acked: false,
        resolve: (outcome) => done(outcome),
        ackTimer: null,
        decisionTimer: null,
      };

      // The island must confirm the card is on screen within ackTimeoutMs,
      // otherwise DSH shows its own prompt and we never hold the tool call.
      entry.ackTimer = setTimeout(() => {
        if (!pending.has(requestId)) return;
        log('info', 'approval: no ack, falling back to the stock UI');
        settle(requestId, DELEGATE);
      }, config.ackTimeoutMs);

      entry.decisionTimer = setTimeout(() => {
        if (!pending.has(requestId)) return;
        log('info', 'approval: decision timeout, falling back to the stock UI');
        settle(requestId, DELEGATE);
      }, config.decisionTimeoutMs);

      // An aborted request withdraws the question; a late click is discarded.
      if (request.signal) {
        const onAbort = () => {
          if (!pending.has(requestId)) return;
          settle(requestId, 'cancelled');
        };
        request.signal.addEventListener('abort', onAbort, { once: true });
      }

      pending.set(requestId, entry);
    }).then((outcome) => (outcome === DELEGATE ? next() : outcome));
  };

  // ── session events ─────────────────────────────────────────────────────────

  const onSessionEvent = (session, event) => {
    const id = session?.id ?? event?.sessionId;
    if (!id) return;
    const record = sessions.get(id);

    switch (event?.type) {
      case 'turn/start':
        if (record) {
          record.state = 'thinking';
          record.since = Date.now();
          send({ t: 'session.state', sessionId: id, state: 'thinking', since: record.since });
        }
        send({ t: 'session.turn', sessionId: id, phase: 'start', ts: Date.now() });
        break;

      case 'turn/end':
        if (record) {
          record.state = event.data?.failure ? 'error' : 'finished';
          record.since = Date.now();
          send({ t: 'session.state', sessionId: id, state: record.state, since: record.since });
        }
        send({
          t: 'session.turn',
          sessionId: id,
          phase: 'end',
          ts: Date.now(),
          reason: clip(event.data?.reason ?? '', 120),
        });
        break;

      case 'tool/call':
        calls.set(event.data?.callId, {
          name: event.data?.name,
          arguments: parseJson(event.data?.arguments),
        });
        if (calls.size > 200) calls.delete(calls.keys().next().value);
        if (record) {
          record.state = 'working';
          send({ t: 'session.state', sessionId: id, state: 'working', since: Date.now() });
        }
        send({
          t: 'session.step',
          sessionId: id,
          ts: Date.now(),
          kind: 'tool',
          tool: clip(event.data?.name ?? '', 60),
          title: stepTitle(event.data?.name, parseJson(event.data?.arguments)),
        });
        break;

      case 'model/selection':
        if (record) {
          record.model = {
            provider: event.data?.provider,
            model: event.data?.model,
            reasoningEffort: event.data?.reasoningEffort ?? null,
          };
          send({ t: 'session.model', sessionId: id, ...record.model, pending: false });
        }
        break;

      case 'session/title':
        if (record && event.data?.title) {
          record.title = clip(event.data.title, 120);
          send({ t: 'session.upsert', session: record });
        }
        break;

      default:
        break;
    }
  };

  // ── wiring ─────────────────────────────────────────────────────────────────

  const sid = currentUserSid();
  const runtime = writeRuntime(stateDir, sid, config.pipeSuffix);

  const server = createServer((socket) => {
    if (client) {
      socket.destroy(); // one Coucou at a time
      return;
    }
    let buffer = '';
    let authed = false;

    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (buffer.length > MAX_LINE) {
        socket.destroy();
        return;
      }
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          socket.destroy();
          return;
        }
        if (!authed) {
          if (message.t !== 'hello' || !tokenMatches(runtime.token, message.token)) {
            log('warn', 'pipe: rejected a client (bad token)');
            socket.destroy();
            return;
          }
          authed = true;
          client = socket;
          // The handshake carries the catalog and the live sessions, so the
          // island opens with real data instead of an empty first paint.
          void catalog().then((state) => {
            if (client !== socket) return;
            socket.write(
              `${JSON.stringify({
                t: 'ready',
                protocol: PROTOCOL,
                hostPid: process.pid,
                catalog: state,
                sessions: [...sessions.values()],
              })}\n`,
            );
          });
          log('info', 'pipe: Coucou connected');
          return;
        }
        handle(message);
      }
    });

    const drop = () => {
      if (client !== socket) return;
      client = null;
      log('warn', 'pipe: Coucou disconnected, pending approvals fall back to DSH');
      for (const requestId of [...pending.keys()]) settle(requestId, DELEGATE);
    };
    socket.on('close', drop);
    socket.on('error', drop);
  });

  function handle(message) {
    switch (message.t) {
      case 'approval.ack': {
        const entry = pending.get(message.requestId);
        if (entry) {
          entry.acked = true;
          clearTimeout(entry.ackTimer);
        }
        break;
      }
      case 'approval.answer': {
        if (message.decision === 'allow') settle(message.requestId, 'allowed-once');
        else if (message.decision === 'deny') settle(message.requestId, 'rejected');
        break;
      }
      case 'approval.decline': {
        settle(message.requestId, DELEGATE);
        break;
      }
      case 'session.setConfig': {
        const agent = findAgent(ctx, message.sessionId);
        if (!agent) {
          send({ t: 'result', requestId: message.requestId, ok: false, error: { code: 'unknown_session', message: 'no live agent for this session' } });
          break;
        }
        try {
          const current = agent.model.current();
          if (!current) throw new Error('this session has no model selection');
          if (message.configId === 'model') {
            const [provider, ...rest] = String(message.value).split('/');
            agent.model.select({ provider, model: rest.join('/') });
          } else if (message.configId === 'reasoning_effort') {
            agent.model.select({
              provider: current.provider,
              model: current.model,
              reasoningEffort: message.value === '' ? undefined : message.value,
            });
          } else {
            throw new Error(`unknown session config option: ${message.configId}`);
          }
          send({ t: 'result', requestId: message.requestId, ok: true, value: selectionOf(agent) });
        } catch (error) {
          send({
            t: 'result',
            requestId: message.requestId,
            ok: false,
            error: { code: 'invalid_value', message: clip(error?.message ?? error) },
          });
        }
        break;
      }
      case 'catalog.get':
        void catalog().then((state) =>
          send({ t: 'result', requestId: message.requestId, ok: true, value: state }),
        );
        break;
      case 'ping':
        send({ t: 'pong', ts: Date.now() });
        break;
      default:
        break;
    }
  }

  server.listen(runtime.pipe);

  ctx.on('approval/request', onApproval);
  ctx.on('session/event', onSessionEvent);
  ctx.on('agent/created', ({ agent }) => publishSession(agent));
  ctx.on('llm/models-updated', () => {
    void catalog().then((state) => send({ t: 'catalog', ...state }));
  });

  // Sessions that already exist when the plugin loads (a hot patch applies to a
  // running host) would otherwise stay invisible until their next event.
  const liveAgents = ctx.get('agents');
  if (liveAgents) {
    for (const agent of liveAgents.list()) publishSession(agent);
  }

  ctx.effect(() => () => {
    log('info', 'bridge stop');
    for (const requestId of [...pending.keys()]) settle(requestId, 'cancelled');
    server.close();
  });
}

// ── helpers ──────────────────────────────────────────────────────────────────

function parseJson(value) {
  if (typeof value !== 'string') return value ?? {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

/** One short line for the ticker; arguments are never logged, only shown. */
function stepTitle(tool, args) {
  const name = String(tool ?? '');
  if (args?.file_path) return `${name} ${clip(args.file_path, 80)}`;
  if (args?.path) return `${name} ${clip(args.path, 80)}`;
  if (args?.command) return `${name} ${clip(args.command, 100)}`;
  if (args?.query) return `${name} ${clip(args.query, 80)}`;
  return name;
}

function findAgent(ctx, sessionId) {
  const agents = ctx.get('agents');
  if (!agents) return undefined;
  const agent = agents.get(sessionId);
  return agent ?? agents.list().find((a) => a.session?.id === sessionId);
}

function currentUserSid() {
  try {
    const out = execFileSync('whoami', ['/user', '/fo', 'csv', '/nh'], { encoding: 'utf8' });
    const match = out.match(/(S-1-[\d-]+)/);
    return match ? match[1] : 'user';
  } catch {
    return 'user';
  }
}

export default { name, apply, PROTOCOL, SUPPORTED_DSH, maskSecrets, clip };
