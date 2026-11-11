/**
 * Dump what the bridge reports about live sessions, exactly as Coucou receives it.
 *
 * Usage: node dsh-plugin/test/sessions.mjs <stateDir>
 */

import { connect } from 'node:net';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const stateDir = process.argv[2];
if (!stateDir) {
  console.error('usage: node sessions.mjs <stateDir>');
  process.exit(2);
}

const runtime = JSON.parse(readFileSync(join(stateDir, 'runtime.json'), 'utf8'));
const socket = connect(runtime.pipe);
let buffer = '';
let ready;

socket.setEncoding('utf8');
socket.on('data', (chunk) => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    const message = JSON.parse(line);
    if (message.t === 'ready') ready = message;
    else if (message.t !== 'pong') console.log('event:', JSON.stringify(message).slice(0, 300));
  }
});
socket.on('error', (error) => {
  console.error('socket error:', error.message);
  process.exit(1);
});

socket.on('connect', () => {
  socket.write(`${JSON.stringify({ t: 'hello', protocol: 1, token: runtime.token, client: 'sessions' })}\n`);
});

setTimeout(() => {
  console.log('\n=== SESSIONS ===');
  for (const session of ready?.sessions ?? []) {
    console.log(JSON.stringify(session, null, 2));
  }
  if ((ready?.sessions ?? []).length === 0) console.log('(none)');
  socket.destroy();
  process.exit(0);
}, 2000);
