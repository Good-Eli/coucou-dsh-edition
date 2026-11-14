/**
 * The transport must survive what really happens on this machine.
 *
 * Two defects lived here and neither had a test:
 *
 *   - a kick (a client with a stale token, which is normal right after a bridge
 *     update) also stopped the IO worker, so the pipe host exited and the
 *     bridge stayed dead until DSH restarted the plugin;
 *   - a host that died for any reason was never brought back, so the plugin
 *     stayed loaded with no pipe — every approval silently went to DSH's own
 *     window.
 *
 * These tests read the two files rather than spawning koffi: the failure mode is
 * a structural one (`kick` tearing down the worker, no restart path), and a
 * source-level check is what keeps it from coming back.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const host = readFileSync(new URL('../pipe-host.mjs', import.meta.url), 'utf8');
const supervisor = readFileSync(new URL('../secure-pipe.mjs', import.meta.url), 'utf8');
const bridge = readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8');

test('a kick drops the client and leaves the pipe serving', () => {
  const kick = host.slice(host.indexOf('const kick = ()'));
  const body = kick.slice(0, kick.indexOf('};') + 2);
  assert.match(body, /DisconnectNamedPipe/, 'the client is disconnected');
  assert.doesNotMatch(
    body,
    /postMessage\(\{\s*t:\s*'stop'\s*\}\)/,
    'stopping the worker closes the handle under it and kills the host',
  );
});

test('a host that dies is brought back, with a backoff', () => {
  assert.match(supervisor, /#scheduleRestart\(\)/, 'there is a restart path at all');
  assert.match(supervisor, /restarting the host in/, 'the restart is logged');
  assert.match(supervisor, /Math\.min\(1000 \* 2 \*\*/, 'the retry backs off');
  // And it stops for good when the plugin is unloaded.
  assert.match(supervisor, /#stopping = true/, 'stop() disarms the restart');
});

test('a stale token costs one client, not the bridge', () => {
  // The plugin must not treat a rejected handshake as a reason to give up.
  const rejected = bridge.slice(bridge.indexOf('rejected a client'));
  const block = rejected.slice(0, rejected.indexOf('return;'));
  assert.match(block, /lineBuffer = ''/, 'the half-frame of that client goes');
  assert.match(block, /channel\.kick\('auth failed'\)/, 'only that client is dropped');
});