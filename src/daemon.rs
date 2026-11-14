//! `lensd`: the one process per user that owns the notebook. Every client talks to it; nothing else
//! opens the database.
use crate::framing::{read_frame, write_frame};
use crate::paths::Paths;
use crate::protocol::*;
use crate::store::Store;
use crate::{ipc, secrets};
use interprocess::local_socket::{Stream, prelude::*};
use std::fs::{File, TryLockError};
use std::sync::{Arc, Mutex};
use std::time::{SystemTime, UNIX_EPOCH};

pub struct Daemon {
    store: Mutex<Store>,
    data_dir: String,
}

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
    let daemon = Arc::new(Daemon {
        store: Mutex::new(store),
        data_dir: paths.data.display().to_string(),
    });
    let listener = ipc::listen(paths)?;
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

    fn handle(&self, request: Request) -> Outcome {
        let store = self
            .store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let result = match request {
            Request::Hello => Ok(Reply::Hello(Hello {
                version: env!("CARGO_PKG_VERSION").into(),
                protocol: PROTOCOL_VERSION,
                data_dir: self.data_dir.clone(),
                secret_store: secrets::status(),
            })),
            Request::CreateObservation { title, url } => {
                let title = title.trim();
                if title.is_empty() {
                    return Outcome::Error {
                        error: ProtocolError::new(ErrorCode::BadRequest, "the title is empty"),
                    };
                }
                store
                    .create_observation(title, url.as_deref(), now_ms())
                    .map(Reply::Observation)
            }
            Request::ListObservations => store.list_observations().map(Reply::Observations),
            Request::Shutdown => Ok(Reply::Stopping),
        };
        match result {
            Ok(result) => Outcome::Ok { result },
            Err(e) => Outcome::Error {
                error: ProtocolError::new(ErrorCode::Storage, e.to_string()),
            },
        }
    }
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
        let daemon = Daemon {
            store: Mutex::new(store),
            data_dir: dir.path().display().to_string(),
        };
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
}
