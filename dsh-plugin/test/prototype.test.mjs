/**
 * Prototype test bench for the Coucou ↔ DSH bridge plugin.
 *
 * These tests drive the plugin through a fake Cordis context and an in-memory
 * transport: no real DSH host, no real Coucou. Every scenario asserts the one
 * rule that matters — `allowed-once` is only ever returned after an explicit
 * answer for that exact request.
 *
 * Run: node --test dsh-plugin/test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, maskSecrets, clip, tokenMatches, pipeName, PROTOCOL } from '../bridge.mjs';
import { isPrivateSddl } from '../state-acl.mjs';

const SID = 'S-1-5-21-1-2-3-1001';

/** A Cordis-shaped context with the services the plugin reads. */
function fakeCtx({ withLlm = true, agents, approval } = {}) {
  const listeners = new Map();
  /** The real event registry shape the plugin reads to report answerer order. */
  const hooks = {};
  const services = new Map();
  const disposers = [];
  const registered = [];
  if (withLlm) {
    services.set('llm', {
      listProviders: () => [
        {
          id: 'test-provider',
          name: 'Test Provider',
        },
      ],
      listModels: async () => [{ id: 'model-a', name: 'Model A' }],
      resolveModelInfo: async () => ({
        reasoning: { efforts: [{ id: 'off', name: 'Off' }, { id: 'high', name: 'High' }], defaultEffort: 'high' },
        defaultMaxTokens: 1000,
      }),
    });
  }
  if (approval) services.set('approval', approval);
  services.set('agents', agents ?? { list: () => [] });

  const ctx = {
    listeners,
    services,
    disposers,
    registered,
    events: { _hooks: hooks },
    testChannel: null,
    on(event, handler, options) {
      registered.push({ event, options });
      const prepend = typeof options === 'object' ? options?.prepend === true : options === true;
      const list = hooks[event] ?? (hooks[event] = []);
      const record = { callback: handler };
      if (prepend) list.unshift(record);
      else list.push(record);
      if (!listeners.has(event)) listeners.set(event, []);
      const callbacks = listeners.get(event);
      if (prepend) callbacks.unshift(handler);
      else callbacks.push(handler);
    },
    get(name) {
      return services.get(name);
    },
    provide(name, value) {
      services.set(name, value);
    },
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    disposeAll() {
      for (const dispose of disposers.splice(0)) dispose();
    },
    fire(event, ...args) {
      const list = listeners.get(event) ?? [];
      return Promise.all(list.map((fn) => fn(...args)));
    },
    /**
     * Cordis waterfall semantics: listeners run in registration order, and the
     * first one that does not call `next()` answers the request.
     */
    waterfall(event, ...args) {
      const inner = args.pop();
      const list = [...(listeners.get(event) ?? [])];
      const dispatch = () => {
        const fn = list.shift();
        if (!fn) return inner();
        let called = false;
        const next = () => {
          if (called) throw new Error('next() called multiple times');
          called = true;
          return dispatch();
        };
        return fn(...args, next);
      };
      return dispatch();
    },
    has(event) {
      return (listeners.get(event) ?? []).length > 0;
    },
  };
  return ctx;
}

const openBridges = [];
test.afterEach(() => {
  while (openBridges.length > 0) openBridges.pop().disposeAll();
});

/** Starts the plugin with an in-memory channel and returns its handles. */
function startBridge(overrides = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'coucou-dsh-'));
  const ctx =
    overrides.ctx ??
    fakeCtx({ withLlm: overrides.withLlm !== false, agents: overrides.agents, approval: overrides.approval });
  apply(ctx, {
    stateDir,
    testChannel: true,
    skipSecurityChecks: true,
    logLevel: 'error',
    ...overrides,
  });
  const runtime = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
  openBridges.push(ctx);
  return { ctx, runtime, stateDir, channel: ctx.testChannel };
}

/** Sends one protocol frame from the notional Coucou client. */
function clientSend(bridge, message) {
  bridge.channel.inject(`${JSON.stringify(message)}\n`);
}

/** Authenticates the notional Coucou client. */
function handshake(bridge, token = bridge.runtime.token) {
  clientSend(bridge, { t: 'hello', protocol: PROTOCOL, token, client: 'test' });
  return bridge.channel.outgoing.join('');
}

