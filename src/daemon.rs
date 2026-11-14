//! `lensd`: the one process per user that owns the notebook. Every client talks to it; nothing else
//! opens the database.
use crate::blobs::Blobs;
use crate::framing::{read_frame, write_frame};
use crate::paths::Paths;
use crate::protocol::*;
use crate::store::{CaptureRow, Store, Updated};
use crate::{ipc, secrets};
use base64::Engine;
use base64::engine::general_purpose::STANDARD as BASE64;
use interprocess::local_socket::{Stream, prelude::*};
use std::fs::{File, TryLockError};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Daemon {
    store: Mutex<Store>,
    blobs: Blobs,
    data_dir: String,
}

/// A screenshot of a 4K display at 2x is about 10 MiB of PNG; the request limit leaves room for base64.
const MAX_SCREENSHOT_BYTES: usize = 12 * 1024 * 1024;

/// Returns `Ok(())` at once when another daemon already holds the lock: the caller then connects to it.
pub fn run(paths: &Paths) -> std::io::Result<()> {
    paths.ensure()?;
    let lock = File::options()
        .create(true)
        .truncate(false)
        .write(true)
        .open(paths.lock())?;
    match lock.try_lock() {
        Ok(()) => {}
        Err(TryLockError::WouldBlock) => return Ok(()),
        Err(TryLockError::Error(e)) => return Err(e),
    }
    let store = Store::open(&paths.database()).map_err(std::io::Error::other)?;
    let daemon = Arc::new(Daemon::new(store, paths));
    let listener = ipc::listen(paths).map_err(|e| {
        std::io::Error::new(
            e.kind(),
            format!(
                "cannot open the Lens endpoint in {}: {e}",
                paths.runtime.display()
            ),
        )
    })?;
    for connection in listener.incoming() {
        match connection {
            Ok(stream) => {
                let daemon = daemon.clone();
                std::thread::spawn(move || {
                    if let Err(e) = serve(&daemon, stream) {
                        eprintln!("lensd: connection ended: {e}");
                    }
                });
            }
            Err(e) => eprintln!("lensd: accept failed: {e}"),
        }
    }
    drop(lock);
    Ok(())
}

fn serve(daemon: &Daemon, stream: Stream) -> std::io::Result<()> {
    let mut stream = &stream;
    while let Some(frame) = read_frame(&mut stream, MAX_REQUEST_BYTES)? {
        let (reply, stop) = daemon.answer(&frame);
        write_frame(&mut stream, &reply)?;
        if stop {
            std::process::exit(0);
        }
    }
    Ok(())
}

impl Daemon {
    /// One request frame in, one reply frame out, and whether the daemon stops after sending it.
    /// Never fails: a broken request gets an error reply.
    pub fn answer(&self, frame: &[u8]) -> (Vec<u8>, bool) {
        let mut stop = false;
        let reply = match serde_json::from_slice::<RequestFrame>(frame) {
            Ok(request) => {
                stop = matches!(request.request, Request::Shutdown);
                ReplyFrame {
                    id: request.id,
                    outcome: self.handle(request.request),
                }
            }
            Err(e) => ReplyFrame {
                id: serde_json::from_slice::<serde_json::Value>(frame)
                    .ok()
                    .and_then(|v| v.get("id")?.as_u64())
                    .and_then(|id| u32::try_from(id).ok())
                    .unwrap_or(0),
                outcome: Outcome::Error {
                    error: ProtocolError::new(ErrorCode::BadRequest, e.to_string()),
                },
            },
        };
        let bytes = serde_json::to_vec(&reply).expect("protocol types serialize");
        if bytes.len() <= MAX_REPLY_BYTES {
            return (bytes, stop);
        }
        let too_large = ReplyFrame {
            id: reply.id,
            outcome: Outcome::Error {
                error: ProtocolError::new(
                    ErrorCode::TooLarge,
                    format!("reply of {} bytes exceeds 1 MiB", bytes.len()),
                ),
            },
        };
        (
            serde_json::to_vec(&too_large).expect("protocol types serialize"),
            stop,
        )
    }

