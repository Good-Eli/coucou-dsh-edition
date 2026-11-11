/**
 * Live smoke test against a running isolated DSH profile.
 *
 * Connects to the bridge pipe exactly as Coucou will, checks the handshake,
 * the catalog and the session list. It never answers an approval: this script
 * only proves the channel works end to end.
 *
 * Usage: node dsh-plugin/test/live.mjs <stateDir>
 */

import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const stateDir = process.argv[2];
if (!stateDir) {
  console.error('usage: node live.mjs <stateDir>');
  process.exit(2);
}

const runtime = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
console.log('pipe:', runtime.pipe);
console.log('token length:', runtime.token.length);

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
    if (line.trim()) {
      const message = JSON.parse(line);
      messages.push(message);
      console.log('<-', JSON.stringify(message).slice(0, 400));
    }
  }
});
socket.on('error', (error) => {
  console.error('socket error:', error.message);
  process.exit(1);
});

const send = (message) => socket.write(`${JSON.stringify(message)}\n`);

socket.on('connect', async () => {
  send({ t: 'hello', protocol: 1, token: runtime.token, client: 'live-smoke' });

  setTimeout(() => send({ t: 'catalog.get', requestId: 'cat-1' }), 500);
  setTimeout(() => send({ t: 'ping' }), 800);

  setTimeout(() => {
    const ready = messages.find((m) => m.t === 'ready');
    const catalog = messages.find((m) => m.t === 'result' && m.requestId === 'cat-1');
    const pong = messages.find((m) => m.t === 'pong');
    console.log('\n=== RESULT ===');
    console.log('ready:', ready ? 'ok' : 'MISSING');
    console.log('protocol:', ready?.protocol);
    console.log('sessions:', ready?.sessions?.length ?? 0);
    console.log('providers:', catalog?.value?.providers?.map((p) => `${p.id}(${p.models.length})`).join(', ') ?? 'none');
    for (const provider of catalog?.value?.providers ?? []) {
      for (const model of provider.models) {
        console.log(`  ${provider.id}/${model.id} name=${model.name} efforts=${(model.efforts ?? []).map((e) => e.id).join('|') || '-'}`);
      }
    }
    console.log('pong:', pong ? 'ok' : 'MISSING');
    socket.destroy();
    process.exit(ready && catalog && pong ? 0 : 1);
  }, 2500);
});
