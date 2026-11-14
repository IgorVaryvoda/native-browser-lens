//! `lensd`: the one process per user that owns the notebook. Every client talks to it; nothing else
//! opens the database.
use crate::blobs::Blobs;
use crate::framing::{read_frame, write_frame};
use crate::paths::Paths;
use crate::protocol::*;
use crate::store::{CaptureRow, Store, Updated};
use crate::vibeq::{self, Client};
use crate::{export, filing, investigate, ipc, render, repro, secrets};
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
    downloads: std::path::PathBuf,
    filings: std::path::PathBuf,
    notebook: std::path::PathBuf,
    paths: Paths,
}

const TOKEN_ACCOUNT: &str = "vibeq-token";
/// A token from the environment wins over the secret store: for CI and automation, where no
/// keyring runs. People use Settings.
const TOKEN_ENV: &str = "LENS_VIBEQ_TOKEN";

fn vibeq_settings(store: &Store) -> Result<VibeQSettings, ProtocolError> {
    let has_token = saved_token().ok().flatten().is_some();
    Ok(VibeQSettings {
        endpoint: store.setting("vibeq.endpoint").map_err(storage)?,
        has_token,
        account: store
            .setting("vibeq.account")
            .map_err(storage)?
            .filter(|name| has_token && !name.is_empty()),
        token_from_environment: std::env::var(TOKEN_ENV).is_ok_and(|t| !t.trim().is_empty()),
        secret_store: secrets::status(),
    })
}

fn saved_token() -> Result<Option<String>, ProtocolError> {
    match std::env::var(TOKEN_ENV) {
        Ok(token) if !token.trim().is_empty() => Ok(Some(token.trim().into())),
        _ => secrets::get(TOKEN_ACCOUNT).map_err(storage),
    }
}

/// A screenshot of a 4K display at 2x is about 10 MiB of PNG; the request limit leaves room for base64.
const MAX_SCREENSHOT_BYTES: usize = 12 * 1024 * 1024;

/// Returns `Ok(())` at once when another daemon already holds the lock: the caller then connects to it.
/// Appends one line to `lensd.log`; the daemon has no terminal once a service or browser starts it.
pub fn log(paths: &Paths, line: &str) {
    use std::io::Write;
    if let Ok(mut file) = paths.log("lensd.log") {
        let _ = writeln!(
            file,
            "{} pid {}: {line}",
            now_ms() / 1000,
            std::process::id()
        );
    }
}

