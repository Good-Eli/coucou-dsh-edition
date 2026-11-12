// A stand-in DSH host bridge, for testing the island without a real approval
// prompt or a real agent.
//
// It speaks the same protocol as dsh-plugin/bridge.mjs over a real named pipe,
// so Coucou connects to it exactly as it connects to the real thing. It keeps
// its own selection state and answers `session.setConfig` the way the plugin
// does: apply, then read back what is now selected.
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

// Two providers, three models, and effort lists that differ on purpose: a
// model with three, a model with one, and a model with none at all.
const CATALOG = {
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
        {
          id: "v4-pro",
          name: "DeepSeek-V4.1-Pro",
          efforts: [{ id: "high", name: "High" }],
          defaultEffort: "high",
          contextWindow: 256000,
        },
        {
          id: "lite",
          name: "DeepSeek Lite",
          efforts: [],
          defaultEffort: null,
        },
      ],
    },
    {
      id: "plusvibe",
      name: "PlusVibe",
      models: [
        {
          id: "spark",
          name: "Spark",
          efforts: [
            { id: "low", name: "Low" },
            { id: "medium", name: "Medium" },
          ],
          defaultEffort: "medium",
        },
      ],
    },
  ],
  fetchedAt: Date.now(),
};

/** The live sessions, each with its own selection. */
const sessions = new Map([
  [
    "s-fake",
    {
      id: "s-fake",
      cwd: "C:\\work\\proj",
      title: "Тестовая сессия",
      agentPreset: "standard",
      createdAt: Date.now(),
      model: { provider: "deepseek", model: "v4-flash", reasoningEffort: "high" },
      state: "idle",
      since: Date.now(),
    },
  ],
  [
    "s-second",
    {
      id: "s-second",
      cwd: "C:\\work\\other",
      title: "Вторая сессия",
      agentPreset: "standard",
      createdAt: Date.now(),
      model: { provider: "plusvibe", model: "spark", reasoningEffort: "medium" },
      state: "idle",
      since: Date.now(),
    },
  ],
]);

const modelOf = (provider, model) =>
  CATALOG.providers.find((p) => p.id === provider)?.models.find((m) => m.id === model);

const ready = () => ({
  t: "ready",
  protocol: 1,
  hostPid: process.pid,
  pipe: { hardened: true, sddl: "D:P(A;;FA;;;SY)" },
  security: { tokenPrivate: true, directoryPrivate: true },
  compatibility: { ok: true, version: "0.2.2-rc.1", problems: [] },
  approvals: { enabled: true },
  catalog: CATALOG,
  sessions: [...sessions.values()],
});

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

/** Set from the outside to test a disconnect mid-operation. */
const dropOn = process.env.FAKE_DROP_ON || "";

const server = createServer((socket) => {
  log("client attached");
  let buffer = "";

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

    // Pulling the plug in the middle of a change: the island must not claim
    // anything was applied.
    if (dropOn && frame.t === dropOn) {
      log(`dropping the connection on ${frame.t}`);
      socket.destroy();
      return;
    }

    switch (frame.t) {
      case "hello":
        if (frame.token !== TOKEN) {
          log("refused: bad token");
          socket.destroy();
          return;
        }
        send(ready());
        if (process.env.FAKE_ASK === "1") {
          setTimeout(() => {
            send(ASKED);
            log("sent approval.asked");
          }, 1500);
        }
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
        send({ t: "result", requestId: frame.requestId, ok: true, value: CATALOG });
        return;
      case "session.setConfig": {
        const session = sessions.get(frame.sessionId);
        if (!session) {
          send({
            t: "result",
            requestId: frame.requestId,
            ok: false,
            error: { code: "unknown_session", message: "no live agent for this session" },
          });
          return;
        }
        try {
          if (frame.configId === "model") {
            const [provider, ...rest] = String(frame.value).split("/");
            const model = rest.join("/");
            if (!modelOf(provider, model)) throw new Error(`unknown model: ${provider}/${model}`);
            // As the real plugin does: a new model carries no effort, so the
            // provider default applies until one is chosen for it.
            session.model = { provider, model };
          } else if (frame.configId === "reasoning_effort") {
            const model = modelOf(session.model.provider, session.model.model);
            if (!model) throw new Error("this session has no model selection");
            const effort = frame.value === "" ? undefined : frame.value;
            if (effort !== undefined && !model.efforts.some((e) => e.id === effort)) {
              throw new Error(`unknown reasoning effort for ${session.model.provider}/${session.model.model}: ${effort}`);
            }
            session.model = { ...session.model, reasoningEffort: effort };
          } else {
            throw new Error(`unknown session config option: ${frame.configId}`);
          }
          log(`applied ${frame.configId}=${frame.value} → ${JSON.stringify(session.model)}`);
          send({ t: "result", requestId: frame.requestId, ok: true, value: session.model });
          send({ t: "session.model", sessionId: session.id, ...session.model, pending: false });
        } catch (error) {
          log(`refused ${frame.configId}=${frame.value}: ${error.message}`);
          send({
            t: "result",
            requestId: frame.requestId,
            ok: false,
            error: { code: "invalid_value", message: error.message },
          });
        }
        return;
      }
      default:
        log(`ignored: ${frame.t}`);
    }
  }
});

server.listen(pipeName, () => log("server up"));
process.on("SIGTERM", () => server.close(() => process.exit(0)));
