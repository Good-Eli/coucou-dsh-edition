// The DSH client: connect, authenticate, stay alive, and keep a snapshot of
// what the host reports.
//
// The island never guesses. It shows the sessions, model and effort that DSH
// itself published, and it answers an approval only when a click produced an
// answer for that exact request. Everything else fails towards DSH's own prompt.

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager};

use super::protocol::{
    self, ApprovalAsked, Catalog, Frame, Ready, Selection, Session, SpendStats, Usage,
};
use super::wire::{self, Conn};

/// How often the client proves the host is still there.
const PING_EVERY: Duration = Duration::from_secs(5);
/// Without any frame for this long the connection is treated as dead, even if
/// the pipe has not reported a close.
const SILENCE_LIMIT: Duration = Duration::from_secs(15);
/// How long to wait for `ready` after `hello`.
const HANDSHAKE_LIMIT: Duration = Duration::from_secs(5);
/// How long to wait for a free pipe instance before giving up this round.
const OPEN_LIMIT: Duration = Duration::from_secs(3);
/// Pause before reconnecting after a failure.
const RETRY_EVERY: Duration = Duration::from_secs(3);
/// How many tool steps one session keeps for the island's ticker. The same cap
/// the hook path uses (AgentTask.steps), so a long session does not grow here.
const MAX_SESSION_STEPS: usize = 20;

/// What the island shows about DSH.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// "off" | "connecting" | "ready" | "incompatible" | "error"
    pub status: String,
    pub error: Option<String>,
    pub version: Option<String>,
    /// False when the plugin refused to intercept approvals (token file not
    /// private, or a host it cannot listen to). The island must then show no
    /// card at all.
    pub approvals_enabled: bool,
    /// The host's default approval policy (`ask` / `never`), when it says.
    pub approval_policy: Option<String>,
    /// Whether the pipe the host created is private to this user.
    pub hardened: bool,
    pub sessions: Vec<Session>,
    pub catalog: Catalog,
    /// Today's PlusVibeAPI spend, when the bridge could read it.
    pub usage: Option<Usage>,
    /// Questions waiting for a click.
    pub pending: Vec<ApprovalAsked>,
    pub active_session: Option<String>,
    pub updated_at: i64,
}

impl Snapshot {
    fn session_mut(&mut self, id: &str) -> Option<&mut Session> {
        self.sessions.iter_mut().find(|s| s.id == id)
    }
}

/// What a `result` frame belongs to.
#[derive(Debug, Clone)]
pub(crate) enum RequestKind {
    Catalog,
    SetConfig { session_id: String },
    /// Today / week / month spend for the island's statistics card.
    SpendStats,
}

/// Shared with the Tauri commands.
pub struct Dsh(
    pub Mutex<Snapshot>,
    Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>,
    /// Requests sent to the host and not answered yet. Commands add to it, the
    /// reader task resolves it, so a confirmed value can be told apart from a
    /// value that was merely asked for.
    Mutex<HashMap<String, RequestKind>>,
);

impl Dsh {
    fn new() -> Self {
        Self(
            Mutex::new(Snapshot { status: "connecting".into(), ..Default::default() }),
            Mutex::new(None),
            Mutex::new(HashMap::new()),
        )
    }
}

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// One ticker line for a step: what the bridge described, else the tool's name.
///
/// The bridge already builds a readable line ("pwsh cargo test", "edit
/// src/x.ts"), so its text wins; a frame with neither field is not a step and
/// returns nothing rather than an empty row.
fn step_line(title: Option<&str>, tool: Option<&str>) -> Option<String> {
    let title = title.map(str::trim).filter(|t| !t.is_empty());
    let tool = tool.map(str::trim).filter(|t| !t.is_empty());
    title.or(tool).map(|line| line.chars().take(200).collect())
}

/// The folder a session runs in, for the recap's project name.
fn session_cwd(app: &AppHandle, session_id: &str) -> String {
    app.try_state::<Dsh>()
        .and_then(|dsh| {
            dsh.0
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .sessions
                .iter()
                .find(|s| s.id == session_id)
                .map(|s| s.cwd.clone())
        })
        .unwrap_or_default()
}

/// Starts the client. It reconnects forever: DSH starting after Coucou, or
/// restarting, is normal.
pub fn start(app: AppHandle) {
    app.manage(Dsh::new());
    tauri::async_runtime::spawn(async move {
        loop {
            run_once(&app).await;
            tokio::time::sleep(RETRY_EVERY).await;
        }
    });
}