/// `service`: started by the login service, so refresh the browser registrations first. A browser
/// installed after Lens, or a binary that moved, is then fixed at the next login.
pub fn run(paths: &Paths, service: bool) -> std::io::Result<()> {
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
    if service {
        match std::env::current_exe().and_then(|exe| crate::register::register(paths, &exe)) {
            Ok(_) => {}
            Err(e) => log(paths, &format!("registration refresh failed: {e}")),
        }
    }
    log(
        paths,
        &format!("started, version {}", env!("CARGO_PKG_VERSION")),
    );
    let store = Store::open(&paths.database()).map_err(std::io::Error::other)?;
    let daemon = Arc::new(Daemon::new(store, paths));
    crate::update::clean_up();
    if service {
        schedule_updates(daemon.clone());
        crate::tray::spawn(paths);
    }
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
                let paths = paths.clone();
                std::thread::spawn(move || {
                    if let Err(e) = serve(&daemon, stream) {
                        log(&paths, &format!("connection ended: {e}"));
                    }
                });
            }
            Err(e) => log(paths, &format!("accept failed: {e}")),
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
            downloads: paths.downloads(),
            filings: paths.filings(),
            notebook: paths.data.clone(),
            paths: paths.clone(),
        }
    }

    fn handle(&self, request: Request) -> Outcome {
        match self.reply(request) {
            Ok(result) => Outcome::Ok {
                result: Box::new(result),
            },
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
                paused: store
                    .setting("collection.paused")
                    .map_err(storage)?
                    .as_deref()
                    == Some("true"),
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
                let mut capture = capture;
                capture.evidence.actions.truncate(repro::MAX_ACTIONS);
                capture.evidence.elements.truncate(repro::MAX_ELEMENTS);
                let evidence = serde_json::to_vec(&capture.evidence).expect("evidence serializes");
                let recording = match &capture.recording {
                    Some(events) if !events.is_empty() => {
                        let bytes = serde_json::to_vec(events).expect("events serialize");
                        Some(
                            self.blobs
                                .put(&bytes, "application/json")
                                .map_err(storage)?,
                        )
                    }
                    _ => None,
                };
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
                    recording,
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
            Request::CreateReview(request) => {
                if !request.screenshots_checked {
                    return Err(bad(
                        "confirm that you checked every screenshot for private data",
                    ));
                }
                let mut ids = request.captures.clone();
                ids.sort_unstable();
                ids.dedup();
                if ids.is_empty() || ids.len() > 50 {
                    return Err(bad("choose between 1 and 50 captures"));
                }
                let observation = store
                    .get_observation(request.observation)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such observation"))?;
                if observation.revision != request.revision {
                    return Err(ProtocolError::new(
                        ErrorCode::Conflict,
                        "the notes changed after you reviewed them; review again",
                    ));
                }
                let mut items = Vec::new();
                for id in &request.captures {
                    let capture = store
                        .get_capture(*id)
                        .map_err(storage)?
                        .filter(|c| c.observation == observation.id)
                        .ok_or_else(|| {
                            not_found(format!("capture {id} is not in this observation"))
                        })?;
                    let original = self
                        .blobs
                        .read_all(&capture.screenshot.sha256)
                        .map_err(storage)?;
                    let rendered =
                        render::render(&original, &capture.annotations).map_err(storage)?;
                    let evidence = self
                        .blobs
                        .read_all(&capture.evidence.sha256)
                        .map_err(storage)?;
                    let parsed = repro::parse(&evidence)
                        .ok_or_else(|| storage("the capture's evidence is not readable"))?;
                    let marks = repro::mark_targets(
                        &capture.annotations,
                        &parsed.elements,
                        repro::scale(&original, &parsed),
                    );
                    let shared = repro::for_review(parsed, request.typed_values);
                    let shared = serde_json::to_vec(&shared).expect("evidence serializes");
                    items.push(ReviewItem {
                        capture: capture.id,
                        page_url: capture.page_url,
                        page_title: capture.page_title,
                        mode: capture.mode,
                        screenshot: self.blobs.put(&rendered, "image/png").map_err(storage)?,
                        evidence: self
                            .blobs
                            .put(&shared, "application/json")
                            .map_err(storage)?,
                        recording: capture
                            .recording
                            .filter(|_| request.recordings.contains(id)),
                        findings: export::findings(
                            &serde_json::from_slice(&shared).unwrap_or_default(),
                        ),
                        marks,
                    });
                }
                Reply::Review(
                    store
                        .create_review(Review {
                            id: 0,
                            observation: observation.id,
                            revision: observation.revision,
                            created_at: now_ms(),
                            title: observation.title,
                            notes: observation.notes,
                            items,
                        })
                        .map_err(storage)?,
                )
            }
            Request::Announce(client) => {
                if client.profile.is_empty() || client.profile.len() > 64 {
                    return Err(bad("the profile ID must be 1 to 64 characters"));
                }
                store.save_client(&client, now_ms()).map_err(storage)?;
                Reply::Done
            }
            Request::SetupStatus => {
                let executable = std::env::current_exe().map_err(storage)?;
                let service = match crate::service::state(&self.paths) {
                    crate::service::State::Installed { manager } => Some(manager.to_string()),
                    crate::service::State::NotInstalled => None,
                };
                let mut status = SetupStatus {
                    version: env!("CARGO_PKG_VERSION").into(),
                    protocol: PROTOCOL_VERSION,
                    binary: executable.display().to_string(),
                    service,
                    browsers: crate::register::check(&self.paths, &executable),
                    extensions: store.list_clients().map_err(storage)?,
                    projects: store.count("projects").map_err(storage)?,
                    captures: store.count("captures").map_err(storage)?,
                    vibeq_configured: store.setting("vibeq.endpoint").map_err(storage)?.is_some(),
                    steps: Vec::new(),
                };
                status.steps = crate::setup::steps(&status, &self.paths);
                Reply::Setup(Box::new(status))
            }
            Request::SetPaused { paused } => {
                store
                    .set_setting("collection.paused", if paused { "true" } else { "false" })
                    .map_err(storage)?;
                Reply::Done
            }
            Request::GetUpdates => Reply::Updates(self.update_state(&store)?),
            Request::SetAutomaticUpdates { enabled } => {
                store
                    .set_setting("update.automatic", if enabled { "true" } else { "false" })
                    .map_err(storage)?;
                Reply::Updates(self.update_state(&store)?)
            }
            Request::UpdateNow => {
                drop(store);
                self.update(true)?;
                Reply::Updates(self.update_state(&self.lock_store())?)
            }
            Request::ListAgents => {
                drop(store);
                Reply::Agents(
                    [investigate::Agent::Codex, investigate::Agent::Claude]
                        .into_iter()
                        .map(|agent| investigate::AgentInfo {
                            agent,
                            state: investigate::status(agent),
                        })
                        .collect(),
                )
            }
            Request::Investigate { review, agent } => {
                let review = store
                    .get_review(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such review"))?;
                drop(store);
                Reply::Suggestion(
                    investigate::investigate(agent, &review, &self.blobs, &self.notebook)
                        .map_err(remote)?,
                )
            }
            Request::ListReviews => Reply::Reviews(store.list_reviews().map_err(storage)?),
            Request::GetReview { review } => Reply::Review(
                store
                    .get_review(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such review"))?,
            ),
            Request::ExportReview { review } => {
                let review = store
                    .get_review(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such review"))?;
                drop(store);
                let folder =
                    export::export(&review, &self.blobs, &self.downloads).map_err(storage)?;
                Reply::Exported(Exported {
                    folder: folder.display().to_string(),
                })
            }
            Request::GetVibeQ => Reply::VibeQ(vibeq_settings(&store)?),
            Request::SetVibeQ(input) => {
                drop(store);
                let endpoint = vibeq::validate_endpoint(&input.endpoint).map_err(bad)?;
                let account = match input.token.as_deref().map(str::trim) {
                    None => None,
                    Some("") => {
                        secrets::delete(TOKEN_ACCOUNT).map_err(storage)?;
                        Some(String::new())
                    }
                    Some(token) => {
                        // A token that VibeQ does not accept is never saved.
                        let me = Client::new(endpoint.as_str(), token)
                            .map_err(bad)?
                            .me()
                            .map_err(remote)?;
                        // LENS_VIBEQ_TOKEN wins over a saved token, so there is nothing to save.
                        if std::env::var(TOKEN_ENV).is_ok_and(|t| !t.trim().is_empty()) {
                            if saved_token()?.as_deref() != Some(token) {
                                return Err(bad(
                                    "LENS_VIBEQ_TOKEN is set and overrides this token",
                                ));
                            }
                        } else {
                            secrets::set(TOKEN_ACCOUNT, token).map_err(storage)?;
                        }
                        Some(me.name)
                    }
                };
                let store = self.lock_store();
                let endpoint = endpoint.as_str().trim_end_matches('/');
                store
                    .set_setting("vibeq.endpoint", endpoint)
                    .map_err(storage)?;
                if let Some(account) = account {
                    store
                        .set_setting("vibeq.account", &account)
                        .map_err(storage)?;
                }
                Reply::VibeQ(vibeq_settings(&store)?)
            }
            Request::ListMembers => {
                drop(store);
                Reply::Members(self.vibeq_client()?.members().map_err(remote)?)
            }
            Request::GetFiling { review } => {
                let attempt = store
                    .filing(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("this review was not filed"))?;
                Reply::Filing(filing_reply(&attempt))
            }
            Request::FileReview { review, assignee } => {
                let found = store
                    .get_review(review)
                    .map_err(storage)?
                    .ok_or_else(|| not_found("no such review"))?;
                let existing = store.filing(review).map_err(storage)?;
                let filed = store.filed_revision(found.observation).map_err(storage)?;
                let install = self.install_id(&store)?;
                let project =
                    project_for(&store, found.items.first().map(|i| i.page_url.as_str()))?;
                drop(store);
                let client = self.vibeq_client()?;
                let mut attempt = match existing {
                    Some(attempt) => attempt,
                    None => {
                        if filed.is_some_and(|r| r > u64::from(found.revision)) {
                            return Err(ProtocolError::new(
                                ErrorCode::Conflict,
                                "this revision is already filed; edit the notes and review again to file an amendment",
                            ));
                        }
                        let attempt = filing::prepare(
                            &found,
                            &self.blobs,
                            &self.filings,
                            &client.endpoint(),
                            install,
                            project,
                            assignee,
                        )
                        .map_err(bad)?;
                        self.lock_store().save_filing(&attempt).map_err(storage)?;
                        attempt
                    }
                };
                let delivered = filing::deliver(&mut attempt, &client, |a| {
                    self.lock_store().save_filing(a).map_err(|e| e.to_string())
                });
                delivered.map_err(remote)?;
                Reply::Filing(filing_reply(&attempt))
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

impl Daemon {
    fn update_state(&self, store: &Store) -> Result<UpdateState, ProtocolError> {
        let executable = std::env::current_exe().map_err(storage)?;
        Ok(UpdateState {
            current: env!("CARGO_PKG_VERSION").into(),
            available: store.setting("update.available").map_err(storage)?,
            checked_at: store
                .setting("update.checked_at")
                .map_err(storage)?
                .and_then(|t| t.parse().ok()),
            automatic: store
                .setting("update.automatic")
                .map_err(storage)?
                .as_deref()
                != Some("false"),
            managed_by: crate::update::managed_by(&executable).map(String::from),
            last_error: store
                .setting("update.error")
                .map_err(storage)?
                .filter(|e| !e.is_empty()),
        })
    }

    /// Checks the signed feed; with `install`, installs a newer release and restarts Lens.
    pub fn update(&self, install: bool) -> Result<(), ProtocolError> {
        let found = crate::update::check();
        let store = self.lock_store();
        store
            .set_setting("update.checked_at", &now_ms().to_string())
            .map_err(storage)?;
        let manifest = match found {
            Ok(manifest) => manifest,
            Err(e) => {
                store.set_setting("update.error", &e).map_err(storage)?;
                return Err(remote(e));
            }
        };
        store.set_setting("update.error", "").map_err(storage)?;
        let Some(manifest) = manifest else {
            store.set_setting("update.available", "").map_err(storage)?;
            return Ok(());
        };
        store
            .set_setting("update.available", &manifest.version)
            .map_err(storage)?;
        drop(store);
        if !install {
            return Ok(());
        }
        log(
            &self.paths,
            &format!("installing update {}", manifest.version),
        );
        if let Err(e) = crate::update::install(&self.paths, &manifest) {
            let _ = self.lock_store().set_setting("update.error", &e);
            return Err(remote(e));
        }
        restart_soon(&self.paths);
        Ok(())
    }

    fn lock_store(&self) -> std::sync::MutexGuard<'_, Store> {
        self.store
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    fn vibeq_client(&self) -> Result<Client, ProtocolError> {
        let endpoint = self
            .lock_store()
            .setting("vibeq.endpoint")
            .map_err(storage)?
            .ok_or_else(|| bad("add the VibeQ address in Settings first"))?;
        let token = saved_token()?.ok_or_else(|| bad("sign in to VibeQ in Settings first"))?;
        Client::new(&endpoint, &token).map_err(bad)
    }

    /// A random ID made once per notebook; VibeQ observation IDs derive from it, so two notebooks
    /// never claim the same observation.
    fn install_id(&self, store: &Store) -> Result<uuid::Uuid, ProtocolError> {
        if let Some(id) = store.setting("install.id").map_err(storage)?
            && let Ok(id) = uuid::Uuid::parse_str(&id)
        {
            return Ok(id);
        }
        let id = uuid::Uuid::new_v4();
        store
            .set_setting("install.id", &id.to_string())
            .map_err(storage)?;
        Ok(id)
    }
}

/// The Lens project of the review's page, as VibeQ's project key.
fn project_for(store: &Store, page_url: Option<&str>) -> Result<String, ProtocolError> {
    let origin = page_url
        .and_then(|u| url::Url::parse(u).ok())
        .map(|u| u.origin().ascii_serialization());
    let projects = store.list_projects().map_err(storage)?;
    Ok(projects
        .iter()
        .find(|p| origin.as_ref().is_some_and(|o| p.origins.contains(o)))
        .map(|p| format!("lens-project-{}", p.id))
        .unwrap_or_else(|| "lens".into()))
}

/// Starts `lens restart` from the new binary, detached; it stops this daemon after the reply is out
/// and starts the new one through the service manager.
fn restart_soon(paths: &Paths) {
    let Ok(executable) = std::env::current_exe() else {
        return;
    };
    let mut command = std::process::Command::new(executable);
    command
        .args(["restart", "--after", "2"])
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0000_0008 | 0x0800_0000); // DETACHED_PROCESS | CREATE_NO_WINDOW
    }
    if let Err(e) = command.spawn() {
        log(paths, &format!("cannot restart after the update: {e}"));
    }
}

/// Checks for updates an hour after start and then daily; installs them when the person allows it.
fn schedule_updates(daemon: Arc<Daemon>) {
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(3600));
        loop {
            let executable = std::env::current_exe();
            let managed = executable
                .as_deref()
                .ok()
                .and_then(crate::update::managed_by);
            if managed.is_none() {
                let automatic = daemon
                    .lock_store()
                    .setting("update.automatic")
                    .ok()
                    .flatten()
                    .as_deref()
                    != Some("false");
                if let Err(e) = daemon.update(automatic) {
                    log(&daemon.paths, &format!("update check: {}", e.message));
                }
            }
            std::thread::sleep(std::time::Duration::from_secs(24 * 3600));
        }
    });
}

fn filing_reply(attempt: &filing::Attempt) -> Filing {
    Filing {
        review: attempt.review,
        task_url: attempt.receipt.as_ref().map(|r| r.task_url.clone()),
        missing_files: attempt
            .receipt
            .as_ref()
            .map_or(attempt.submission.evidence_manifest.len(), |r| {
                r.missing_attachments.len()
            }) as u32,
    }
}

fn remote(message: String) -> ProtocolError {
    ProtocolError::new(ErrorCode::Remote, message)
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
            logs: dir.path().join("logs"),
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
                    "events": [{ "timestamp": 1, "kind": "console", "data": { "level": "error" } }] },
                "recording": [{ "type": 4, "data": { "href": "http://127.0.0.1:4100/cart" }, "timestamp": 1 }]
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
            "evidence": { "mode": "screenshotOnly", "page": null, "gaps": [], "events": [] }, "recording": null } });
        assert_eq!(
            ask(&daemon, &not_png.to_string())["error"]["code"],
            "badRequest"
        );
    }
}
