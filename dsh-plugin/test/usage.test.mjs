/**
 * The spend the closed island shows, as the bridge reads it.
 *
 * The number is the provider's own, so what matters here is that it is read
 * correctly — every page of a busy day, both spellings of the fields, and
 * nothing at all when the key or the provider is not there. A guessed zero on
 * a 24-pixel island is worse than an empty one.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, PROTOCOL } from '../bridge.mjs';

const realFetch = globalThis.fetch;

test.afterEach(() => {
  globalThis.fetch = realFetch;
});

function fakeCtx(withCredentials = true) {
  const listeners = new Map();
  const services = new Map();
  const disposers = [];
  if (withCredentials) {
    services.set('credentials', { resolve: async () => ({ value: 'test-key' }) });
  }
  services.set('agents', { list: () => [] });
  return {
    services,
    disposers,
    events: { _hooks: {} },
    testChannel: null,
    on(event, handler) {
      const list = listeners.get(event) ?? [];
      list.push(handler);
      listeners.set(event, list);
    },
    get: (name) => services.get(name),
    provide: (name, value) => services.set(name, value),
    effect(fn) {
      const dispose = fn();
      if (typeof dispose === 'function') disposers.push(dispose);
      return dispose;
    },
    disposeAll() {
      for (const dispose of disposers.splice(0)) dispose();
    },
    fire: () => Promise.resolve(),
    has: (event) => (listeners.get(event) ?? []).length > 0,
  };
}

/** A day of records, served a page at a time, in the provider's own shape. */
function stubUsage(rowsPerPage, { status = 200, failPage = null, delay = 0 } = {}) {
  const calls = [];
  const pages = rowsPerPage.length;
  const total = rowsPerPage.reduce((n, rows) => n + rows.length, 0);
  const stats = { inFlight: 0, most: 0 };
  globalThis.fetch = async (url) => {
    calls.push(url);
    stats.inFlight += 1;
    stats.most = Math.max(stats.most, stats.inFlight);
    if (delay) await new Promise((resolve) => setTimeout(resolve, delay));
    stats.inFlight -= 1;
    const page = Number(new URL(url).searchParams.get('page') ?? '1');
    if (failPage === page || status !== 200) {
      return { ok: false, status: status === 200 ? 500 : status, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({ data: rowsPerPage[page - 1] ?? [], total, page, pages }),
    };
  };
  return { calls, stats };
}

const row = (prompt, completion, rub, spelling = 'snake') =>
  spelling === 'snake'
    ? { prompt_tokens: prompt, completion_tokens: completion, cost_rub: rub }
    : { promptTokens: prompt, completionTokens: completion, priceRub: rub };

function startBridge(ctx) {
  const stateDir = mkdtempSync(join(tmpdir(), 'coucou-usage-'));
  apply(ctx, { stateDir, testChannel: true, skipSecurityChecks: true, logLevel: 'error' });
  const runtime = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
  return { ctx, runtime, channel: ctx.testChannel };
}

function handshake(bridge) {
  bridge.channel.inject(`${JSON.stringify({ t: 'hello', protocol: PROTOCOL, token: bridge.runtime.token })}\n`);
}

/** The frames the plugin wrote, decoded. */
function frames(bridge) {
  return bridge.channel.outgoing
    .join('')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

/** Lets the stubbed requests settle. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

/** Waits for a frame of a given type, so a slow stub cannot make this flaky. */
async function waitFor(bridge, type, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const found = frames(bridge).find((frame) => frame.t === type);
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

test('a busy day is read page by page, together, and summed', async () => {
  const page1 = Array.from({ length: 100 }, () => row(1000, 10, 0.1));
  const page2 = Array.from({ length: 100 }, () => row(1000, 10, 0.1, 'camel'));
  const page3 = Array.from({ length: 50 }, () => row(1000, 10, 0.1));
  const { calls, stats } = stubUsage([page1, page2, page3], { delay: 20 });

  const ctx = fakeCtx();
  const bridge = startBridge(ctx);
  handshake(bridge);
  const usage = await waitFor(bridge, 'usage');

  assert.equal(calls.length, 3, `asked for ${calls.length} page(s)`);
  // The first page says how many there are; the rest go out together. The
  // provider can take fifteen seconds, and one page after another would make
  // the total arrive a minute late.
  assert.equal(stats.most, 2, 'the remaining pages are asked for at the same time');
  assert.ok(usage, 'the island is told what was spent');
  assert.equal(usage.tokens, 250 * 1010, 'prompt plus completion, every row, both spellings');
  assert.equal(Math.round(usage.rub * 100) / 100, 25, 'the provider price of every row');
  assert.equal(usage.day, localDay(), 'stamped with the day the figures belong to');
  ctx.disposeAll();
});

test('the day starts at local midnight, not at UTC midnight', async () => {
  const { calls } = stubUsage([[row(1, 1, 0.01)]]);
  const ctx = fakeCtx();
  const bridge = startBridge(ctx);
  handshake(bridge);
  await settle();

  const from = new URL(calls[0]).searchParams.get('dateFrom');
  const asked = new Date(from);
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  assert.equal(asked.getTime(), midnight.getTime(), 'today begins where the person reading it does');
  ctx.disposeAll();
});

test('no key means no number, and no request at all', async () => {
  const { calls } = stubUsage([[row(1, 1, 0.01)]]);
  const ctx = fakeCtx(false);
  const bridge = startBridge(ctx);
  handshake(bridge);
  await settle();

  assert.equal(calls.length, 0, 'nothing is asked without a key to ask with');
  assert.equal(frames(bridge).find((frame) => frame.t === 'usage'), undefined, 'and nothing is invented');
  ctx.disposeAll();
});

test('a provider that refuses leaves the island without a number, not with a zero', async () => {
  stubUsage([[row(1, 1, 0.01)]], { status: 401 });
  const ctx = fakeCtx();
  const bridge = startBridge(ctx);
  handshake(bridge);
  await settle();

  assert.equal(frames(bridge).find((frame) => frame.t === 'usage'), undefined);
  // The bridge stays usable: a refused usage call is not a refused handshake.
  assert.ok(frames(bridge).find((frame) => frame.t === 'ready'), 'the client is still connected');
  ctx.disposeAll();
});

test('the spend statistics bucket one month of history into day, week and month', async () => {
  // One pass over the month serves all three rows: the widest window is read
  // once and each record is put in the windows it belongs to.
  const now = new Date();
  const midnight = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const at = (daysAgo) => {
    const d = new Date(midnight);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(12, 0, 0, 0);
    return d.toISOString();
  };
  const rows = [
    { created_at: at(0), prompt_tokens: 100, completion_tokens: 10, cost_rub: 1 }, // today
    { created_at: at(0), prompt_tokens: 100, completion_tokens: 10, cost_rub: 1 }, // today
    { created_at: at(3), prompt_tokens: 200, completion_tokens: 20, cost_rub: 2 }, // this week
    { created_at: at(40), prompt_tokens: 400, completion_tokens: 40, cost_rub: 4 }, // older than a month
  ];
  // The stub answers the month's window only, as the bridge asks for it.
  const inMonth = rows.filter((r) => new Date(r.created_at) >= new Date(now.getFullYear(), now.getMonth(), 1));
  const { calls } = stubUsage([inMonth]);

  const ctx = fakeCtx();
  const bridge = startBridge(ctx);
  handshake(bridge);
  // The bridge reads today's total on connect; wait for that before counting.
  await waitFor(bridge, 'usage');
  const before = calls.length;
  bridge.channel.inject(`${JSON.stringify({ t: 'usage.stats', requestId: 'spend-1' })}\n`);
  const answer = await waitFor(bridge, 'result');

  assert.equal(calls.length - before, 1, 'one request serves all three periods');
  assert.ok(answer?.ok, 'the figures arrived');
  const value = answer.value;
  assert.equal(value.day.requests, 2, 'today has the two records from today');
  assert.equal(value.day.rub, 2);
  assert.equal(value.week.requests, 3, 'the week has today and three days ago');
  assert.equal(value.month.requests, 3, 'the month is everything the provider returned');
  assert.equal(value.month.rub, 4);
  // The windows are named, so the card can say what it is showing.
  assert.equal(value.since.day, localDay());
  assert.equal(value.since.month.length, 10, 'a YYYY-MM-DD month start');
  ctx.disposeAll();
});

test('a handover leaves no timer and no listener behind', async () => {  // Every reload used to leave the old copy's five-minute timer running: the
  // log filled with retries from bridges nobody was talking to, and the island's
  // answerer count grew by one per handover ("38 other answerer(s)").
  const source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8');
  const stop = source.slice(source.indexOf('stop: () => {'));
  const body = stop.slice(0, stop.indexOf('},\n  });'));
  assert.match(body, /clearInterval\(usageTimer\)/, 'the usage timer stops with the bridge');
  assert.match(body, /unhook\?\.\(\)/, 'and its approval listener is released by its own disposer');
  // The host binds the callback before storing it, so the stored entry's
  // `callback` is not `onApproval`: matching on that found nothing and the
  // listeners piled up. The entry itself is kept and removed by identity.
  assert.match(body, /hook\.indexOf\(ours\)/, 'the stored entry is removed by identity');
  assert.doesNotMatch(body, /h\.callback === onApproval/, 'which is what never matched');
  assert.match(source, /let unhook = null;/, 'both handles outlive the approvals branch');

  // And the timer really does stop when the host disposes the plugin.
  const { calls } = stubUsage([[row(1, 1, 0.01)]]);
  const ctx = fakeCtx();
  const bridge = startBridge(ctx);
  handshake(bridge);
  await waitFor(bridge, 'usage');
  ctx.disposeAll();
  const seen = calls.length;
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(calls.length, seen, 'no request goes out once the bridge is gone');
});

function localDay() {
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}
