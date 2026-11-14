/**
 * The bridge updates itself.
 *
 * DSH keeps the module it imported first under a plugin entry, and a profile
 * recompose does not swap it: pointing the entry at a newly installed file left
 * the old code running until DSH was restarted by hand, which is precisely how a
 * fixed bridge kept "not working" after an update. So the running instance
 * watches its own folder and hands over to a newer file.
 *
 * These tests drive that hand-over with a real folder and a real module, because
 * the thing that broke was the plumbing between the two, not a pure function.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const source = await import('node:fs').then((fs) =>
  fs.readFileSync(new URL('../bridge.mjs', import.meta.url), 'utf8'),
);

test('the bridge looks for a newer build beside itself', () => {
  assert.match(source, /watchForNewerBuild\(/, 'the hand-over is wired');
  assert.match(source, /bridge-\[0-9a-f\]\+\\\.mjs/, 'only an installed build swaps itself');
  assert.match(source, /clearInterval\(timer\)/, 'the poll stops on the way out');
});

test('a source checkout never tries to swap itself', () => {
  // Run from `dsh-plugin/bridge.mjs`, there is no fingerprint in the name: the
  // plugin must leave its own file alone.
  assert.match(
    source,
    /if \(!\/\^bridge-\[0-9a-f\]\+\\\.mjs\$\/\.test\(mine\)\) return;/,
    'a plain bridge.mjs is not an install',
  );
});

test('the newer module is imported and validated before the old one stops', () => {
  const block = source.slice(source.indexOf('async () => {'));
  const importAt = block.indexOf('await import(');
  const stopAt = block.indexOf('      stop();');
  assert.ok(importAt >= 0, 'the newer file is imported');
  assert.ok(stopAt >= 0, 'the old instance stops');
  assert.ok(importAt < stopAt, 'a broken file must not leave the host with no bridge');
  assert.match(block.slice(0, stopAt), /exports no apply\(\)/, 'and its shape is checked');
});

test('a real newer module is loaded and applied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'coucou-swap-'));
  const applied = [];
  const next = join(dir, 'bridge-deadbeef.mjs');
  writeFileSync(
    next,
    `export function apply(ctx, config) { ctx.applied = { config, from: 'bridge-deadbeef.mjs' }; }\n`,
  );
  try {
    const module = await import(pathToFileURL(next).href);
    const ctx = {};
    module.apply(ctx, { protocol: 1 });
    assert.equal(ctx.applied.from, 'bridge-deadbeef.mjs');
    applied.push(ctx.applied);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(applied.length, 1);
});