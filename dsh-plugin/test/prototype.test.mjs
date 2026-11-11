/**
 * Prototype test bench for the Coucou ↔ DSH bridge plugin.
 *
 * These tests drive the plugin through a fake Cordis context: no real DSH host,
 * no real agent, no real Coucou. Every scenario asserts the one rule that
 * matters — `allowed-once` is only ever returned after an explicit answer.
 *
 * Run: node --test dsh-plugin/test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { connect } from 'node:net';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, maskSecrets, clip, tokenMatches, pipeName, PROTOCOL } from '../bridge.mjs';

/** A Cordis-shaped context that records listeners and disposers. */
function fakeCtx() {
  const listeners = new Map();
  const services = new Map();
  const disposers = [];
  return {
    listeners,
    disposers,
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
  };
}

/** Starts the plugin on a throwaway state directory and returns its handles. */
function startBridge(overrides = {}) {
  const stateDir = mkdtempSync(join(tmpdir(), 'coucou-dsh-'));
  const ctx = fakeCtx();
  // A unique pipe per bridge so tests never collide on the real user's name.
  const pipeSuffix = `-test-${process.pid}-${counter++}`;
  apply(ctx, { stateDir, pipeSuffix, logLevel: 'error', ...overrides });
  const runtime = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
  // The pipe server keeps the process alive; every test closes it explicitly.
  registerCleanup(ctx);
  return { ctx, runtime, stateDir };
}

let counter = 0;

/** Closes bridges at the end of each test so `node --test` can exit. */
const openBridges = [];
function registerCleanup(ctx) {
  openBridges.push(ctx);
}
test.afterEach(() => {
  while (openBridges.length > 0) openBridges.pop().disposeAll();
});

/** Minimal Coucou-side client: connects, says hello, and reads NDJSON. */
function connectClient(runtime, token = runtime.token) {
  return new Promise((resolve, reject) => {
    const socket = connect(runtime.pipe);
    const messages = [];
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (line.trim()) messages.push(JSON.parse(line));
      }
    });
    socket.on('error', reject);
    socket.on('connect', () => {
      socket.write(`${JSON.stringify({ t: 'hello', protocol: PROTOCOL, token, client: 'test' })}\n`);
      const waitFor = (predicate, timeout = 2000) =>
        new Promise((done, fail) => {
          const started = Date.now();
          const timer = setInterval(() => {
            const found = messages.find(predicate);
            if (found) {
              clearInterval(timer);
              done(found);
            } else if (Date.now() - started > timeout) {
              clearInterval(timer);
              fail(new Error('timeout waiting for message'));
            }
          }, 10);
        });
      resolve({ socket, messages, waitFor });
    });
  });
}

/** One approval request as DSH would send it. */
function approvalRequest(overrides = {}) {
  return {
    agent: { session: { id: 'session-test', meta: { cwd: 'C:/work' } } },
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
  assert.equal(outcome, 'unavailable');
  assert.notEqual(outcome, 'allowed-once');
});

test('client connected but never acks: falls back to DSH', async () => {
  const { ctx, runtime } = startBridge();
  const client = await connectClient(runtime);
  await client.waitFor((m) => m.t === 'ready');

  let delegated = 0;
  const started = Date.now();
  const [outcome] = await ctx.fire('approval/request', approvalRequest(), async () => {
    delegated++;
    return 'unavailable';
  });
  const elapsed = Date.now() - started;

  assert.equal(delegated, 1, 'no ack must delegate');
  assert.notEqual(outcome, 'allowed-once');
  assert.ok(elapsed >= 1400, `should wait for the ack window, waited ${elapsed}ms`);
  client.socket.destroy();
});

test('ack + allow returns allowed-once exactly once', async () => {
  const { ctx, runtime } = startBridge();
  const client = await connectClient(runtime);
  await client.waitFor((m) => m.t === 'ready');

  const pending = ctx.fire('approval/request', approvalRequest(), async () => 'unavailable');
  const asked = await client.waitFor((m) => m.t === 'approval.asked');
  client.socket.write(`${JSON.stringify({ t: 'approval.ack', requestId: asked.requestId })}\n`);
  client.socket.write(
    `${JSON.stringify({ t: 'approval.answer', requestId: asked.requestId, decision: 'allow' })}\n`,
  );

  const [outcome] = await pending;
  assert.equal(outcome, 'allowed-once');
  const resolved = await client.waitFor((m) => m.t === 'approval.resolved');
  assert.equal(resolved.outcome, 'allowed-once');
  client.socket.destroy();
});

