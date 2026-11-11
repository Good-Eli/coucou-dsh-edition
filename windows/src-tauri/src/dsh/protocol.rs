// The wire format of the DSH Host Bridge.
//
// One JSON object per line, both ways. The plugin lives in the DSH host
// (dsh-plugin/bridge.mjs) and owns the server; Coucou is the client and never
// answers an approval on its own.
//
// Every field the island reads is optional in parsing: a newer plugin that adds
// a key must not break an older Coucou, and a window between versions must
// degrade to "nothing to show" rather than an error.

use serde::{Deserialize, Serialize};

/// Bumped whenever the framing changes. The plugin refuses a mismatch.
pub const PROTOCOL: u32 = 1;

/// What Coucou sends first. Nothing else is accepted before `ready`.
#[derive(Debug, Serialize)]
pub struct Hello<'a> {
    pub t: &'static str,
    pub protocol: u32,
    pub token: &'a str,
    pub client: &'static str,
}

impl<'a> Hello<'a> {
    pub fn new(token: &'a str) -> Self {
        Self { t: "hello", protocol: PROTOCOL, token, client: "coucou" }
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PipeInfo {
    pub hardened: Option<bool>,
    pub sddl: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SecurityInfo {
    pub token_private: Option<bool>,
    pub directory_private: Option<bool>,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Compatibility {
    pub ok: Option<bool>,
    pub version: Option<String>,
    #[serde(default)]
    pub problems: Vec<String>,
}

impl Compatibility {
    pub fn is_ok(&self) -> bool {
        self.ok.unwrap_or(false)
    }
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Approvals {
    pub enabled: Option<bool>,
}

impl Approvals {
    pub fn is_enabled(&self) -> bool {
        self.enabled.unwrap_or(false)
    }
}

/// A reasoning level a model actually supports.
#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Effort {
    pub id: String,
    #[serde(default)]
    pub name: String,
}

/// One model, with the efforts that belong to it and nobody else's.
#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Model {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub efforts: Vec<Effort>,
    pub default_effort: Option<String>,
    pub context_window: Option<i64>,
    pub max_tokens: Option<i64>,
}

#[derive(Debug, Clone, Deserialize, Serialize)]
pub struct Provider {
    pub id: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub models: Vec<Model>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Catalog {
    #[serde(default)]
    pub providers: Vec<Provider>,
    pub fetched_at: Option<i64>,
}

/// The model a session is actually running with.
///
/// These come from DSH's own selection, never from a guess: the island shows
/// what the host reports or nothing at all.
#[derive(Debug, Clone, Default, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Selection {
    pub provider: String,
    pub model: String,
    pub reasoning_effort: Option<String>,
}

#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    #[serde(default)]
    pub cwd: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub agent_preset: Option<String>,
    #[serde(default)]
    pub created_at: Option<i64>,
    #[serde(default)]
    pub model: Option<Selection>,
    #[serde(default)]
    pub state: Option<String>,
    #[serde(default)]
    pub since: Option<i64>,
}

/// The first frame after a successful handshake.
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Ready {
    #[serde(default)]
    pub protocol: u32,
    pub host_pid: Option<u32>,
    #[serde(default)]
    pub pipe: PipeInfo,
    #[serde(default)]
    pub security: SecurityInfo,
    #[serde(default)]
    pub compatibility: Compatibility,
    #[serde(default)]
    pub approvals: Approvals,
    #[serde(default)]
    pub catalog: Catalog,
    #[serde(default)]
    pub sessions: Vec<Session>,
}

/// A question the island may answer.
#[derive(Debug, Clone, Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovalAsked {
    pub request_id: String,
    #[serde(default)]
    pub session_id: Option<String>,
    #[serde(default)]
    pub call_id: Option<String>,
    #[serde(default)]
    pub tool: String,
    #[serde(default)]
    pub reason: String,
    #[serde(default)]
    pub title: Option<String>,
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub files: Vec<String>,
    #[serde(default)]
    pub expires_at: Option<i64>,
}

/// Frames the plugin sends after the handshake.
#[derive(Debug, Clone, Deserialize)]
#[serde(tag = "t")]
pub enum Frame {
    #[serde(rename = "ready")]
    Ready(Ready),

