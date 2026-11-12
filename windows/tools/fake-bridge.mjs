// A stand-in DSH host bridge, for testing the island without a real approval.
//
// It speaks the same protocol as dsh-plugin/bridge.mjs over a real named pipe,
// so Coucou connects to it exactly as it connects to the real thing. Used to
// check the card end to end: what the island shows, when it acknowledges, and
// what it sends back when a button is pressed.
//
//   node tools/fake-bridge.mjs <stateDir> <pipeName>
//
// Writes runtime.json into <stateDir> and logs every frame it receives.

import { createServer } from "node:net";
import { writeFileSync, mkdirSync, appendFileSync } from "node:fs";
import { join } from "node:path";

const [, , stateDir, pipeName] = process.argv;
if (!stateDir || !pipeName) {
  console.error("usage: node fake-bridge.mjs <stateDir> <pipeName>");
  process.exit(2);
}

const TOKEN = "fake-token-for-tests";
const logFile = join(stateDir, "fake-bridge.log");
mkdirSync(stateDir, { recursive: true });
const log = (line) => appendFileSync(logFile, `${new Date().toISOString()} ${line}\n`);

const SESSION = {
  id: "s-fake",
  cwd: "C:\\work\\proj",
  title: "Тестовая сессия",
  agentPreset: "standard",
  createdAt: Date.now(),
  model: { provider: "deepseek", model: "v4-flash", reasoningEffort: "high" },
  state: "working",
  since: Date.now(),
};

const READY = {
  t: "ready",
  protocol: 1,
  hostPid: process.pid,
  pipe: { hardened: true, sddl: "D:P(A;;FA;;;SY)" },
  security: { tokenPrivate: true, directoryPrivate: true },
  compatibility: { ok: true, version: "0.2.2-rc.1", problems: [] },
  approvals: { enabled: true },
  catalog: {
    providers: [
      {
        id: "deepseek",
        name: "DeepSeek",
        models: [
          {
            id: "v4-flash",
            name: "DeepSeek-V4.1-Flash",
            efforts: [
              { id: "off", name: "Off" },
              { id: "high", name: "High" },
              { id: "max", name: "Max" },
            ],
            defaultEffort: "high",
            contextWindow: 128000,
          },
        ],
      },
    ],
    fetchedAt: Date.now(),
  },
  sessions: [SESSION],
};

// The question the island should put on screen. The command carries a fake
// credential on purpose: the card must not show it.
const ASKED = {
  t: "approval.asked",
  requestId: "req-1",
  sessionId: "s-fake",
  callId: "call-1",
  tool: "pwsh",
  reason: "The command needs to run outside the sandbox",
  title: "pwsh",
  command: "deploy --token=sk-abcdef1234567890abcdef --env prod",
  files: ["C:\\work\\proj\\scripts\\deploy.ps1", "C:\\work\\proj\\.env.production"],
  expiresAt: Date.now() + 120000,
};

writeFileSync(
  join(stateDir, "runtime.json"),
  JSON.stringify({ protocol: 1, pipe: pipeName, token: TOKEN, pid: process.pid }),
);
log(`listening on ${pipeName}`);

const server = createServer((socket) => {
  log("client attached");
  let buffer = "";
  let asked = false;

  socket.on("data", (chunk) => {
    buffer += chunk.toString("utf8");
    let index;
    while ((index = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      if (!line.trim()) continue;
      let frame;
      try {
        frame = JSON.parse(line);
      } catch {
        log(`unreadable: ${line}`);
        continue;
      }
      handle(frame);
    }
  });

  socket.on("error", (err) => log(`socket error: ${err.message}`));
  socket.on("close", () => log("client detached"));

  const send = (frame) => {
    if (socket.destroyed) return false;
    socket.write(`${JSON.stringify(frame)}\n`);
    return true;
  };

  function handle(frame) {
    log(`recv: ${JSON.stringify(frame)}`);
    switch (frame.t) {
      case "hello":
        if (frame.token !== TOKEN) {
          log("refused: bad token");
          socket.destroy();
          return;
        }
        send(READY);
        // The question follows the handshake, as the real plugin sends it.
        setTimeout(() => {
          asked = true;
          send(ASKED);
          log("sent approval.asked");
        }, 1500);
        return;
      case "ping":
        send({ t: "pong", ts: Date.now() });
        return;
      case "approval.ack":
        log(`ACK received for ${frame.requestId}`);
        return;
      case "approval.answer":
        log(`ANSWER ${frame.decision} for ${frame.requestId}`);
        send({ t: "approval.resolved", requestId: frame.requestId, outcome: frame.decision === "allow" ? "allowed-once" : "rejected" });
        return;
      case "approval.decline":
        log(`DECLINE (open DSH) for ${frame.requestId}`);
        send({ t: "approval.resolved", requestId: frame.requestId, outcome: "unavailable" });
        return;
      case "catalog.get":
        send({ t: "result", requestId: frame.requestId, ok: true, value: READY.catalog });
        return;
      default:
        log(`ignored: ${frame.t}`);
    }
  }
});

server.listen(pipeName, () => log("server up"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