/// The answer to one command, for the view that asked.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConfigResult {
    pub request_id: String,
    pub ok: bool,
    pub error: Option<String>,
    /// The selection the host reports after the change, not the one we asked for.
    pub selection: Option<Selection>,
}

fn answer_config(app: &AppHandle, result: ConfigResult) {
    let _ = app.emit("dsh-config", result);
}

/// The spend figures the island's statistics card asked for.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SpendAnswer {
    pub ok: bool,
    pub stats: Option<SpendStats>,
    /// Why there are no figures, when there are none. The card says so instead
    /// of showing zeros nobody reported.
    pub error: Option<String>,
}

fn answer_spend(app: &AppHandle, answer: SpendAnswer) {
    let _ = app.emit("dsh-spend", answer);
}

/// Fails every request still waiting, because the connection that would have
/// answered them is gone. Nothing is reported as applied.
fn fail_outstanding(app: &AppHandle, reason: &str) {
    let Some(dsh) = app.try_state::<Dsh>() else { return };
    let outstanding: Vec<(String, RequestKind)> = {
        let mut guard = dsh.2.lock().unwrap_or_else(|e| e.into_inner());
        let all = guard.drain().collect();
        all
    };
    for (request_id, kind) in outstanding {
        match kind {
            RequestKind::SpendStats => answer_spend(
                app,
                SpendAnswer { ok: false, stats: None, error: Some(reason.to_string()) },
            ),
            // A model change or a catalog read: both are answered on the config
            // channel, and neither is reported as applied.
            _ => answer_config(
                app,
                ConfigResult { request_id, ok: false, error: Some(reason.to_string()), selection: None },
            ),
        }
    }
}

fn publish(app: &AppHandle, update: impl FnOnce(&mut Snapshot)) {
    let Some(dsh) = app.try_state::<Dsh>() else { return };
    let (snapshot, changed) = {
        let mut guard = dsh.0.lock().unwrap_or_else(|e| e.into_inner());
        let before = (guard.status.clone(), guard.error.clone(), guard.sessions.len());
        update(&mut guard);
        guard.updated_at = now_ms();
        let after = (guard.status.clone(), guard.error.clone(), guard.sessions.len());
        (guard.clone(), before != after)
    };
    if changed {
        // One line per transition, not per event: the log stays readable.
        match (&snapshot.status[..], &snapshot.error) {
            ("ready", _) => crate::log::line(format!(
                "dsh: connected (version {}, approvals {}, {} session(s))",
                snapshot.version.as_deref().unwrap_or("?"),
                if snapshot.approvals_enabled { "on" } else { "off" },
                snapshot.sessions.len()
            )),
            ("incompatible", Some(error)) => crate::log::line(format!("dsh: incompatible — {error}")),
            ("off", Some(error)) | ("error", Some(error)) => crate::log::line(format!("dsh: {error}")),
            _ => {}
        }
    }
    let _ = app.emit("dsh", snapshot);
}