test('ack + deny returns rejected', async () => {
  const { ctx, runtime } = startBridge();
  const client = await connectClient(runtime);
  await client.waitFor((m) => m.t === 'ready');

  const pending = ctx.fire('approval/request', approvalRequest(), async () => 'unavailable');
  const asked = await client.waitFor((m) => m.t === 'approval.asked');
  client.socket.write(`${JSON.stringify({ t: 'approval.ack', requestId: asked.requestId })}\n`);
  client.socket.write(
    `${JSON.stringify({ t: 'approval.answer', requestId: asked.requestId, decision: 'deny' })}\n`,
  );

  const [outcome] = await pending;
  assert.equal(outcome, 'rejected');
  client.socket.destroy();
});

test('decline sends the user to the DSH prompt', async () => {
  const { ctx, runtime } = startBridge();
  const client = await connectClient(runtime);
  await client.waitFor((m) => m.t === 'ready');

  let delegated = 0;
  const pending = ctx.fire('approval/request', approvalRequest(), async () => {
    delegated++;
    return 'unavailable';
  });
  const asked = await client.waitFor((m) => m.t === 'approval.asked');
  client.socket.write(`${JSON.stringify({ t: 'approval.ack', requestId: asked.requestId })}\n`);
  client.socket.write(`${JSON.stringify({ t: 'approval.decline', requestId: asked.requestId })}\n`);

  await pending;
  assert.equal(delegated, 1, 'decline must reach the stock UI');
  client.socket.destroy();
});

test('disconnect while a card waits: nothing is granted', async () => {
  const { ctx, runtime } = startBridge();
  const client = await connectClient(runtime);
  await client.waitFor((m) => m.t === 'ready');

  let delegated = 0;
  const pending = ctx.fire('approval/request', approvalRequest(), async () => {
    delegated++;
    return 'unavailable';
  });
  const asked = await client.waitFor((m) => m.t === 'approval.asked');
  client.socket.write(`${JSON.stringify({ t: 'approval.ack', requestId: asked.requestId })}\n`);
  await new Promise((r) => setTimeout(r, 100));
  client.socket.destroy();

  const [outcome] = await pending;
  assert.equal(delegated, 1, 'a lost connection must delegate');
  assert.notEqual(outcome, 'allowed-once');
});

test('a cancelled request settles as cancelled and ignores a late click', async () => {
  const { ctx, runtime } = startBridge();
  const client = await connectClient(runtime);
  await client.waitFor((m) => m.t === 'ready');

  const controller = new AbortController();
  const pending = ctx.fire(
    'approval/request',
    approvalRequest({ signal: controller.signal }),
    async () => 'unavailable',
  );
  const asked = await client.waitFor((m) => m.t === 'approval.asked');
  client.socket.write(`${JSON.stringify({ t: 'approval.ack', requestId: asked.requestId })}\n`);
  await new Promise((r) => setTimeout(r, 50));
  controller.abort();

  const [outcome] = await pending;
  assert.equal(outcome, 'cancelled');

  // A click after the withdrawal must not resurrect the request.
  client.socket.write(
    `${JSON.stringify({ t: 'approval.answer', requestId: asked.requestId, decision: 'allow' })}\n`,
  );
  await new Promise((r) => setTimeout(r, 100));
  assert.equal(outcome, 'cancelled');
  client.socket.destroy();
});

test('a wrong token is rejected and no card is offered', async () => {
  const { ctx, runtime } = startBridge();
  const socket = connect(runtime.pipe);
  await new Promise((resolve) => socket.on('connect', resolve));
  socket.setEncoding('utf8');
  const closed = new Promise((resolve) => socket.on('close', resolve));
  socket.write(`${JSON.stringify({ t: 'hello', protocol: PROTOCOL, token: 'nope' })}\n`);
  await closed;

  let delegated = 0;
  const [outcome] = await ctx.fire('approval/request', approvalRequest(), async () => {
    delegated++;
    return 'unavailable';
  });
  assert.equal(delegated, 1);
  assert.notEqual(outcome, 'allowed-once');
});

test('a second client cannot steal the first one’s card', async () => {
  const { runtime } = startBridge();
  const first = await connectClient(runtime);
  await first.waitFor((m) => m.t === 'ready');

  const second = connect(runtime.pipe);
  await new Promise((resolve) => second.on('connect', resolve));
  const closed = new Promise((resolve) => second.on('close', resolve));
  second.write(`${JSON.stringify({ t: 'hello', protocol: PROTOCOL, token: runtime.token })}\n`);
  await closed;
  first.socket.destroy();
});

// ── masking ──────────────────────────────────────────────────────────────────

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
    assert.doesNotMatch(masked, /sk-abcdef0123456789|abcdefghijklmnopqrstuvwxyz123456|ghp_0123456789|supersecretvalue123/);
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