/** Finds the last decoded frame the plugin wrote. */
function lastFrame(bridge) {
  const lines = bridge.channel.outgoing.join('').trim().split('\n').filter(Boolean);
  return lines.length ? JSON.parse(lines[lines.length - 1]) : null;
}

function approvalRequest(overrides = {}) {
  return {
    agent: { session: { id: 'session-test', header: { cwd: 'C:/work' } } },
    toolName: 'pwsh',
    callId: 'call-1',
    reason: 'escalate sandbox to danger-full-access',
    ...overrides,
  };
}

// ── the rule that must never break ───────────────────────────────────────────

test('no client: the request falls back to DSH without waiting', async () => {
  const { ctx } = startBridge();
  let delegated = 0;
  const [outcome] = await ctx.fire('approval/request', approvalRequest(), async () => {
    delegated++;
    return 'unavailable';
  });
  assert.equal(delegated, 1, 'next() must be called');
  assert.notEqual(outcome, 'allowed-once');
});

test('client connected but never acks: falls back to DSH', async () => {
  const bridge = startBridge({ ackTimeoutMs: 200 });
  handshake(bridge);
  let delegated = 0;
  const [outcome] = await bridge.ctx.fire('approval/request', approvalRequest(), async () => {
    delegated++;
    return 'unavailable';
  });
  assert.equal(delegated, 1, 'no ack must delegate');
  assert.notEqual(outcome, 'allowed-once');
});

test('ack + allow returns allowed-once exactly once', async () => {
  const bridge = startBridge();
  handshake(bridge);
  const pending = bridge.ctx.fire('approval/request', approvalRequest(), async () => 'unavailable');
  const asked = lastFrame(bridge);
  assert.equal(asked.t, 'approval.asked');
  clientSend(bridge, { t: 'approval.ack', requestId: asked.requestId });
  clientSend(bridge, { t: 'approval.answer', requestId: asked.requestId, decision: 'allow' });
  const [outcome] = await pending;
  assert.equal(outcome, 'allowed-once');
});

test('the card names the session the current event contract carries', async () => {
  const bridge = startBridge();
  handshake(bridge);
  const pending = bridge.ctx.fire(
    'approval/request',
    approvalRequest({ agent: { id: 'session-from-agent' } }),
    async () => 'unavailable',
  );
  const asked = lastFrame(bridge);
  assert.equal(asked.t, 'approval.asked');
  assert.equal(asked.sessionId, 'session-from-agent');
  clientSend(bridge, { t: 'approval.answer', requestId: asked.requestId, decision: 'deny' });
  await pending;
});

test('ack + deny returns rejected', async () => {
  const bridge = startBridge();
  handshake(bridge);
  const pending = bridge.ctx.fire('approval/request', approvalRequest(), async () => 'unavailable');
  const asked = lastFrame(bridge);
  clientSend(bridge, { t: 'approval.ack', requestId: asked.requestId });
  clientSend(bridge, { t: 'approval.answer', requestId: asked.requestId, decision: 'deny' });
  const [outcome] = await pending;
  assert.equal(outcome, 'rejected');
});

test('decline sends the user to the DSH prompt', async () => {
  const bridge = startBridge();
  handshake(bridge);
  let delegated = 0;
  const pending = bridge.ctx.fire('approval/request', approvalRequest(), async () => {
    delegated++;
    return 'unavailable';
  });
  const asked = lastFrame(bridge);
  clientSend(bridge, { t: 'approval.ack', requestId: asked.requestId });
  clientSend(bridge, { t: 'approval.decline', requestId: asked.requestId });
  await pending;
  assert.equal(delegated, 1, 'decline must reach the stock UI');
});

test('disconnect while a card waits: nothing is granted', async () => {
  const bridge = startBridge();
  handshake(bridge);
  let delegated = 0;
  const pending = bridge.ctx.fire('approval/request', approvalRequest(), async () => {
    delegated++;
    return 'unavailable';
  });
  const asked = lastFrame(bridge);
  clientSend(bridge, { t: 'approval.ack', requestId: asked.requestId });
  bridge.channel.kick('test disconnect');
  const [outcome] = await pending;
  assert.equal(delegated, 1, 'a lost connection must delegate');
  assert.notEqual(outcome, 'allowed-once');
});

