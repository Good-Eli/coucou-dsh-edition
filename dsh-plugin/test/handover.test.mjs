/**
 * The pipe host's life cycle, and what a handover must not do.
 *
 * A bridge reload replaces the code that owns the named pipe. The old host and
 * the new one are separate processes with the same pipe name, and Windows does
 * not treat that as a conflict: it treats it as two servers. The older one then
 * dies holding the instance a client had just connected to, and the pipe stays
 * open but answers nothing — the plugin reports itself healthy while the island
 * shows "DSH is not connected". The old host must therefore be gone before the
 * new one starts.
 *
 * Run: node --test dsh-plugin/test/
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { SecurePipe } from '../secure-pipe.mjs';

const source = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8');

test('stopping a host that never started is instant and awaits nothing', async () => {
  const pipe = new SecurePipe({ pipeName: '\\\\.\\pipe\\coucou-test-never', sid: 'S-1-5-21-1', koffiPath: '' });
  const started = Date.now();
  const done = pipe.stop();
  assert.ok(done instanceof Promise, 'the caller can wait for the host to be gone');
  await done;
  assert.ok(Date.now() - started < 200, 'and there is nothing to wait for');
});

test('a handover waits for the old host before starting the new one', () => {
  // The ordering is the whole fix: `await stop()` must come before the new
  // module's apply(). Reversing it starts two hosts on one pipe name.
  const at = source.indexOf('handing over');
  assert.ok(at > 0, 'the handover is still there');
  const body = source.slice(at, source.indexOf('reload: now running', at));
  const stopped = body.indexOf('await stop()');
  const started = body.indexOf('next.apply(');
  assert.ok(stopped > 0, 'the old host is stopped');
  assert.ok(started > 0, 'and the new bridge is started');
  assert.ok(stopped < started, 'in that order: two hosts on one pipe name is the bug');
});

test('the bridge hands its host stop a promise to wait on', () => {
  // `stop` in the bridge is what the reload calls; it has to return the pipe's
  // promise rather than dropping it, or `await stop()` would resolve at once.
  const at = source.indexOf('stop: () => {');
  assert.ok(at > 0, 'the stop closure is still there');
  const body = source.slice(at, source.indexOf('},\n  });', at));
  assert.match(body, /return channel\.stop\(\)/, 'the pipe stop is returned, not just called');
});

test('a host that will not die cannot hang the handover', () => {
  // The wait has a ceiling: a wedged host is replaced anyway rather than
  // freezing the reload for the rest of the day.
  const pipeSource = readFileSync(new URL('../secure-pipe.mjs', import.meta.url), 'utf8');
  const at = pipeSource.indexOf('stop() {');
  const body = pipeSource.slice(at, pipeSource.indexOf('\n  }', at));
  assert.match(body, /setTimeout\(resolve, 3000\)/, 'the wait gives up after three seconds');
  assert.match(body, /child\.kill\(\)/, 'and the host is killed rather than asked politely');
});
