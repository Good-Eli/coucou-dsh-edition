/**
 * The pipe host: a separate process that owns the named pipe.
 *
 * It runs `CreateNamedPipeW` through koffi, so it is the only place a native
 * call can go wrong. A crash here takes down this process and nothing else —
 * DSH keeps running, the plugin sees the channel die and stops intercepting
 * approvals. Running the same code inside the host corrupted the DSH heap with
 * STATUS_HEAP_CORRUPTION, which is exactly what this isolation prevents.
 *
 * argv: <pipeName> <sid> <koffi path>
 * Wire with the parent: raw text on stdout (frames to feed Coucou) and on
 * stdin (frames to write), control messages over the Node IPC channel.
 */

import { Worker } from 'node:worker_threads';
import { createRequire } from 'node:module';

const WAIT_MS = 8;
const ERROR_PIPE_CONNECTED = 535;
const ERROR_BROKEN_PIPE = 109;
const ERROR_NO_DATA = 232;
const ERROR_PIPE_NOT_CONNECTED = 233;

/**
 * Pipe I/O, kept off the main thread so this process still reads its stdin.
 *
 * Reading polls with `PeekNamedPipe` instead of blocking in `ReadFile`: a
 * blocked read on the same handle makes `WriteFile` from the other thread wait
 * forever, which deadlocked the first version of this file.
 */
const IO_WORKER = `
const { workerData, parentPort } = require('node:worker_threads');
const koffi = require(workerData.koffiPath);
const kernel32 = koffi.load('kernel32.dll');
const ConnectNamedPipe = kernel32.func('bool __stdcall ConnectNamedPipe(void *h, void *overlapped)');
const DisconnectNamedPipe = kernel32.func('bool __stdcall DisconnectNamedPipe(void *h)');
const PeekNamedPipe = kernel32.func('bool __stdcall PeekNamedPipe(void *h, void *buf, uint32 bufSize, void *bytesRead, _Out_ uint32 *totalAvail, void *bytesLeft)');
const ReadFile = kernel32.func('bool __stdcall ReadFile(void *h, void *buf, uint32 n, _Out_ uint32 *read, void *overlapped)');
const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');
const CloseHandle = kernel32.func('bool __stdcall CloseHandle(void *h)');

const handle = workerData.handle;
const buf = Buffer.alloc(64 * 1024);
const WAIT = ${WAIT_MS};
let running = true;
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

parentPort.on('message', (message) => {
  if (message && message.t === 'stop') {
    running = false;
    DisconnectNamedPipe(handle);
  }
});

while (running) {
  const ok = ConnectNamedPipe(handle, null);
  const err = ok ? 0 : GetLastError();
  if (!ok && err !== ${ERROR_PIPE_CONNECTED}) {
    if (running) parentPort.postMessage({ t: 'error', error: err });
    break;
  }
  parentPort.postMessage({ t: 'connected' });

  while (running) {
    const available = [0];
    if (!PeekNamedPipe(handle, null, 0, null, available, null)) {
      const code = GetLastError();
      if (code === ${ERROR_BROKEN_PIPE} || code === ${ERROR_NO_DATA} || code === ${ERROR_PIPE_NOT_CONNECTED}) {
        DisconnectNamedPipe(handle);
        if (running) parentPort.postMessage({ t: 'disconnected' });
        break;
      }
      parentPort.postMessage({ t: 'error', error: code });
      running = false;
      break;
    }
    if (available[0] === 0) {
      sleep(WAIT);
      continue;
    }
    const want = Math.min(available[0], buf.length);
    const read = [0];
    if (!ReadFile(handle, buf, want, read, null)) {
      const code = GetLastError();
      if (code === ${ERROR_BROKEN_PIPE} || code === ${ERROR_NO_DATA}) {
        DisconnectNamedPipe(handle);
        if (running) parentPort.postMessage({ t: 'disconnected' });
        break;
      }
      parentPort.postMessage({ t: 'error', error: code });
      running = false;
      break;
    }
    if (read[0] > 0) {
      parentPort.postMessage({ t: 'data', text: buf.subarray(0, read[0]).toString('utf8') });
    }
  }
}
CloseHandle(handle);
`;