test('a cancelled request settles as cancelled and ignores a late click', async () => {
  const bridge = startBridge();
  handshake(bridge);
  const controller = new AbortController();
  const pending = bridge.ctx.fire(
    'approval/request',
    approvalRequest({ signal: controller.signal }),
    async () => 'unavailable',
  );
  const asked = lastFrame(bridge);
  clientSend(bridge, { t: 'approval.ack', requestId: asked.requestId });
  controller.abort();
  const [outcome] = await pending;
  assert.equal(outcome, 'cancelled');

  clientSend(bridge, { t: 'approval.answer', requestId: asked.requestId, decision: 'allow' });
  assert.equal(outcome, 'cancelled', 'a late click must not resurrect the request');
});

test('a decision timeout hands the card back to DSH', async () => {
  const bridge = startBridge({ ackTimeoutMs: 100, decisionTimeoutMs: 200 });
  handshake(bridge);
  let delegated = 0;
  const pending = bridge.ctx.fire('approval/request', approvalRequest(), async () => {
    delegated++;
    return 'unavailable';
  });
  const asked = lastFrame(bridge);
  clientSend(bridge, { t: 'approval.ack', requestId: asked.requestId });
  const [outcome] = await pending;
  assert.equal(delegated, 1, 'an unanswered card must reach the stock UI');
  assert.notEqual(outcome, 'allowed-once');
});

test('a wrong token is rejected and no card is offered', async () => {
  const bridge = startBridge();
  handshake(bridge, 'not-the-token');
  const ready = bridge.channel.outgoing.join('');
  assert.doesNotMatch(ready, /"t":"ready"/);

  let delegated = 0;
  const [outcome] = await bridge.ctx.fire('approval/request', approvalRequest(), async () => {
    delegated++;
    return 'unavailable';
  });
  assert.equal(delegated, 1);
  assert.notEqual(outcome, 'allowed-once');
});

test('a wrong protocol version is refused', async () => {
  const bridge = startBridge();
  clientSend(bridge, { t: 'hello', protocol: 999, token: bridge.runtime.token });
  assert.doesNotMatch(bridge.channel.outgoing.join(''), /"t":"ready"/);
});

// ── the seam is chosen by capability, never by version tag ───────────────────

test('a missing llm service costs the catalog, never the approval seam', () => {
  const bridge = startBridge({ withLlm: false });
  // The model list is a convenience read lazily; approvals are the reason the
  // plugin exists. A host that cannot list models must still get a card.
  assert.equal(bridge.ctx.has('approval/request'), true, 'must still intercept approvals');
});

test('a DSH whose version cannot be read still gets the approval seam', () => {
  // The tests run under plain Node, where the DSH manifest is nowhere near
  // `process.execPath`: the version read fails. That used to be fatal — the
  // seam was switched off on a version string the plugin could not even read.
  const bridge = startBridge();
  assert.equal(bridge.ctx.has('approval/request'), true);
});

test('the plugin never asks the version before registering the answerer', () => {
  // Nothing in the file may gate the seam on a version tag again: a DSH update
  // that keeps the API must keep the approvals.
  const source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /isSupportedDsh|SUPPORTED_DSH/);
});

test('the island registers its answerer first, ahead of any browser answerer', () => {
  const bridge = startBridge();
  const registered = bridge.ctx.registered.filter((r) => r.event === 'approval/request');
  assert.equal(registered.length, 1);
  assert.equal(registered[0].options?.prepend, true, 'a plain listener would sit behind DSH’s own UI');
});

test('the request reaches the island, not the browser answerer that registered first', async () => {
  // The live defect: DSH’s browser approval UI is an `approval/request`
  // answerer registered when its client connects. A waterfall stops at the
  // first listener that does not call next(), so the island — registered later,
  // e.g. by a hot patch — never saw a request and DSH prompted in its own
  // window. This is that order, reproduced.
  const ctx = fakeCtx();
  let browserAsked = 0;
  ctx.on('approval/request', async () => {
    browserAsked++;
    return 'allowed-once';
  });

  const bridge = startBridge({ ctx });
  handshake(bridge);
  const pending = ctx.waterfall('approval/request', approvalRequest(), async () => 'unavailable');

  const asked = lastFrame(bridge);
  assert.equal(asked.t, 'approval.asked', 'the island must be asked first');
  clientSend(bridge, { t: 'approval.ack', requestId: asked.requestId });
  clientSend(bridge, { t: 'approval.answer', requestId: asked.requestId, decision: 'deny' });

  assert.equal(await pending, 'rejected');
  assert.equal(browserAsked, 0, 'the browser answerer must not have seen the request');
});