    #[serde(rename = "session.upsert")]
    SessionUpsert { session: Session },

    #[serde(rename = "session.state")]
    SessionState {
        #[serde(rename = "sessionId")]
        session_id: String,
        state: String,
        #[serde(default)]
        since: Option<i64>,
    },

    #[serde(rename = "session.model")]
    SessionModel {
        #[serde(rename = "sessionId")]
        session_id: String,
        provider: String,
        model: String,
        #[serde(default, rename = "reasoningEffort")]
        reasoning_effort: Option<String>,
    },

    #[serde(rename = "session.turn")]
    SessionTurn {
        #[serde(rename = "sessionId")]
        session_id: String,
        phase: String,
        #[serde(default)]
        reason: Option<String>,
    },

    #[serde(rename = "session.step")]
    SessionStep {
        #[serde(rename = "sessionId")]
        session_id: String,
        #[serde(default)]
        tool: Option<String>,
        #[serde(default)]
        title: Option<String>,
    },

    #[serde(rename = "approval.asked")]
    ApprovalAsked(ApprovalAsked),

    #[serde(rename = "approval.resolved")]
    ApprovalResolved { #[serde(rename = "requestId")] request_id: String, outcome: String },

    #[serde(rename = "catalog")]
    Catalog(Catalog),

    #[serde(rename = "pong")]
    Pong { #[serde(default)] ts: Option<i64> },

    #[serde(rename = "result")]
    Result {
        #[serde(rename = "requestId")]
        request_id: String,
        #[serde(default)]
        ok: bool,
        #[serde(default)]
        value: Option<serde_json::Value>,
        #[serde(default)]
        error: Option<Failure>,
    },

    /// A frame this build does not know. Ignored on purpose: the plugin may be
    /// newer than the app.
    #[serde(other)]
    Unknown,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Failure {
    pub code: Option<String>,
    pub message: Option<String>,
}

/// Frames Coucou sends after the handshake.
pub fn answer(request_id: &str, allow: bool) -> String {
    serde_json::json!({
        "t": "approval.answer",
        "requestId": request_id,
        "decision": if allow { "allow" } else { "deny" },
    })
    .to_string()
}

pub fn ack(request_id: &str) -> String {
    serde_json::json!({ "t": "approval.ack", "requestId": request_id }).to_string()
}

/// Hands the question to DSH's own prompt instead of answering it.
pub fn decline(request_id: &str) -> String {
    serde_json::json!({ "t": "approval.decline", "requestId": request_id }).to_string()
}

pub fn ping() -> String {
    serde_json::json!({ "t": "ping" }).to_string()
}

pub fn catalog_get(request_id: &str) -> String {
    serde_json::json!({ "t": "catalog.get", "requestId": request_id }).to_string()
}

/// Changes the model or the effort of one session, never a global default.
pub fn set_config(request_id: &str, session_id: &str, config_id: &str, value: &str) -> String {
    serde_json::json!({
        "t": "session.setConfig",
        "requestId": request_id,
        "sessionId": session_id,
        "configId": config_id,
        "value": value,
    })
    .to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_ready_frame_carries_the_session_and_its_real_model() {
        let line = r#"{"t":"ready","protocol":1,"hostPid":42,
            "pipe":{"hardened":true,"sddl":"D:P(A;;FA;;;SY)"},
            "security":{"tokenPrivate":true,"directoryPrivate":true},
            "compatibility":{"ok":true,"version":"0.2.2-rc.1","problems":[]},
            "approvals":{"enabled":true},
            "catalog":{"providers":[{"id":"p","name":"P","models":[
              {"id":"m","name":"M","efforts":[{"id":"off","name":"Off"},{"id":"high","name":"High"}],
               "defaultEffort":"high","contextWindow":1000}]}],"fetchedAt":7},
            "sessions":[{"id":"s1","cwd":"C:/w","title":"T","agentPreset":"standard",
              "createdAt":1,"model":{"provider":"p","model":"m","reasoningEffort":"high"},
              "state":"working","since":9}]}"#;
        let frame: Frame = serde_json::from_str(line).expect("parses");
        let Frame::Ready(ready) = frame else { panic!("expected ready") };
        assert_eq!(ready.protocol, PROTOCOL);
        assert!(ready.compatibility.is_ok());
        assert!(ready.approvals.is_enabled());
        assert!(ready.pipe.hardened.unwrap_or(false));
        assert!(ready.security.token_private.unwrap_or(false));
        let model = &ready.catalog.providers[0].models[0];
        // The efforts belong to this model, and only this model.
        assert_eq!(model.efforts.iter().map(|e| e.id.as_str()).collect::<Vec<_>>(), ["off", "high"]);
        assert_eq!(model.default_effort.as_deref(), Some("high"));
        let session = &ready.sessions[0];
        assert_eq!(session.model.as_ref().unwrap().reasoning_effort.as_deref(), Some("high"));
        assert_eq!(session.state.as_deref(), Some("working"));
    }

    #[test]
    fn a_frame_this_build_does_not_know_is_ignored() {
        let frame: Frame = serde_json::from_str(r#"{"t":"something.new","x":1}"#).expect("parses");
        assert!(matches!(frame, Frame::Unknown));
    }

    #[test]
    fn a_partial_ready_still_parses() {
        // An older or newer plugin may omit what this build reads.
        let frame: Frame = serde_json::from_str(r#"{"t":"ready","protocol":1}"#).expect("parses");
        let Frame::Ready(ready) = frame else { panic!("expected ready") };
        assert!(!ready.compatibility.is_ok(), "no compatibility means not ok");
        assert!(!ready.approvals.is_enabled(), "no approvals means none may be answered");
        assert!(ready.sessions.is_empty());
    }

    #[test]
    fn an_approval_keeps_the_fields_the_card_shows() {
        let line = r#"{"t":"approval.asked","requestId":"r1","sessionId":"s1","tool":"pwsh",
            "reason":"escalate","command":"cargo build","files":["a.rs"],"expiresAt":123}"#;
        let Frame::ApprovalAsked(asked) = serde_json::from_str::<Frame>(line).unwrap() else {
            panic!("expected approval.asked")
        };
        assert_eq!(asked.request_id, "r1");
        assert_eq!(asked.tool, "pwsh");
        assert_eq!(asked.files, ["a.rs"]);
    }

    #[test]
    fn the_hello_names_the_protocol_and_the_token() {
        let text = serde_json::to_string(&Hello::new("abc")).unwrap();
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["t"], "hello");
        assert_eq!(value["protocol"], PROTOCOL);
        assert_eq!(value["token"], "abc");
    }

    #[test]
    fn the_answers_carry_the_request_they_belong_to() {
        let allow: serde_json::Value = serde_json::from_str(&answer("r1", true)).unwrap();
        assert_eq!(allow["t"], "approval.answer");
        assert_eq!(allow["decision"], "allow");
        assert_eq!(allow["requestId"], "r1");

        let deny: serde_json::Value = serde_json::from_str(&answer("r2", false)).unwrap();
        assert_eq!(deny["decision"], "deny");

        let decline: serde_json::Value = serde_json::from_str(&decline("r3")).unwrap();
        assert_eq!(decline["t"], "approval.decline");
        assert_eq!(decline["requestId"], "r3");
    }

    #[test]
    fn a_session_config_names_the_session_and_the_option() {
        let text = set_config("r1", "s1", "reasoning_effort", "high");
        let value: serde_json::Value = serde_json::from_str(&text).unwrap();
        assert_eq!(value["t"], "session.setConfig");
        assert_eq!(value["sessionId"], "s1");
        assert_eq!(value["configId"], "reasoning_effort");
        assert_eq!(value["value"], "high");
    }
}