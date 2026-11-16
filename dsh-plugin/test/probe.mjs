/**
 * Probe: what the running bridge actually sends.
 *
 * Connects to the live pipe as Coucou does, says hello, and prints the frames
 * for a few seconds — the only way to see what a real DSH host publishes
 * without guessing from the island's pixels.
 *
 * Usage: node dsh-plugin/test/probe.mjs [seconds]
 */

import { connect } from 'node:net';
import { readFileSync } from 'node:fs';

const stateDir = process.argv[3] ?? `${process.env.LOCALAPPDATA}\\Coucou\\dsh\\state`;
const runtime = JSON.parse(readFileSync(`${stateDir}\\runtime.json`, 'utf8'));
const seconds = Number(process.argv[2] ?? 6);

const socket = connect(runtime.pipe);
let buffer = '';

socket.on('connect', () => {
  socket.write(`${JSON.stringify({ t: 'hello', protocol: runtime.protocol, token: runtime.token, client: 'probe' })}\n`);
});

socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (line.trim()) console.log(line.slice(0, 600));
  }
});

socket.on('error', (error) => {
  console.log(`probe: ${error.message}`);
  process.exit(1);
});

setTimeout(() => {
  socket.end();
  process.exit(0);
}, seconds * 1000);
