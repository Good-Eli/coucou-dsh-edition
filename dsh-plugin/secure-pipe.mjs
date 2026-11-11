/**
 * Supervisor for the pipe host process.
 *
 * Node's `net` server cannot give a named pipe our own security descriptor:
 * `uv_pipe_bind` passes a null SECURITY_ATTRIBUTES, `server._handle.fd` is -1,
 * and the resulting pipe carried `(A;;FR;;;WD)(A;;FR;;;AN)` — Everyone and
 * Anonymous could open it.
 *
 * Creating the pipe ourselves needs a native call, and a native call in the DSH
 * host crashed it with STATUS_HEAP_CORRUPTION. So the pipe lives in a child
 * process (`pipe-host.mjs`): if that process dies, DSH does not notice beyond
 * a dead channel, and the plugin falls back to DSH's own approval prompt.
 */

import { spawn } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HOST_SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'pipe-host.mjs');

/** Security descriptor a private pipe should have; exported for tests. */
export function pipeSddl(sid) {
  return `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;${sid})`;
}

/**
 * Owns the child process that serves the pipe.
 *
 * The parent never touches koffi: it only relays text. `onData` receives what
 * Coucou sent, `onConnect`/`onDisconnect` mark the client's presence.
 */
export class SecurePipe {
  #child = null;
  #ready = false;
  #stopping = false;

  constructor({ pipeName, sid, koffiPath, log = () => {}, onFatal = () => {} }) {
    this.pipeName = pipeName;
    this.sid = sid;
    this.koffiPath = koffiPath;
    this.log = log;
    this.onFatal = onFatal;
    this.sddl = pipeSddl(sid);
    this.actualSddl = null;
    this.onConnect = null;
    this.onData = null;
    this.onDisconnect = null;
  }

  /** Spawns the host. Throws only when the process cannot be started. */
  start() {
    const child = spawn(
      process.execPath,
      [HOST_SCRIPT, this.pipeName, this.sid, this.koffiPath],
      {
        // The host runs as plain Node: no window, no Electron app startup.
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
        windowsHide: true,
      },
    );
    this.#child = child;

    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (text) => this.onData?.(text));

    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (text) => {
      const message = String(text).trim();
      if (message) this.log('warn', `pipe-host: ${message.slice(0, 300)}`);
    });

    child.on('message', (message) => {
      switch (message?.t) {
        case 'ready':
          this.#ready = true;
          this.actualSddl = message.sddl ?? null;
          this.log('info', `pipe: host ready (DACL ${this.actualSddl ?? 'unknown'})`);
          break;
        case 'connected':
          this.log('info', 'pipe: client attached');
          this.onConnect?.();
          break;
        case 'disconnected':
          this.log('info', 'pipe: client detached');
          this.onDisconnect?.();
          break;
        case 'write-error':
          this.log('warn', `pipe: host write failed (${message.error})`);
          break;
        case 'debug':
          this.log('debug', `pipe-host: ${message.message}`);
          break;
        case 'fatal':
          this.log('error', `pipe-host fatal: ${message.message}`);
          this.onFatal(new Error(message.message));
          break;
        default:
          break;
      }
    });

    child.on('exit', (code, signal) => {
      this.#ready = false;
      const how = signal ? `signal ${signal}` : `code ${code}`;
      if (this.#stopping) {
        this.log('info', `pipe: host stopped (${how})`);
        return;
      }
      // 3221226356 is STATUS_HEAP_CORRUPTION: the native failure this process
      // exists to contain. DSH itself is untouched.
      this.log('error', `pipe: host exited (${how})`);
      this.onFatal(new Error(`pipe host exited (${how})`));
    });

    child.on('error', (error) => {
      this.log('error', `pipe: cannot start the pipe host: ${error?.message ?? error}`);
      this.onFatal(error);
    });

    return this;
  }

  get ready() {
    return this.#ready;
  }

  /** Writes a frame to the client. False when the host is gone. */
  write(text) {
    const child = this.#child;
    if (!child || child.killed || !child.stdin.writable) return false;
    child.stdin.write(text);
    return true;
  }

  /** Drops the current client; the host disconnects and waits for the next. */
  kick() {
    this.#child?.send?.({ t: 'kick' });
  }

  /** Stops the host for good. */
  stop() {
    const child = this.#child;
    this.#child = null;
    this.#ready = false;
    this.#stopping = true;
    if (!child) return;
    try {
      child.send?.({ t: 'stop' });
    } catch {
      /* already gone */
    }
    setTimeout(() => {
      try {
        if (!child.killed) child.kill();
      } catch {
        /* already gone */
      }
    }, 500).unref?.();
  }
}