const [pipeName, sid, koffiPath] = process.argv.slice(2);
if (!pipeName || !sid || !koffiPath) {
  process.send?.({ t: 'fatal', message: 'usage: pipe-host.mjs <pipeName> <sid> <koffiPath>' });
  process.exit(2);
}

const require = createRequire(import.meta.url);
const koffi = require(koffiPath);
const advapi32 = koffi.load('advapi32.dll');
const kernel32 = koffi.load('kernel32.dll');

const ConvertSD = advapi32.func(
  'bool __stdcall ConvertStringSecurityDescriptorToSecurityDescriptorW(str16, uint32, _Out_ void **, _Out_ uint32 *)',
);
const CreateNamedPipeW = kernel32.func(
  'void *__stdcall CreateNamedPipeW(str16 name, uint32 openMode, uint32 pipeMode, uint32 maxInstances, uint32 outSize, uint32 inSize, uint32 timeout, void *sa)',
);
const DisconnectNamedPipe = kernel32.func('bool __stdcall DisconnectNamedPipe(void *h)');
const WriteFile = kernel32.func(
  'bool __stdcall WriteFile(void *h, void *buf, uint32 n, _Out_ uint32 *written, void *overlapped)',
);
const GetLastError = kernel32.func('uint32 __stdcall GetLastError()');
const LocalFree = kernel32.func('void *__stdcall LocalFree(void *h)');

const sddl = `D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GA;;;${sid})`;
const sd = [null];
const size = [0];
if (!ConvertSD(sddl, 1, sd, size)) {
  process.send?.({ t: 'fatal', message: 'cannot build the pipe security descriptor' });
  process.exit(3);
}

// SECURITY_ATTRIBUTES { DWORD nLength; LPVOID lpSecurityDescriptor; BOOL bInheritHandle; }
const sa = Buffer.alloc(24);
sa.writeUInt32LE(24, 0);
sa.writeBigUInt64LE(BigInt(koffi.address(sd[0])), 8);
sa.writeUInt32LE(0, 16);

const PIPE_ACCESS_DUPLEX = 0x0000_0003;
const FILE_FLAG_FIRST_PIPE_INSTANCE = 0x0008_0000;
const PIPE_REJECT_REMOTE_CLIENTS = 0x0000_0008;

const pipeHandle = CreateNamedPipeW(
  pipeName,
  PIPE_ACCESS_DUPLEX | FILE_FLAG_FIRST_PIPE_INSTANCE,
  PIPE_REJECT_REMOTE_CLIENTS,
  1,
  64 * 1024,
  64 * 1024,
  0,
  sa,
);
LocalFree(sd[0]);

const handle = pipeHandle ? Number(koffi.address(pipeHandle)) : 0;
if (!handle) {
  process.send?.({ t: 'fatal', message: `CreateNamedPipeW failed (${GetLastError()})` });
  process.exit(4);
}
process.send?.({ t: 'ready', sddl });

const worker = new Worker(IO_WORKER, { eval: true, workerData: { handle, koffiPath } });

worker.on('message', (message) => {
  if (message.t === 'data') process.stdout.write(message.text);
  else process.send?.(message);
  if (message.t === 'error') process.exit(5);
});
worker.on('error', (error) => {
  process.send?.({ t: 'fatal', message: `io worker failed: ${error?.message ?? error}` });
  process.exit(6);
});

// A blocked ReadFile only ends when the instance is disconnected, so the kick
// must come from this thread, which owns a second binding to the same handle.
const kick = () => {
  DisconnectNamedPipe(handle);
  worker.postMessage({ t: 'stop' });
};

process.stdin.setEncoding('utf8');
process.stdin.on('data', (text) => {
  const data = Buffer.from(text, 'utf8');
  const written = [0];
  const ok = WriteFile(handle, data, data.length, written, null);
  if (!ok || written[0] !== data.length) {
    process.send?.({ t: 'write-error', error: ok ? -1 : GetLastError() });
  }
});
process.stdin.resume();
process.stdin.on('end', () => process.exit(0));

process.on('message', (message) => {
  if (message?.t === 'kick') kick();
  if (message?.t === 'stop') {
    kick();
    setTimeout(() => process.exit(0), 200);
  }
});

process.on('disconnect', () => process.exit(0));