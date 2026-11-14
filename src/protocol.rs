//! The one protocol. Every client (the extension through the shim, the CLI, the MCP server) speaks it
//! to `lensd`. The TypeScript side is generated from these types (`cargo test` writes
//! `extension/src/protocol/`), so the two sides cannot drift without CI failing.
use serde::{Deserialize, Serialize};
use ts_rs::TS;

pub const PROTOCOL_VERSION: u32 = 1;

/// Chrome refuses a host message larger than 1 MiB. Every client gets the same limit, so a reply
/// that works for the CLI also works for the browser.
pub const MAX_REPLY_BYTES: usize = 1024 * 1024;
pub const MAX_REQUEST_BYTES: usize = 16 * 1024 * 1024;

#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct RequestFrame {
    pub id: u32,
    #[serde(flatten)]
    pub request: Request,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "method", content = "params", rename_all = "camelCase")]
#[ts(export)]
pub enum Request {
    Hello,
    CreateObservation {
        title: String,
        url: Option<String>,
    },
    ListObservations,
    /// Ends the daemon after the reply (updates, tests). The next connection starts a new one.
    Shutdown,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct ReplyFrame {
    pub id: u32,
    #[serde(flatten)]
    pub outcome: Outcome,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "status", rename_all = "camelCase")]
#[ts(export)]
pub enum Outcome {
    Ok { result: Reply },
    Error { error: ProtocolError },
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "type", content = "data", rename_all = "camelCase")]
#[ts(export)]
pub enum Reply {
    Hello(Hello),
    Observation(Observation),
    Observations(Vec<Observation>),
    Stopping,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Hello {
    pub version: String,
    pub protocol: u32,
    pub data_dir: String,
    pub secret_store: SecretStoreStatus,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(tag = "state", rename_all = "camelCase")]
#[ts(export)]
pub enum SecretStoreStatus {
    Available,
    Unavailable { reason: String },
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Observation {
    #[ts(type = "number")]
    pub id: i64,
    pub title: String,
    pub url: Option<String>,
    /// Milliseconds since the Unix epoch.
    #[ts(type = "number")]
    pub created_at: i64,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProtocolError {
    pub code: ErrorCode,
    pub message: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum ErrorCode {
    BadRequest,
    TooLarge,
    Storage,
    Internal,
}

impl ProtocolError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