    pub fn new(store: Store, paths: &Paths) -> Self {
        Self {
            store: Mutex::new(store),
            blobs: Blobs::new(paths.blobs()),
            data_dir: paths.data.display().to_string(),
        }
    }

    fn handle(&self, request: Request) -> Outcome {
        match self.reply(request) {
            Ok(result) => Outcome::Ok { result },
            Err(error) => Outcome::Error { error },
        }
    }

    fn reply(&self, request: Request) -> Result<Reply, ProtocolError> {
        let mut store = self
            .store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        Ok(match request {
            Request::Hello => Reply::Hello(Hello {
                version: env!("CARGO_PKG_VERSION").into(),
                protocol: PROTOCOL_VERSION,
                data_dir: self.data_dir.clone(),
                secret_store: secrets::status(),
            }),
            Request::CreateObservation { title, url } => {
                let title = title.trim();
                if title.is_empty() {
                    return Err(bad("the title is empty"));
                }
                Reply::Observation(
                    store
                        .create_observation(title, url.as_deref(), now_ms())
                        .map_err(storage)?,
                )
            }
            Request::ListObservations => {
                Reply::Observations(store.list_observations().map_err(storage)?)
            }
            Request::GetObservation { id } => Reply::Observation(
                store
                    .get_observation(id)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such observation"))?,
            ),
            Request::UpdateObservation(update) => {
                let title = update.title.trim();
                if title.is_empty() {
                    return Err(bad("the title is empty"));
                }
                if update.notes.len() > MAX_NOTES_BYTES {
                    return Err(ProtocolError::new(
                        ErrorCode::TooLarge,
                        "the notes exceed 256 KiB",
                    ));
                }
                let outcome = store
                    .update_observation(update.id, update.revision, title, &update.notes, now_ms())
                    .map_err(storage)?;
                match outcome {
                    Updated::Saved(saved) => Reply::Observation(saved),
                    Updated::Conflict(current) => {
                        return Err(ProtocolError::new(
                            ErrorCode::Conflict,
                            format!(
                                "the observation changed elsewhere (revision {} is current)",
                                current.revision
                            ),
                        ));
                    }
                    Updated::Missing => return Err(not_found("no such observation")),
                }
            }
            Request::ListProjects => Reply::Projects(store.list_projects().map_err(storage)?),
            Request::SaveProject(input) => {
                let name = input.name.trim();
                if name.is_empty() {
                    return Err(bad("the project name is empty"));
                }
                let mut origins = Vec::new();
                for origin in &input.origins {
                    let origin = normalize_origin(origin)?;
                    if !origins.contains(&origin) {
                        origins.push(origin);
                    }
                }
                if origins.is_empty() {
                    return Err(bad("a project needs at least one origin"));
                }
                let saved = store
                    .save_project(input.id, name, &origins, input.enabled)
                    .map_err(storage)?;
                Reply::Project(saved.ok_or_else(|| not_found("no such project"))?)
            }
            Request::DeleteProject { id } => match store.delete_project(id).map_err(storage)? {
                true => Reply::Deleted,
                false => return Err(not_found("no such project")),
            },
            Request::CreateCapture(capture) => {
                let screenshot = BASE64
                    .decode(capture.screenshot.as_bytes())
                    .map_err(|e| bad(format!("the screenshot is not base64: {e}")))?;
                if !screenshot.starts_with(b"\x89PNG\r\n\x1a\n") {
                    return Err(bad("the screenshot is not a PNG"));
                }
                if screenshot.len() > MAX_SCREENSHOT_BYTES {
                    return Err(ProtocolError::new(
                        ErrorCode::TooLarge,
                        "the screenshot exceeds 12 MiB",
                    ));
                }
                let page_url = url::Url::parse(&capture.page_url)
                    .map_err(|e| bad(format!("the page URL is not valid: {e}")))?;
                let evidence = serde_json::to_vec(&capture.evidence).expect("evidence serializes");
                let row = CaptureRow {
                    created_at: now_ms(),
                    page_url: page_url.into(),
                    page_title: capture.page_title,
                    mode: capture.evidence.mode,
                    screenshot: self.blobs.put(&screenshot, "image/png").map_err(storage)?,
                    evidence: self
                        .blobs
                        .put(&evidence, "application/json")
                        .map_err(storage)?,
                    event_count: capture.evidence.events.len() as u32,
                    gap_count: capture.evidence.gaps.len() as u32,
                };
                let saved = store
                    .create_capture(capture.observation, row)
                    .map_err(storage)?;
                Reply::Capture(saved.ok_or_else(|| not_found("no such observation"))?)
            }
            Request::ListCaptures { observation } => {
                Reply::Captures(store.list_captures(observation).map_err(storage)?)
            }
            Request::GetCapture { id } => Reply::Capture(
                store
                    .get_capture(id)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such capture"))?,
            ),
            Request::SaveAnnotations { capture, shapes } => {
                if shapes.len() > MAX_SHAPES {
                    return Err(bad(format!("more than {MAX_SHAPES} shapes")));
                }
                for shape in &shapes {
                    shape.validate().map_err(bad)?;
                }
                if !store.save_annotations(capture, &shapes).map_err(storage)? {
                    return Err(not_found("no such capture"));
                }
                Reply::Capture(
                    store
                        .get_capture(capture)
                        .map_err(storage)?
                        .ok_or_else(|| not_found("no such capture"))?,
                )
            }
            Request::ReadBlob {
                sha256,
                offset,
                length,
            } => {
                drop(store);
                let (chunk, total_size) = self
                    .blobs
                    .read(&sha256, offset, length.min(MAX_BLOB_CHUNK))
                    .map_err(|e| match e.kind() {
                        std::io::ErrorKind::NotFound => not_found("no such blob"),
                        std::io::ErrorKind::InvalidInput => bad(e.to_string()),
                        _ => storage(e),
                    })?;
                Reply::Blob(BlobChunk {
                    data: BASE64.encode(chunk),
                    total_size,
                })
            }
            Request::Shutdown => Reply::Stopping,
        })
    }
}