test('when the island cannot show the card it still hands the request on', async () => {
  // Prepend must not become a veto: no client, no ack, decline or timeout all
  // call next(), so DSH's own prompt still answers.
  const bridge = startBridge();
  let delegated = 0;
  const outcome = await bridge.ctx.waterfall('approval/request', approvalRequest(), async () => {
    delegated++;
    return 'unavailable';
  });
  assert.equal(delegated, 1);
  assert.notEqual(outcome, 'allowed-once');
});

test('the session carries the approval policy DSH will apply', async () => {
  const approval = {
    config: { policy: 'ask' },
    overrideOf: (session) => (session?.id === 'session-test' ? 'never' : undefined),
  };
  const bridge = startBridge({ approval });
  handshake(bridge);
  const agent = { session: { id: 'session-test', header: { cwd: 'C:/work' } } };
  await bridge.ctx.fire('agent/created', { agent });

  const upsert = bridge.channel.outgoing
    .join('')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line))
    .filter((f) => f.t === 'session.upsert')
    .pop();
  assert.equal(upsert.session.approvalPolicy, 'never', 'a session policy of never means no card can appear');
});

test('ready reports the approval policy and the version, without gating on it', async () => {
  const bridge = startBridge({ approval: { config: { policy: 'never' }, overrideOf: () => undefined } });
  handshake(bridge);
  await new Promise((resolve) => setTimeout(resolve, 50));
  const ready = JSON.parse(bridge.channel.outgoing.join('').trim().split('\n')[0]);
  assert.equal(ready.approvals.enabled, true);
  assert.equal(ready.approvals.policy, 'never');
  assert.equal(ready.compatibility.ok, true);
});

test('a supported host does register the approval answerer', () => {
  const bridge = startBridge();
  assert.equal(bridge.ctx.has('approval/request'), true);
});

test('an event for a session the plugin never saw still reaches the island', async () => {
  // The host hot-patches a running process: an agent can appear after this
  // plugin loaded, and `agent/created` for it is already in the past. Its
  // events used to be dropped for want of a record, so the island showed a
  // session that did nothing.
  const live = [];
  const agent = { session: { id: 'session-late', header: { cwd: 'C:/work' } } };
  const bridge = startBridge({ agents: { list: () => live, get: () => live[0] } });
  handshake(bridge);
  live.push(agent);
  await bridge.ctx.fire('session/event', agent.session, { type: 'turn/start' });

  const frames = bridge.channel.outgoing.join('').trim().split('\n').map((line) => JSON.parse(line));
  assert.ok(
    frames.some((f) => f.t === 'session.upsert' && f.session?.id === 'session-late'),
    'the session must be published from its first event',
  );
  assert.ok(
    frames.some((f) => f.t === 'session.state' && f.sessionId === 'session-late' && f.state === 'thinking'),
    'and its state must follow',
  );
});

test('a subagent is published with the marks that tell it apart from a dialog', async () => {
  // DSH opens a session for itself when it delegates. The island must be able to
  // tell that session from one a person opened: a pill for a subagent would
  // appear and vanish inside one turn, for no reason the person can see.
  const sub = {
    session: {
      id: 'session-sub',
      header: { cwd: 'C:/work', origin: 'subagent', parentSession: 'session-parent', delegationDepth: 1 },
    },
  };
  const bridge = startBridge({ agents: { list: () => [sub], get: () => sub } });
  handshake(bridge);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const frames = bridge.channel.outgoing.join('').trim().split('\n').map((line) => JSON.parse(line));
  const ready = frames.find((f) => f.t === 'ready');
  const published = ready.sessions.find((s) => s.id === 'session-sub');
  assert.ok(published, 'the subagent is published like any session');
  assert.equal(published.origin, 'subagent', 'and says what it is');
  assert.equal(published.parentSession, 'session-parent', 'and which dialog spawned it');
  assert.equal(published.delegationDepth, 1);
});

