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
    ListProjects,
    /// Creates a project when `id` is null, else replaces that project.
    SaveProject(ProjectInput),
    DeleteProject {
        #[ts(type = "number")]
        id: i64,
    },
    /// Saves a screenshot and its evidence. A null observation starts a new one, titled after the page.
    CreateCapture(NewCapture),
    ListCaptures {
        #[ts(type = "number")]
        observation: i64,
    },
    /// One chunk of a stored blob. Replies stay under 1 MiB, so large blobs take several reads.
    ReadBlob {
        sha256: String,
        #[ts(type = "number")]
        offset: u64,
        length: u32,
    },
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
    Project(Project),
    Projects(Vec<Project>),
    Deleted,
    Capture(Capture),
    Captures(Vec<Capture>),
    Blob(BlobChunk),
    Stopping,
}

pub const MAX_BLOB_CHUNK: u32 = 512 * 1024;

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Project {
    #[ts(type = "number")]
    pub id: i64,
    pub name: String,
    /// Exact origins such as `https://shop.example.com`. Evidence is collected only on these.
    pub origins: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct ProjectInput {
    #[ts(type = "number | null")]
    pub id: Option<i64>,
    pub name: String,
    pub origins: Vec<String>,
    pub enabled: bool,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct NewCapture {
    #[ts(type = "number | null")]
    pub observation: Option<i64>,
    pub page_url: String,
    pub page_title: String,
    /// PNG bytes, base64.
    pub screenshot: String,
    pub evidence: Evidence,
}

/// What the collector saw before the capture, and what it could not see.
#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Evidence {
    pub mode: CaptureMode,
    pub events: Vec<EvidenceEvent>,
    pub gaps: Vec<CoverageGap>,
    pub page: Option<serde_json::Value>,
}

#[derive(Debug, Clone, Copy, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub enum CaptureMode {
    /// Chromium `debugger`: network with bodies, console, exceptions.
    Deep,
    /// `webRequest` metadata only (Firefox, or when the debugger is refused).
    Limited,
    /// No collector on this tab: the screenshot alone.
    ScreenshotOnly,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct EvidenceEvent {
    #[ts(type = "number")]
    pub timestamp: i64,
    pub kind: String,
    pub data: serde_json::Value,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct CoverageGap {
    pub channel: String,
    pub reason: String,
    #[ts(type = "number")]
    pub started_at: i64,
    #[ts(type = "number | null")]
    pub ended_at: Option<i64>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Capture {
    #[ts(type = "number")]
    pub id: i64,
    #[ts(type = "number")]
    pub observation: i64,
    #[ts(type = "number")]
    pub created_at: i64,
    pub page_url: String,
    pub page_title: String,
    pub mode: CaptureMode,
    pub screenshot: BlobRef,
    /// The full `Evidence` as JSON.
    pub evidence: BlobRef,
    pub event_count: u32,
    pub gap_count: u32,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlobRef {
    pub sha256: String,
    #[ts(type = "number")]
    pub size: u64,
    pub media_type: String,
}

#[derive(Debug, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct BlobChunk {
    /// Base64.
    pub data: String,
    #[ts(type = "number")]
    pub total_size: u64,
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
    NotFound,
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
