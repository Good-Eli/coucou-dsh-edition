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
function fakeCtx({ withLlm = true } = {}) {
  const listeners = new Map();
  const services = new Map();
  const disposers = [];
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
  services.set('agents', { list: () => [] });

  return {
    listeners,
    services,
    disposers,
    testChannel: null,
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, []);
      listeners.get(event).push(handler);
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
    has(event) {
      return (listeners.get(event) ?? []).length > 0;
    },
  };
}

const openBridges = [];
test.afterEach(() => {
  while (openBridges.length > 0) openBridges.pop().disposeAll();
});

/** Starts the plugin with an in-memory channel and returns its handles. */
function startBridge(overrides = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'coucou-dsh-'));
  const ctx = fakeCtx({ withLlm: overrides.withLlm !== false });
  apply(ctx, {
    stateDir,
    testChannel: true,
    skipSecurityChecks: true,
    skipVersionCheck: true,
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

// ── the compatibility gate ───────────────────────────────────────────────────

test('a DSH without the llm service gets no approval answerer', () => {
  const bridge = startBridge({ withLlm: false });
  assert.equal(bridge.ctx.has('approval/request'), false, 'must not intercept approvals');
});

test('a supported host does register the approval answerer', () => {
  const bridge = startBridge();
  assert.equal(bridge.ctx.has('approval/request'), true);
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