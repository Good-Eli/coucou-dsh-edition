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

use super::protocol::{self, ApprovalAsked, Catalog, Frame, Ready, Selection, Session};
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

/// What the island shows about DSH.
#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    /// "off" | "connecting" | "ready" | "incompatible" | "error"
    pub status: String,
    pub error: Option<String>,
    pub version: Option<String>,
    /// False when the plugin refused to intercept approvals (version mismatch,
    /// token file not private, …). The island must then show no card at all.
    pub approvals_enabled: bool,
    /// Whether the pipe the host created is private to this user.
    pub hardened: bool,
    pub sessions: Vec<Session>,
    pub catalog: Catalog,
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

/// Shared with the Tauri commands.
pub struct Dsh(pub Mutex<Snapshot>, Mutex<Option<tokio::sync::mpsc::UnboundedSender<String>>>);

pub fn now_ms() -> i64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// Starts the client. It reconnects forever: DSH starting after Coucou, or
/// restarting, is normal.
pub fn start(app: AppHandle) {
    app.manage(Dsh(Mutex::new(Snapshot { status: "connecting".into(), ..Default::default() }), Mutex::new(None)));
    tauri::async_runtime::spawn(async move {
        loop {
            run_once(&app).await;
            tokio::time::sleep(RETRY_EVERY).await;
        }
    });
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
        s.hardened = false;
    });
    if let Some(dsh) = app.try_state::<Dsh>() {
        *dsh.1.lock().unwrap_or_else(|e| e.into_inner()) = None;
    }
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
    let mut requests: HashMap<String, RequestKind> = HashMap::new();

    loop {
        tokio::select! {
            frame = conn.next() => {
                match frame {
                    Ok(Some(line)) => {
                        last_seen = tokio::time::Instant::now();
                        if let Err(error) = absorb(app, &line, &mut requests) {
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

/// What a `result` frame belongs to.
#[derive(Debug, Clone)]
enum RequestKind {
    Catalog,
    SetConfig { session_id: String },
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
        s.hardened = hardened;
        s.sessions = sessions;
        s.catalog = catalog;
        s.pending.clear();
    });
}

fn absorb(app: &AppHandle, line: &str, requests: &mut HashMap<String, RequestKind>) -> Result<(), String> {
    let frame: Frame = serde_json::from_str(line).map_err(|err| format!("unreadable frame: {err}"))?;
    match frame {
        Frame::Ready(ready) => adopt(app, ready),

        Frame::SessionUpsert { session } => publish(app, |s| {
            match s.sessions.iter_mut().find(|x| x.id == session.id) {
                Some(existing) => *existing = session,
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

        Frame::SessionTurn { session_id, phase, .. } => publish(app, |s| {
            if let Some(session) = s.session_mut(&session_id) {
                if phase == "start" {
                    session.state = Some("thinking".into());
                    session.since = Some(now_ms());
                }
            }
        }),

        // A step tick is what the island animates; the session's own state
        // frames already carry what the UI shows.
        Frame::SessionStep { .. } => {}

        Frame::ApprovalAsked(asked) => publish(app, |s| {
            // The plugin can re-send after a reconnect; one card per request.
            if !s.pending.iter().any(|p| p.request_id == asked.request_id) {
                s.pending.push(asked);
            }
        }),

        Frame::ApprovalResolved { request_id, .. } => publish(app, |s| {
            s.pending.retain(|p| p.request_id != request_id);
        }),

        Frame::Catalog(catalog) => publish(app, |s| s.catalog = catalog),

        Frame::Pong { .. } => {}

        Frame::Result { request_id, ok, value, error } => {
            match requests.remove(&request_id) {
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
                    if ok {
                        if let Some(value) = value {
                            if let Ok(selection) = serde_json::from_value::<Selection>(value) {
                                publish(app, |s| {
                                    if let Some(session) = s.session_mut(&session_id) {
                                        session.model = Some(selection);
                                    }
                                });
                            }
                        }
                    } else {
                        let message = error
                            .and_then(|e| e.message.or(e.code))
                            .unwrap_or_else(|| "the host refused the change".to_string());
                        publish(app, |s| s.error = Some(message));
                    }
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
    publish(&app, |s| s.pending.retain(|p| p.request_id != request_id));
    Ok(())
}

/// Asks for the current catalog. Used by the island when it opens.
#[tauri::command]
pub fn dsh_refresh_catalog(app: AppHandle) -> Result<(), String> {
    let request_id = format!("catalog-{}", now_ms());
    if queue(&app, protocol::catalog_get(&request_id)) {
        Ok(())
    } else {
        Err("DSH is not connected".into())
    }
}

/// Changes the model or the reasoning effort of one session.
///
/// Never a global default: the plugin applies it to that session only.
#[tauri::command]
pub fn dsh_set_config(app: AppHandle, session_id: String, config_id: String, value: String) -> Result<(), String> {
    let request_id = format!("cfg-{}", now_ms());
    let frame = protocol::set_config(&request_id, &session_id, &config_id, &value);
    if queue(&app, frame) {
        Ok(())
    } else {
        Err("DSH is not connected".into())
    }
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
