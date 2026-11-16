/**
 * Probe: dump the sessions the live bridge knows about.
 *
 * Connects as Coucou does, says hello, and writes every frame to a file. Used to
 * see what a real host publishes — in particular whether a subagent's session
 * can be told apart from a dialog's, which decides what the island may show.
 *
 * Usage: node dsh-plugin/test/probe-sessions.mjs [seconds] [out]
 */

import { connect } from 'node:net';
import { readFileSync, writeFileSync } from 'node:fs';

const stateDir = `${process.env.LOCALAPPDATA}\\Coucou\\dsh\\state`;
const runtime = JSON.parse(readFileSync(`${stateDir}\\runtime.json`, 'utf8'));
const seconds = Number(process.argv[2] ?? 8);
const out = process.argv[3] ?? `${process.env.TEMP}\\coucou-probe.jsonl`;

const socket = connect(runtime.pipe);
let buffer = '';
const frames = [];

socket.on('connect', () => {
  socket.write(`${JSON.stringify({ t: 'hello', protocol: runtime.protocol, token: runtime.token, client: 'probe' })}\n`);
});

socket.on('data', (chunk) => {
  buffer += chunk.toString('utf8');
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, index);
    buffer = buffer.slice(index + 1);
    if (!line.trim()) continue;
    try {
      frames.push(JSON.parse(line));
    } catch {
      frames.push({ unparsed: line });
    }
  }
});

socket.on('error', (error) => {
  console.log(`probe: ${error.message}`);
  process.exit(1);
});

setTimeout(() => {
  writeFileSync(out, frames.map((f) => JSON.stringify(f)).join('\n'), 'utf8');
  console.log(`${frames.length} frames -> ${out}`);
  socket.end();
  process.exit(0);
}, seconds * 1000);