test('a dialog is published with no subagent marks', async () => {
  const own = { session: { id: 'session-own', header: { cwd: 'C:/work' } } };
  const bridge = startBridge({ agents: { list: () => [own], get: () => own } });
  handshake(bridge);
  await new Promise((resolve) => setTimeout(resolve, 50));

  const frames = bridge.channel.outgoing.join('').trim().split('\n').map((line) => JSON.parse(line));
  const ready = frames.find((f) => f.t === 'ready');
  const published = ready.sessions.find((s) => s.id === 'session-own');
  assert.ok(published, 'the dialog is published');
  assert.equal(published.origin, null, 'a dialog has no origin');
  assert.equal(published.parentSession, null, 'and no parent');
});

test('ready reports the security and compatibility state', async () => {
  const bridge = startBridge();
  handshake(bridge);
  // `ready` is written after the catalog read resolves.
  await new Promise((resolve) => setTimeout(resolve, 50));
  const ready = JSON.parse(bridge.channel.outgoing.join('').trim().split('\n')[0]);
  assert.equal(ready.t, 'ready');
  assert.equal(ready.approvals.enabled, true);
  assert.equal(ready.security.tokenPrivate, true);
  assert.equal(ready.pipe.hardened, true);
  assert.equal(ready.compatibility.ok, true);
});

// ── catalog ──────────────────────────────────────────────────────────────────

test('the catalog reports models with their own efforts', async () => {
  const bridge = startBridge();
  handshake(bridge);
  clientSend(bridge, { t: 'catalog.get', requestId: 'c1' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  const result = lastFrame(bridge);
  assert.equal(result.t, 'result');
  const model = result.value.providers[0].models[0];
  assert.deepEqual(model.efforts.map((e) => e.id), ['off', 'high']);
  assert.equal(model.defaultEffort, 'high');
});

// ── masking and helpers ─────────────────────────────────────────────────────

test('secrets never survive masking', () => {
  const cases = [
    'export API_KEY=sk-abcdef0123456789abcdef',
    'curl -H "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"',
    'ghp_0123456789abcdefghijklmnopqrstuvwx',
    'pwsh --token supersecretvalue123',
  ];
  for (const text of cases) {
    const masked = maskSecrets(text);
    assert.match(masked, /\[redacted\]/, `expected a redaction in: ${masked}`);
    assert.doesNotMatch(
      masked,
      /0123456789|abcdefghijklmnopqrstuvwxyz123456|ghp_0123456789|supersecretvalue123/,
    );
  }
});

test('clip shortens without leaking and keeps ordinary text', () => {
  assert.equal(clip('hello', 10), 'hello');
  assert.ok(clip('x'.repeat(500), 50).length <= 50);
});

test('token comparison is exact', () => {
  assert.equal(tokenMatches('abc', 'abc'), true);
  assert.equal(tokenMatches('abc', 'abd'), false);
  assert.equal(tokenMatches('abc', ''), false);
  assert.equal(tokenMatches('abc', undefined), false);
});

test('the pipe name carries the user SID', () => {
  assert.equal(pipeName('S-1-5-21-1'), '\\\\.\\pipe\\coucou-dsh-S-1-5-21-1');
});

test('a private DACL is recognised and a wide one is not', () => {
  const privateDir = `O:${SID}G:${SID}D:PAI(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FA;;;${SID})`;
  assert.equal(isPrivateSddl(privateDir, SID), true);
  // Everyone can read: the exact shape Node's own pipe had.
  assert.equal(isPrivateSddl(`D:(A;;FA;;;SY)(A;;FA;;;${SID})(A;;FR;;;WD)(A;;FR;;;AN)`, SID), false);
  // Inherited, so a parent change could widen it.
  assert.equal(isPrivateSddl(`D:(A;;FA;;;SY)(A;;FA;;;${SID})`, SID), false);
  // A second local account is a stranger.
  assert.equal(isPrivateSddl(`D:P(A;;FA;;;SY)(A;;FA;;;S-1-5-21-9-9-9-1002)`, SID), false);
});