fn set_offline(app: &AppHandle, status: &str, error: impl Into<Option<String>>) {
    let error = error.into();
    publish(app, |s| {
        s.status = status.to_string();
        s.error = error;
        // Nothing from a dead connection may be shown as live.
        s.sessions.clear();
        s.pending.clear();
        s.active_session = None;
        s.approvals_enabled = false;
        s.approval_policy = None;
        s.hardened = false;
    });
    if let Some(dsh) = app.try_state::<Dsh>() {
        *dsh.1.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
    // A command sent to a connection that has since died is not going to be
    // answered, and it certainly did not take effect.
    fail_outstanding(app, "the DSH bridge disconnected before answering");
}

/// One connection's lifetime.
async fn run_once(app: &AppHandle) {
    publish(app, |s| {
        s.status = "connecting".to_string();
        s.error = None;
    });

    let runtime = match wire::read_runtime() {
        Ok(runtime) => runtime,
        Err(error) => {
            set_offline(app, "off", Some(error));
            return;
        }
    };

    if runtime.protocol != protocol::PROTOCOL {
        set_offline(
            app,
            "incompatible",
            Some(format!(
                "the bridge speaks protocol {}, this Coucou speaks {}",
                runtime.protocol,
                protocol::PROTOCOL
            )),
        );
        return;
    }

    let mut conn = match Conn::open(&runtime.pipe, OPEN_LIMIT).await {
        Ok(conn) => conn,
        Err(err) => {
            set_offline(app, "off", Some(format!("cannot open {}: {err}", runtime.pipe)));
            return;
        }
    };

    if let Err(err) = handshake(app, &mut conn, &runtime.token).await {
        set_offline(app, "error", Some(err));
        return;
    }

    // Commands (approval answers, config changes) reach the writer through this
    // queue, so a click never touches the socket directly.
    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();
    if let Some(dsh) = app.try_state::<Dsh>() {
        *dsh.1.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    }

    let mut ticker = tokio::time::interval(PING_EVERY);
    ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
    let mut last_seen = tokio::time::Instant::now();


    loop {
        tokio::select! {
            frame = conn.next() => {
                match frame {
                    Ok(Some(line)) => {
                        last_seen = tokio::time::Instant::now();
                        if let Err(error) = absorb(app, &line) {
                            set_offline(app, "error", Some(error));
                            return;
                        }
                    }
                    Ok(None) => {
                        set_offline(app, "off", Some("DSH closed the bridge".to_string()));
                        return;
                    }
                    Err(err) => {
                        set_offline(app, "error", Some(format!("the bridge connection failed: {err}")));
                        return;
                    }
                }
            }
            Some(outgoing) = rx.recv() => {
                if let Err(err) = conn.send(&outgoing).await {
                    set_offline(app, "error", Some(format!("cannot write to the bridge: {err}")));
                    return;
                }
            }
            _ = ticker.tick() => {
                if last_seen.elapsed() > SILENCE_LIMIT {
                    set_offline(app, "error", Some("the bridge stopped answering".to_string()));
                    return;
                }
                if let Err(err) = conn.send(&protocol::ping()).await {
                    set_offline(app, "error", Some(format!("cannot ping the bridge: {err}")));
                    return;
                }
            }
        }
    }
}


async fn handshake(app: &AppHandle, conn: &mut Conn, token: &str) -> Result<(), String> {
    let hello = serde_json::to_string(&protocol::Hello::new(token)).map_err(|e| e.to_string())?;
    conn.send(&hello).await.map_err(|e| format!("cannot send the handshake: {e}"))?;

    let deadline = tokio::time::Instant::now() + HANDSHAKE_LIMIT;
    loop {
        let remaining = deadline.saturating_duration_since(tokio::time::Instant::now());
        if remaining.is_zero() {
            return Err("the bridge did not answer the handshake".into());
        }
        let line = match tokio::time::timeout(remaining, conn.next()).await {
            Ok(Ok(Some(line))) => line,
            Ok(Ok(None)) => return Err("the bridge closed the pipe during the handshake".into()),
            Ok(Err(err)) => return Err(format!("the handshake failed: {err}")),
            Err(_) => return Err("the bridge did not answer the handshake".into()),
        };
        match serde_json::from_str::<Frame>(&line) {
            Ok(Frame::Ready(ready)) => {
                adopt(app, ready);
                return Ok(());
            }
            // Anything else before `ready` means the peer is not the bridge we
            // think it is, or it refused our token.
            Ok(_) => return Err("the bridge refused the handshake (wrong token?)".into()),
            Err(err) => return Err(format!("the bridge sent an unreadable handshake: {err}")),
        }
    }
}

fn adopt(app: &AppHandle, ready: Ready) {
    let compatible = ready.compatibility.is_ok();
    let approvals = ready.approvals.is_enabled();
    let approval_policy = ready.approvals.policy.clone();
    let hardened = ready.pipe.hardened.unwrap_or(false);
    let version = ready.compatibility.version.clone();
    let problems = ready.compatibility.problems.clone();
    let catalog = ready.catalog;
    let sessions = ready.sessions;

    publish(app, |s| {
        s.status = if compatible { "ready" } else { "incompatible" }.to_string();
        s.error = if problems.is_empty() { None } else { Some(problems.join("; ")) };
        s.version = version;
        s.approvals_enabled = approvals;
        s.approval_policy = approval_policy;
        s.hardened = hardened;
        s.sessions = sessions;
        s.catalog = catalog;
        s.pending.clear();
    });
}

fn absorb(app: &AppHandle, line: &str) -> Result<(), String> {
    let frame: Frame = serde_json::from_str(line).map_err(|err| format!("unreadable frame: {err}"))?;
    match frame {
        Frame::Ready(ready) => adopt(app, ready),

        Frame::SessionUpsert { session } => publish(app, |s| {
            match s.sessions.iter_mut().find(|x| x.id == session.id) {
                Some(existing) => {
                    // The plugin re-sends the session on every change (a title,
                    // a model, a state). Its copy knows nothing about the steps
                    // or the last sentence this side collected, so the two are
                    // merged rather than one replacing the other.
                    let steps = std::mem::take(&mut existing.steps);
                    let step_seq = existing.step_seq;
                    let say = existing.say.take();
                    *existing = session;
                    existing.steps = steps;
                    existing.step_seq = step_seq;
                    existing.say = say;
                }
                None => s.sessions.push(session),
            }
        }),

        Frame::SessionState { session_id, state, since } => publish(app, |s| {
            if let Some(session) = s.session_mut(&session_id) {
                session.state = Some(state);
                if since.is_some() {
                    session.since = since;
                }
            }
        }),

        Frame::SessionModel { session_id, provider, model, reasoning_effort } => publish(app, |s| {
            if let Some(session) = s.session_mut(&session_id) {
                session.model = Some(Selection { provider, model, reasoning_effort });
            }
        }),

        Frame::SessionTurn { session_id, phase, .. } => {
            let mut cwd = String::new();
            publish(app, |s| {
                if let Some(session) = s.session_mut(&session_id) {
                    cwd = session.cwd.clone();
                    if phase == "start" {
                        session.state = Some("thinking".into());
                        session.since = Some(now_ms());
                        // A new turn starts with a clean ticker: the previous
                        // turn's steps belong to the previous turn, and so does
                        // the sentence it ended on.
                        session.steps.clear();
                        session.say = None;
                    }
                }
            });
            // A turn is a turn, whichever agent runs it: the recap counts DSH's
            // sessions next to Claude Code's, under its own pill.
            crate::recap::observe_dsh_turn(app, &session_id, &cwd, phase == "start");
        }

        // A step tick is what the island animates, and what the recap counts as
        // a tool call: it used to be dropped here, which left the card showing
        // the session's title over and over instead of what the agent did.
        Frame::SessionStep { session_id, tool, title, file } => {
            let cwd = session_cwd(app, &session_id);
            let line = step_line(title.as_deref(), tool.as_deref());
            if let Some(line) = &line {
                publish(app, |s| {
                    if let Some(session) = s.session_mut(&session_id) {
                        session.steps.push(line.clone());
                        if session.steps.len() > MAX_SESSION_STEPS {
                            let excess = session.steps.len() - MAX_SESSION_STEPS;
                            session.steps.drain(..excess);
                        }
                        session.step_seq = session.step_seq.saturating_add(1);
                    }
                });
            }
            crate::recap::observe_dsh_step(app, &session_id, &cwd, tool.as_deref(), file.as_deref());
        }

        // What the agent said out loud. The card shows this instead of the raw
        // command: "Добавлю тест на утечку" is what a person wants to read.
        Frame::SessionSay { session_id, text } => publish(app, |s| {
            if let Some(session) = s.session_mut(&session_id) {
                let line = text.trim();
                session.say = if line.is_empty() { None } else { Some(line.chars().take(200).collect()) };
            }
        }),

        Frame::ApprovalAsked(asked) => {
            // The island's click is an Allow / Deny like any other, so the
            // recap learns whose request it was before the card is answered.
            crate::recap::note_dsh_request(app, &asked.request_id);
            publish(app, |s| {
                // The plugin can re-send after a reconnect; one card per request.
                if !s.pending.iter().any(|p| p.request_id == asked.request_id) {
                    s.pending.push(asked);
                }
            })
        }

        Frame::ApprovalResolved { request_id, .. } => publish(app, |s| {
            s.pending.retain(|p| p.request_id != request_id);
        }),

        Frame::Catalog(catalog) => publish(app, |s| s.catalog = catalog),

        Frame::Usage(usage) => publish(app, |s| s.usage = Some(usage)),

        Frame::Pong { .. } => {}

        Frame::Result { request_id, ok, value, error } => {
            let kind = app
                .try_state::<Dsh>()
                .and_then(|dsh| dsh.2.lock().unwrap_or_else(|e| e.into_inner()).remove(&request_id));
            match kind {
                Some(RequestKind::Catalog) => {
                    if ok {
                        if let Some(value) = value {
                            if let Ok(catalog) = serde_json::from_value::<Catalog>(value) {
                                publish(app, |s| s.catalog = catalog);
                            }
                        }
                    }
                }
                Some(RequestKind::SetConfig { session_id }) => {
                    let message = error.and_then(|e| e.message.or(e.code));
                    if ok {
                        // The host answers with what it actually selected, read
                        // back from its own state. Showing our request instead
                        // would be a claim, not a fact.
                        let selection = value.and_then(|value| serde_json::from_value::<Selection>(value).ok());
                        if let Some(selection) = selection.clone() {
                            publish(app, |s| {
                                if let Some(session) = s.session_mut(&session_id) {
                                    session.model = Some(selection);
                                }
                            });
                        }
                        answer_config(app, ConfigResult { request_id, ok: true, error: None, selection });
                    } else {
                        let message = message.unwrap_or_else(|| "the host refused the change".to_string());
                        answer_config(
                            app,
                            ConfigResult { request_id, ok: false, error: Some(message), selection: None },
                        );
                    }
                }
                Some(RequestKind::SpendStats) => {
                    let stats = if ok {
                        value.and_then(|value| serde_json::from_value::<SpendStats>(value).ok())
                    } else {
                        None
                    };
                    let message = error.and_then(|e| e.message.or(e.code));
                    let found = stats.is_some();
                    answer_spend(
                        app,
                        SpendAnswer {
                            ok: found,
                            stats,
                            error: if found {
                                None
                            } else {
                                Some(message.unwrap_or_else(|| "the host sent no figures".into()))
                            },
                        },
                    );
                }
                None => {}
            }
        }

        Frame::Unknown => {}
    }
    Ok(())
}

/// Queues a frame for the live connection. False when DSH is not connected.
fn queue(app: &AppHandle, frame: String) -> bool {
    let Some(dsh) = app.try_state::<Dsh>() else { return false };
    let guard = dsh.1.lock().unwrap_or_else(|e| e.into_inner());
    match guard.as_ref() {
        Some(tx) => tx.send(frame).is_ok(),
        None => false,
    }
}

/// Takes one request out of the pending list.
///
/// The answer is only sent when this returns true, so a second click on the same
/// card — or a click on a card whose request already expired — cannot answer a
/// question twice. DSH would treat the second answer as a decision on whatever
/// it happened to be asking next.
pub(crate) fn take_pending(snapshot: &mut Snapshot, request_id: &str) -> bool {
    match snapshot.pending.iter().position(|p| p.request_id == request_id) {
        Some(index) => {
            snapshot.pending.remove(index);
            true
        }
        None => false,
    }
}

// ── Commands ─────────────────────────────────────────────────────────────────

#[tauri::command]
pub fn dsh_snapshot(app: AppHandle) -> Snapshot {
    app.try_state::<Dsh>()
        .map(|dsh| dsh.0.lock().unwrap_or_else(|e| e.into_inner()).clone())
        .unwrap_or_default()
}

/// Remembers which session the island is looking at. Purely local.
#[tauri::command]
pub fn dsh_select_session(app: AppHandle, session_id: Option<String>) {
    publish(&app, |s| s.active_session = session_id);
}

/// Tells the plugin the card is on screen, so it keeps the question instead of
/// handing it to DSH's own prompt.
#[tauri::command]
pub fn dsh_approval_ack(app: AppHandle, request_id: String) -> Result<(), String> {
    if queue(&app, protocol::ack(&request_id)) {
        Ok(())
    } else {
        Err("DSH is not connected".into())
    }
}

/// Answers one exact request. `decision` is "allow", "deny" or "open".
///
/// The request is removed from the pending list *before* the frame is queued:
/// a second click cannot answer twice, and a stale card cannot grant anything.
#[tauri::command]
pub fn dsh_approval(app: AppHandle, request_id: String, decision: String) -> Result<(), String> {
    let removed = {
        let Some(dsh) = app.try_state::<Dsh>() else { return Err("DSH is not connected".into()) };
        let mut guard = dsh.0.lock().unwrap_or_else(|e| e.into_inner());
        take_pending(&mut guard, &request_id)
    };
    if !removed {
        return Err("that request is no longer waiting for an answer".into());
    }

    let frame = match decision.as_str() {
        "allow" => protocol::answer(&request_id, true),
        "deny" => protocol::answer(&request_id, false),
        "open" => protocol::decline(&request_id),
        other => return Err(format!("unknown decision {other}")),
    };
    if !queue(&app, frame) {
        return Err("DSH is not connected".into());
    }
    // The recap counts an answered card like any other Allow / Deny. Handing the
    // question back to DSH ("open") is not a decision, so it is forgotten.
    if decision == "open" {
        crate::recap::forget_request(&app, &request_id);
    } else {
        crate::recap::record_decision(&app, &request_id, &decision);
    }
    publish(&app, |s| s.pending.retain(|p| p.request_id != request_id));
    Ok(())
}

/// Asks for the current catalog. Used by the island when it opens.
#[tauri::command]
pub fn dsh_refresh_catalog(app: AppHandle) -> Result<(), String> {
    let request_id = format!("catalog-{}", now_ms());
    // Registered before the frame leaves: the host can answer in the time it
    // takes this function to reach the next line, and an unregistered answer is
    // dropped as if it never came.
    if let Some(dsh) = app.try_state::<Dsh>() {
        dsh.2.lock().unwrap_or_else(|e| e.into_inner()).insert(request_id.clone(), RequestKind::Catalog);
    }
    if !queue(&app, protocol::catalog_get(&request_id)) {
        if let Some(dsh) = app.try_state::<Dsh>() {
            dsh.2.lock().unwrap_or_else(|e| e.into_inner()).remove(&request_id);
        }
        return Err("DSH is not connected".into());
    }
    Ok(())
}

/// Changes the model or the reasoning effort of one session.
///
/// Never a global default: the plugin applies it to that session only. The
/// returned id names the request, whose answer arrives as a `dsh-config` event
/// carrying what the host actually selected — not what we asked for.
#[tauri::command]
pub fn dsh_set_config(app: AppHandle, session_id: String, config_id: String, value: String) -> Result<String, String> {
    let request_id = format!("cfg-{}", now_ms());
    // Registered before the frame leaves: the host answers within the same
    // millisecond, and an answer to a request the registry does not know is
    // dropped — which would look like a timeout that never happened.
    if let Some(dsh) = app.try_state::<Dsh>() {
        dsh.2
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(request_id.clone(), RequestKind::SetConfig { session_id: session_id.clone() });
    }
    let frame = protocol::set_config(&request_id, &session_id, &config_id, &value);
    if !queue(&app, frame) {
        if let Some(dsh) = app.try_state::<Dsh>() {
            dsh.2.lock().unwrap_or_else(|e| e.into_inner()).remove(&request_id);
        }
        return Err("DSH is not connected".into());
    }
    Ok(request_id)
}

/// Asks the plugin for today's, the week's and the month's spend.
///
/// The answer arrives as a `dsh-spend` event rather than as this command's
/// return value: the provider can take a while, and the card must stay usable
/// while it waits.
#[tauri::command]
pub fn dsh_spend_stats(app: AppHandle) -> Result<(), String> {
    let request_id = format!("spend-{}", now_ms());
    if let Some(dsh) = app.try_state::<Dsh>() {
        dsh.2
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(request_id.clone(), RequestKind::SpendStats);
    }
    if !queue(&app, protocol::usage_stats(&request_id)) {
        if let Some(dsh) = app.try_state::<Dsh>() {
            dsh.2.lock().unwrap_or_else(|e| e.into_inner()).remove(&request_id);
        }
        return Err("DSH is not connected".into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pending(ids: &[&str]) -> Snapshot {
        Snapshot {
            pending: ids
                .iter()
                .map(|id| ApprovalAsked { request_id: id.to_string(), ..Default::default() })
                .collect(),
            ..Default::default()
        }
    }

    #[test]
    fn a_request_can_be_answered_once() {
        let mut snapshot = pending(&["r1"]);
        assert!(take_pending(&mut snapshot, "r1"), "the first click answers");
        assert!(snapshot.pending.is_empty());
        // The card is gone, so a second click must not reach the host.
        assert!(!take_pending(&mut snapshot, "r1"), "the second click must not answer again");
    }

    #[test]
    fn an_unknown_request_is_never_answered() {
        let mut snapshot = pending(&["r1"]);
        assert!(!take_pending(&mut snapshot, "r2"));
        assert_eq!(snapshot.pending.len(), 1, "the waiting request is untouched");
    }

    #[test]
    fn only_the_asked_request_leaves_the_queue() {
        let mut snapshot = pending(&["r1", "r2", "r3"]);
        assert!(take_pending(&mut snapshot, "r2"));
        let left: Vec<&str> = snapshot.pending.iter().map(|p| p.request_id.as_str()).collect();
        assert_eq!(left, ["r1", "r3"]);
    }

}