fn bad(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCode::BadRequest, message)
}

fn not_found(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new(ErrorCode::NotFound, message)
}

fn storage(error: impl std::fmt::Display) -> ProtocolError {
    ProtocolError::new(ErrorCode::Storage, error.to_string())
}

/// `https://Shop.Example.com:443/` becomes `https://shop.example.com`. Paths, queries, fragments,
/// credentials and schemes other than http and https are refused, so an origin means one origin.
pub fn normalize_origin(input: &str) -> Result<String, ProtocolError> {
    let refused = || {
        bad(format!(
            "{input:?} is not an origin such as https://shop.example.com"
        ))
    };
    let url = url::Url::parse(input.trim()).map_err(|_| refused())?;
    let plain = url.path() == "/" && url.query().is_none() && url.fragment().is_none();
    let anonymous = url.username().is_empty() && url.password().is_none();
    if !matches!(url.scheme(), "http" | "https") || !plain || !anonymous || url.host().is_none() {
        return Err(refused());
    }
    Ok(url.origin().ascii_serialization())
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn daemon() -> (tempfile::TempDir, Daemon) {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let paths = Paths {
            data: dir.path().to_path_buf(),
            runtime: dir.path().join("run"),
        };
        let daemon = Daemon::new(store, &paths);
        (dir, daemon)
    }

    fn ask(daemon: &Daemon, json: &str) -> serde_json::Value {
        serde_json::from_slice(&daemon.answer(json.as_bytes()).0).unwrap()
    }

    #[test]
    fn answers_requests_and_reports_bad_ones() {
        let (_dir, daemon) = daemon();
        let created = ask(
            &daemon,
            r#"{"id":7,"method":"createObservation","params":{"title":" Cart total ","url":null}}"#,
        );
        assert_eq!(created["id"], 7);
        assert_eq!(created["status"], "ok");
        assert_eq!(created["result"]["data"]["title"], "Cart total");

        let listed = ask(&daemon, r#"{"id":8,"method":"listObservations"}"#);
        assert_eq!(listed["result"]["data"].as_array().unwrap().len(), 1);

        let empty = ask(
            &daemon,
            r#"{"id":9,"method":"createObservation","params":{"title":"  ","url":null}}"#,
        );
        assert_eq!(empty["error"]["code"], "badRequest");

        let unknown = ask(&daemon, r#"{"id":10,"method":"dropTables"}"#);
        assert_eq!(
            (unknown["id"].as_u64(), unknown["status"].as_str()),
            (Some(10), Some("error"))
        );

        assert!(daemon.answer(br#"{"id":11,"method":"shutdown"}"#).1);
        assert!(!daemon.answer(br#"{"id":12,"method":"hello"}"#).1);
    }

    #[test]
    fn normalizes_origins_and_refuses_anything_else() {
        assert_eq!(
            normalize_origin(" https://Shop.Example.com:443/ ").unwrap(),
            "https://shop.example.com"
        );
        assert_eq!(
            normalize_origin("http://127.0.0.1:8080").unwrap(),
            "http://127.0.0.1:8080"
        );
        for bad in [
            "shop.example.com",
            "https://a.test/cart",
            "https://a.test/?q=1",
            "https://u:p@a.test",
            "file:///etc",
            "chrome://settings",
        ] {
            assert!(normalize_origin(bad).is_err(), "{bad} was accepted");
        }
    }

    #[test]
    fn stores_a_capture_and_serves_its_blobs_in_chunks() {
        let (_dir, daemon) = daemon();
        let png = [b"\x89PNG\r\n\x1a\n".as_slice(), &[7u8; 600 * 1024]].concat();
        let request = serde_json::json!({
            "id": 1, "method": "createCapture", "params": {
                "observation": null, "pageUrl": "http://127.0.0.1:4100/cart", "pageTitle": "Cart",
                "screenshot": BASE64.encode(&png),
                "evidence": { "mode": "deep", "page": null, "gaps": [],
                    "events": [{ "timestamp": 1, "kind": "console", "data": { "level": "error" } }] }
            }
        });
        let reply = ask(&daemon, &request.to_string());
        assert_eq!(reply["status"], "ok", "{reply}");
        let capture = &reply["result"]["data"];
        assert_eq!(
            (capture["eventCount"].as_u64(), capture["mode"].as_str()),
            (Some(1), Some("deep"))
        );

        let sha = capture["screenshot"]["sha256"].as_str().unwrap();
        let mut read = Vec::new();
        while read.len() < png.len() {
            let chunk = ask(
                &daemon,
                &serde_json::json!({ "id": 2, "method": "readBlob",
                "params": { "sha256": sha, "offset": read.len(), "length": 1_000_000 } })
                .to_string(),
            );
            let data = BASE64
                .decode(chunk["result"]["data"]["data"].as_str().unwrap())
                .unwrap();
            assert!(data.len() as u32 <= MAX_BLOB_CHUNK && !data.is_empty());
            read.extend(data);
        }
        assert_eq!(read, png);

        let not_png = serde_json::json!({ "id": 3, "method": "createCapture", "params": {
            "observation": null, "pageUrl": "http://a.test/", "pageTitle": "", "screenshot": BASE64.encode(b"GIF89a"),
            "evidence": { "mode": "screenshotOnly", "page": null, "gaps": [], "events": [] } } });
        assert_eq!(
            ask(&daemon, &not_png.to_string())["error"]["code"],
            "badRequest"
        );
    }
}
