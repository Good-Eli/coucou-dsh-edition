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
import { dirname, join } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { mkdirSync, writeFileSync, appendFileSync, statSync, existsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { homedir } from 'node:os';

import { SecurePipe } from './secure-pipe.mjs';
import { isPrivateSddl, pathSddl, securePath } from './state-acl.mjs';

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

/** Absolute path to `koffi`, or null. Needed to create a pipe we control. */
function resolveKoffiPath() {
  const root = join(dirname(process.execPath), 'resources');
  const candidates = [
    join(root, 'app.asar', 'dsh', 'node_modules', 'koffi', 'index.cjs'),
    join(root, 'app.asar.unpacked', 'dsh', 'node_modules', 'koffi', 'index.cjs'),
    join(root, 'app', 'dsh', 'node_modules', 'koffi', 'index.cjs'),
  ];
  for (const candidate of candidates) {
    try {
      if (existsSync(candidate)) return candidate;
    } catch {
      /* an unreadable candidate is simply not the one */
    }
  }
  return null;
}

/** The DSH build this host runs, read from the app rather than assumed. */
function resolveDshVersion() {
  const root = join(dirname(process.execPath), 'resources');
  const candidates = [
    join(root, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(root, 'app.asar.unpacked', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
    join(root, 'app', 'dsh', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'),
  ];
  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;
      const manifest = JSON.parse(readFileSync(candidate, 'utf8'));
      if (typeof manifest.version === 'string') return manifest.version;
    } catch {
      /* try the next layout */
    }
  }
  return null;
}

/**
 * Checks that this DSH can actually support the integration.
 *
 * A version this plugin was not written against, or a missing registry method,
 * disables the approval seam only: DSH keeps its own prompts and its own model
 * handling, and nothing here can grant a permission.
 */
function inspectCompatibility(ctx, config, log) {
  const problems = [];
  const version = resolveDshVersion();

  if (config.skipVersionCheck !== true) {
    if (!version) problems.push('the DSH version could not be read');
    else if (!SUPPORTED_DSH.includes(version)) {
      problems.push(`DSH ${version} is not supported (expected ${SUPPORTED_DSH.join(', ')})`);
    }
  }

  if (typeof ctx.on !== 'function') problems.push('ctx.on is missing');

  const llm = ctx.get?.('llm');
  if (!llm) {
    problems.push('the llm service is missing');
  } else {
    for (const method of ['listProviders', 'listModels', 'resolveModelInfo']) {
      if (typeof llm[method] !== 'function') problems.push(`llm.${method} is missing`);
    }
  }

  if (problems.length > 0) log('warn', `compat: ${problems.join('; ')}`);
  else log('info', `compat: DSH ${version} looks usable`);

  return { ok: problems.length === 0, version, problems };
}

/**
 * Gives the state directory, and later the token file, an explicit DACL.
 *
 * `mode: 0o600` proves nothing on NTFS, so the result is read back and the
 * caller is told whether the protection is real.
 */
function hardenStateDir(stateDir, sid, log, skipSecurity = false) {
  const result = { dirPrivate: false, dirSddl: null, filePrivate: false };

  if (skipSecurity) {
    return {
      ...result,
      dirPrivate: true,
      filePrivate: true,
      verifyFile: () => true,
    };
  }

  try {
    mkdirSync(stateDir, { recursive: true });
    result.dirSddl = securePath(stateDir, sid, { directory: true });
    result.dirPrivate = isPrivateSddl(result.dirSddl, sid);
    log(
      result.dirPrivate ? 'info' : 'warn',
      `state: directory ACL ${result.dirPrivate ? 'private' : 'TOO WIDE'} ${clip(result.dirSddl ?? '', 160)}`,
    );
  } catch (error) {
    log('warn', `state: cannot secure the directory: ${clip(error?.message ?? error)}`);
  }

  return {
    ...result,
    /** Secures the token file and reports whether it ended up private. */
    verifyFile(path) {
      try {
        const sddl = securePath(path, sid);
        result.filePrivate = isPrivateSddl(sddl, sid);
        log(
          result.filePrivate ? 'info' : 'warn',
          `state: token ACL ${result.filePrivate ? 'private' : 'TOO WIDE'} ${clip(sddl ?? '', 160)}`,
        );
        return result.filePrivate;
      } catch (error) {
        log('warn', `state: cannot secure the token: ${clip(error?.message ?? error)}`);
        return false;
      }
    },
  };
}

/**
 * Builds the transport Coucou talks to.
 *
 * Preferred: a pipe we create ourselves, whose DACL names only this user.
 * Fallback: Node's own pipe, which Windows gives the process default DACL
 * (`Everyone` can read it) — only used when explicitly allowed.
 */
function createChannel({ pipeName: name, sid, log, onText, onClose, allowUnhardened, testChannel }) {
  if (testChannel) {
    // Test-only transport: the approval state machine does not depend on how
    // bytes arrive, so the suite drives it in memory instead of over a pipe.
    const channel = {
      available: true,
      kind: 'test',
      hardened: true,
      sddl: 'D:P(A;;FA;;;SY)(A;;FA;;;BA)',
      outgoing: [],
      start() {},
      stop() {},
      kick() {
        onClose();
      },
      write(text) {
        channel.outgoing.push(text);
        return true;
      },
      inject(text) {
        onText(text);
      },
    };
    return channel;
  }

  const koffiPath = resolveKoffiPath();
  if (koffiPath) {
    const pipe = new SecurePipe({
      pipeName: name,
      sid,
      koffiPath,
      log,
      onFatal: () => onClose(),
    });
    pipe.onData = (text) => onText(text);
    pipe.onDisconnect = () => onClose();
    return {
      available: true,
      kind: 'secure-pipe',
      // The host only reports ready after creating the pipe with our own
      // descriptor; until then, and if it dies, no client can connect at all.
      get hardened() {
        return pipe.ready;
      },
      get sddl() {
        return pipe.actualSddl ?? null;
      },
      start: () => {
        pipe.start();
      },
      write: (text) => pipe.write(text),
      kick: () => pipe.kick(),
      stop: () => pipe.stop(),
    };
  }

  if (!allowUnhardened) {
    log(
      'error',
      'pipe: koffi is unavailable, so a private pipe cannot be created; integration disabled',
    );
    return { available: false, kind: 'none', hardened: false, sddl: null, start() {}, write: () => false, kick() {}, stop() {} };
  }

  log('warn', 'pipe: falling back to an unhardened pipe (allowUnhardenedPipe)');
  let socket = null;
  const server = createServer((incoming) => {
    if (socket) {
      incoming.destroy(); // one Coucou at a time
      return;
    }
    socket = incoming;
    incoming.setEncoding('utf8');
    incoming.on('data', (text) => onText(text));
    const drop = () => {
      if (socket !== incoming) return;
      socket = null;
      onClose();
    };
    incoming.on('close', drop);
    incoming.on('error', drop);
  });

  return {
    available: true,
    kind: 'net-unhardened',
    hardened: false,
    sddl: null,
    start: () => server.listen(name),
    write: (text) => {
      if (!socket) return false;
      socket.write(text);
      return true;
    },
    kick: () => {
      if (!socket) return;
      const doomed = socket;
      socket = null;
      doomed.destroy();
      onClose();
    },
    stop: () => {
      if (socket) socket.destroy();
      server.close();
    },
  };
}

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
  /** True while an authenticated Coucou holds the pipe (at most one). */
  let connected = false;

  const send = (message) => {
    if (!connected) return false;
    try {
      return channel.write(`${JSON.stringify(message)}\n`) !== false;
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
    if (!connected) return next();

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
  const security = hardenStateDir(stateDir, sid, log, config.skipSecurityChecks === true);
  const runtime = writeRuntime(stateDir, sid, config.pipeSuffix);
  const tokenPrivate = security.verifyFile(join(stateDir, 'runtime.json'));

  const compat = inspectCompatibility(ctx, config, log);

  let authed = false;
  let lineBuffer = '';

  const resetClient = (reason) => {
    if (!authed) return;
    authed = false;
    connected = false;
    lineBuffer = '';
    log('warn', `pipe: ${reason}; pending approvals fall back to DSH`);
    for (const requestId of [...pending.keys()]) settle(requestId, DELEGATE);
  };

  /** Feeds raw text from whichever transport is active into the protocol. */
  const feed = (text) => {
    lineBuffer += text;
    if (lineBuffer.length > MAX_LINE) {
      channel.kick('frame too large');
      return;
    }
    let index;
    while ((index = lineBuffer.indexOf('\n')) >= 0) {
      const line = lineBuffer.slice(0, index);
      lineBuffer = lineBuffer.slice(index + 1);
      if (!line.trim()) continue;

      let message;
      try {
        message = JSON.parse(line);
      } catch {
        channel.kick('bad frame');
        return;
      }

      if (!authed) {
        if (message.t !== 'hello' || message.protocol !== PROTOCOL || !tokenMatches(runtime.token, message.token)) {
          log('warn', 'pipe: rejected a client (protocol or token mismatch)');
          channel.kick('auth failed');
          return;
        }
        authed = true;
        connected = true;
        // The handshake carries the catalog and the live sessions, so the
        // island opens with real data instead of an empty first paint.
        void catalog().then((catalogState) => {
          if (!authed) return;
          send({
            t: 'ready',
            protocol: PROTOCOL,
            hostPid: process.pid,
            pipe: { hardened: channel.hardened, sddl: channel.sddl ?? null },
            security: {
              tokenPrivate,
              directoryPrivate: security.dirPrivate,
            },
            compatibility: { ok: compat.ok, version: compat.version, problems: compat.problems },
            approvals: { enabled: approvalsEnabled },
            catalog: catalogState,
            sessions: [...sessions.values()],
          });
        });
        log('info', 'pipe: Coucou connected');
        return;
      }
      handle(message);
    }
  };

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

  // ── transport ──────────────────────────────────────────────────────────────

  const channel = createChannel({
    pipeName: runtime.pipe,
    sid,
    log,
    onText: feed,
    onClose: () => resetClient('Coucou disconnected'),
    allowUnhardened: config.allowUnhardenedPipe === true,
    testChannel: config.testChannel === true,
  });
  channel.start();
  if (config.testChannel) ctx.testChannel = channel;
  log('info', 'pipe: ' + channel.kind + ' starting');

  /**
   * Approvals may only be intercepted when a DSH we understand is running and
   * the token file is actually private. A pipe that is missing or dead is not
   * a risk: without a client, every request delegates to DSH's own prompt.
   */
  const approvalsEnabled = compat.ok && tokenPrivate;
  if (!approvalsEnabled) {
    const why = [];
    if (!compat.ok) why.push('incompatible DSH');
    if (!tokenPrivate) why.push('token file is not private');
    log('warn', `approvals: disabled (${why.join(', ')}); DSH keeps its own prompts`);
  } else {
    ctx.on('approval/request', onApproval);
  }

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
    channel.stop();
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
