# dsh-plugin — Coucou ↔ DeepSeek Harness bridge

A Cordis plugin that runs **inside the DSH host process** and gives the Coucou island
what it cannot get from outside: live session state, tool activity, the approval seam,
and per-session model/reasoning switching.

This is the prototype. It is not installed into the real `desktop` profile yet.

## Why a plugin and not ACP

`dsh-acp` is a real ACP server, but it only serves sessions *it* created. It cannot see
the sessions of the desktop app the user is actually working in. The approval seam
(`approval/request`) and `agent.model.select()` are in-process services, so the only way
to reach them for desktop sessions is a plugin inside that host.

## What it does

| Area | Behaviour |
|---|---|
| Session state | `agent/created`, `session/event` → idle / thinking / working / finished / error |
| Activity | `tool/call` → one ticker line per step, with masked arguments |
| Approvals | registers an `approval/request` answerer; shows a card in the island |
| Model catalog | `ctx.llm.listProviders()` / `listModels()` |
| Model switching | `agent.model.select()` for one session, never global defaults |

## The rule that cannot break

`allowed-once` is returned **only** after a Coucou client sent `approval.answer` with
`allow` for that exact `requestId`. Every other path calls `next()`, so DSH shows its own
approval prompt:

- no Coucou connected → `next()` immediately;
- card not acknowledged within 1500 ms → `next()`;
- no decision within 110 s → `next()`;
- client disconnected → `next()`;
- request aborted (turn cancelled) → `cancelled`;
- user chose "open DSH" → `next()`.

`test/prototype.test.mjs` asserts each of these.

## Transport

- Windows named pipe `\\.\pipe\coucou-dsh-<user SID>`.
- First frame must be `hello` with the 32-byte token from `<stateDir>/runtime.json`;
  a wrong token closes the connection before any request is offered.
- One client at a time; a second connection is dropped, so a stranger cannot take a
  card that is already on screen.
- Newline-delimited JSON, 1 MiB maximum per line.

## Privacy

Only structural facts leave the host: tool name, a masked one-line command or path,
a clipped reason, the session id and its directory. Prompts, file contents, model
output and credentials never do. `maskSecrets()` redacts `sk-…`, `ghp_…`, `Bearer …`,
JWTs, `*TOKEN=…` assignments and `--token/--password/--api-key` flags.

## Running the tests

```sh
cd dsh-plugin
npm test
```

The live smoke test needs a running isolated profile:

```sh
DSH_HOME=<isolated-home> node <dsh-cli> --profile prototype
node test/live.mjs <isolated-home>/state
```

## Known gaps (prototype)

- The catalog is empty in an isolated `DSH_HOME` because no account is signed in there;
  it fills in the real `desktop` profile.
- End-to-end approval with a real agent needs a model call, so it is exercised in the
  real profile once the plugin is installed there (separate, approved step).
- The pipe has no explicit DACL yet; the token plus the user-private state directory are
  the current protection. A SID-restricted DACL is on the list before the plugin is
  enabled for day-to-day use.
