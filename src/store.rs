use crate::filing::Attempt;
use crate::protocol::{
    BlobRef, Capture, CaptureKind, CaptureMode, ClientInfo, ClientSeen, Edits, Observation,
    ObservationStatus, ObservationSummary, Project, Review, ReviewSummary, Shape, Shot, VoiceNote,
    VoiceSegment, VoiceState,
};
use rusqlite::{Connection, params};
use std::path::Path;

/// Each entry moves the schema one version forward. Append; never edit a shipped entry.
const MIGRATIONS: &[&str] = &[
    "CREATE TABLE observations (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT,
        created_at INTEGER NOT NULL
    );",
    "CREATE TABLE projects (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        origins TEXT NOT NULL,
        enabled INTEGER NOT NULL
    );
    CREATE TABLE captures (
        id INTEGER PRIMARY KEY,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        created_at INTEGER NOT NULL,
        page_url TEXT NOT NULL,
        page_title TEXT NOT NULL,
        mode TEXT NOT NULL,
        screenshot_sha256 TEXT NOT NULL,
        screenshot_size INTEGER NOT NULL,
        evidence_sha256 TEXT NOT NULL,
        evidence_size INTEGER NOT NULL,
        event_count INTEGER NOT NULL,
        gap_count INTEGER NOT NULL
    );
    CREATE INDEX captures_by_observation ON captures(observation_id);",
    "ALTER TABLE captures ADD COLUMN annotations TEXT NOT NULL DEFAULT '[]';",
    "ALTER TABLE observations ADD COLUMN notes TEXT NOT NULL DEFAULT '';
    ALTER TABLE observations ADD COLUMN revision INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE observations ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 0;
    UPDATE observations SET updated_at = created_at;",
    "ALTER TABLE captures ADD COLUMN recording_sha256 TEXT;
    ALTER TABLE captures ADD COLUMN recording_size INTEGER;",
    "CREATE TABLE reviews (
        id INTEGER PRIMARY KEY,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        body TEXT NOT NULL
    );",
    "CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE filings (
        review_id INTEGER PRIMARY KEY REFERENCES reviews(id) ON DELETE CASCADE,
        observation_id INTEGER NOT NULL,
        body TEXT NOT NULL
    );",
    "CREATE TABLE clients (
        profile TEXT PRIMARY KEY,
        body TEXT NOT NULL,
        last_seen INTEGER NOT NULL
    );",
    "CREATE TABLE voice_notes (
        id INTEGER PRIMARY KEY,
        observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
        started_at INTEGER NOT NULL,
        duration_ms INTEGER NOT NULL,
        audio_sha256 TEXT NOT NULL,
        audio_size INTEGER NOT NULL,
        state TEXT NOT NULL,
        language TEXT,
        segments TEXT NOT NULL DEFAULT '[]',
        detail TEXT
    );
    CREATE INDEX voice_notes_by_observation ON voice_notes(observation_id);",
    "ALTER TABLE captures ADD COLUMN kind TEXT NOT NULL DEFAULT 'moment';
    ALTER TABLE captures ADD COLUMN started_at INTEGER NOT NULL DEFAULT 0;
    ALTER TABLE captures ADD COLUMN edits TEXT NOT NULL DEFAULT '{}';",
    "ALTER TABLE captures ADD COLUMN shots TEXT NOT NULL DEFAULT '[]';",
];

/// What an update found.
pub enum Updated {
    Saved(Observation),
    /// Someone saved first; this is their version.
    Conflict(Observation),
    Missing,
}

const OBSERVATION_COLUMNS: &str = "id, title, url, notes, revision, created_at, updated_at";

fn observation_from_row(row: &rusqlite::Row) -> rusqlite::Result<Observation> {
    Ok(Observation {
        id: row.get(0)?,
        title: row.get(1)?,
        url: row.get(2)?,
        notes: row.get(3)?,
        revision: row.get(4)?,
        created_at: row.get(5)?,
        updated_at: row.get(6)?,
    })
}

const CAPTURE_COLUMNS: &str = "id, observation_id, created_at, page_url, page_title, mode,
    screenshot_sha256, screenshot_size, evidence_sha256, evidence_size, event_count, gap_count,
    annotations, recording_sha256, recording_size, kind, started_at, edits, shots";

fn capture_from_row(row: &rusqlite::Row) -> rusqlite::Result<Capture> {
    let mode: String = row.get(5)?;
    let annotations: String = row.get(12)?;
    let kind: String = row.get(15)?;
    let edits: String = row.get(17)?;
    Ok(Capture {
        id: row.get(0)?,
        observation: row.get(1)?,
        created_at: row.get(2)?,
        page_url: row.get(3)?,
        page_title: row.get(4)?,
        mode: mode_from(&mode),
        screenshot: BlobRef {
            sha256: row.get(6)?,
            size: row.get::<_, i64>(7)? as u64,
            media_type: "image/png".into(),
        },
        evidence: BlobRef {
            sha256: row.get(8)?,
            size: row.get::<_, i64>(9)? as u64,
            media_type: "application/json".into(),
        },
        event_count: row.get(10)?,
        gap_count: row.get(11)?,
        annotations: serde_json::from_str(&annotations).unwrap_or_default(),
        recording: match (
            row.get::<_, Option<String>>(13)?,
            row.get::<_, Option<i64>>(14)?,
        ) {
            (Some(sha256), Some(size)) => Some(BlobRef {
                sha256,
                size: size as u64,
                media_type: "application/json".into(),
            }),
            _ => None,
        },
        kind: if kind == "session" {
            CaptureKind::Session
        } else {
            CaptureKind::Moment
        },
        started_at: row.get(16)?,
        edits: serde_json::from_str(&edits).unwrap_or_default(),
        shots: serde_json::from_str(&row.get::<_, String>(18)?).unwrap_or_default(),
    })
}

/// The first finding, else the first line of the notes, for a list row.
fn headline(notes: &str) -> Option<String> {
    let line = notes
        .lines()
        .map(str::trim)
        .find(|l| !l.is_empty() && !l.starts_with("Findings"))?
        .trim_start_matches(['-', '*', ' '])
        .trim();
    (!line.is_empty()).then(|| line.chars().take(140).collect())
}

const VOICE_COLUMNS: &str = "id, observation_id, started_at, duration_ms, audio_sha256, audio_size,
    state, language, segments, detail";

fn voice_from_row(row: &rusqlite::Row) -> rusqlite::Result<VoiceNote> {
    let state: String = row.get(6)?;
    let segments: String = row.get(8)?;
    Ok(VoiceNote {
        id: row.get(0)?,
        observation: row.get(1)?,
        started_at: row.get(2)?,
        duration_ms: row.get(3)?,
        audio: BlobRef {
            sha256: row.get(4)?,
            size: row.get::<_, i64>(5)? as u64,
            media_type: "audio/wav".into(),
        },
        state: match state.as_str() {
            "transcribing" => VoiceState::Transcribing,
            "done" => VoiceState::Done,
            "failed" => VoiceState::Failed,
            _ => VoiceState::Waiting,
        },
        language: row.get(7)?,
        segments: serde_json::from_str(&segments).unwrap_or_default(),
        detail: row.get(9)?,
    })
}

/// A capture's row before it has an ID and an observation.
pub struct CaptureRow {
    pub created_at: i64,
    pub page_url: String,
    pub page_title: String,
    pub mode: CaptureMode,
    pub screenshot: BlobRef,
    pub evidence: BlobRef,
    pub event_count: u32,
    pub gap_count: u32,
    pub recording: Option<BlobRef>,
    pub kind: CaptureKind,
    pub started_at: i64,
    pub shots: Vec<Shot>,
}

fn mode_name(mode: CaptureMode) -> &'static str {
    match mode {
        CaptureMode::Deep => "deep",
        CaptureMode::Limited => "limited",
        CaptureMode::ScreenshotOnly => "screenshotOnly",
    }
}

fn mode_from(name: &str) -> CaptureMode {
    match name {
        "deep" => CaptureMode::Deep,
        "limited" => CaptureMode::Limited,
        _ => CaptureMode::ScreenshotOnly,
    }
}

pub struct Store {
    db: Connection,
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.pragma_update(None, "journal_mode", "WAL")?;
        db.pragma_update(None, "foreign_keys", "ON")?;
        let mut store = Self { db };
        store.migrate()?;
        Ok(store)
    }

    fn migrate(&mut self) -> rusqlite::Result<()> {
        let current: i64 = self
            .db
            .pragma_query_value(None, "user_version", |row| row.get(0))?;
        let current = usize::try_from(current).unwrap_or(usize::MAX);
        if current > MIGRATIONS.len() {
            return Err(rusqlite::Error::InvalidParameterName(format!(
                "the notebook uses schema {current}, newer than this Lens ({}); update Lens",
                MIGRATIONS.len()
            )));
        }
        for (index, sql) in MIGRATIONS.iter().enumerate().skip(current) {
            let tx = self.db.transaction()?;
            tx.execute_batch(sql)?;
            tx.pragma_update(None, "user_version", index as i64 + 1)?;
            tx.commit()?;
        }
        Ok(())
    }

    pub fn create_observation(
        &self,
        title: &str,
        url: Option<&str>,
        created_at: i64,
    ) -> rusqlite::Result<Observation> {
        self.db.execute(
            "INSERT INTO observations (title, url, created_at, updated_at) VALUES (?1, ?2, ?3, ?3)",
            params![title, url, created_at],
        )?;
        Ok(self
            .get_observation(self.db.last_insert_rowid())?
            .expect("the row was just inserted"))
    }

    pub fn get_observation(&self, id: i64) -> rusqlite::Result<Option<Observation>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {OBSERVATION_COLUMNS} FROM observations WHERE id = ?1"
        ))?;
        statement
            .query_map([id], observation_from_row)?
            .next()
            .transpose()
    }

    // ponytail: the whole list in one reply; page it when a notebook nears 5000 observations
    // (about 1 MiB of summaries).
    pub fn list_observations(&self) -> rusqlite::Result<Vec<ObservationSummary>> {
        let mut statement = self.db.prepare(
            "SELECT o.id, o.title, o.url, o.created_at, o.updated_at,
                (SELECT COUNT(*) FROM captures c WHERE c.observation_id = o.id),
                EXISTS (SELECT 1 FROM captures c WHERE c.observation_id = o.id AND c.kind = 'session'),
                (SELECT COALESCE(SUM(c.created_at - c.started_at), 0) FROM captures c
                    WHERE c.observation_id = o.id AND c.started_at > 0),
                (SELECT COUNT(*) FROM voice_notes v WHERE v.observation_id = o.id),
                EXISTS (SELECT 1 FROM filings f WHERE f.observation_id = o.id
                    AND json_extract(f.body, '$.receipt') IS NOT NULL),
                EXISTS (SELECT 1 FROM reviews r WHERE r.observation_id = o.id),
                (SELECT c.screenshot_sha256 FROM captures c WHERE c.observation_id = o.id ORDER BY c.id DESC LIMIT 1),
                (SELECT c.screenshot_size FROM captures c WHERE c.observation_id = o.id ORDER BY c.id DESC LIMIT 1),
                o.notes
             FROM observations o ORDER BY o.created_at DESC, o.id DESC",
        )?;
        statement
            .query_map([], |row| {
                let sha: Option<String> = row.get(11)?;
                let size: Option<i64> = row.get(12)?;
                let notes: String = row.get(13)?;
                Ok(ObservationSummary {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    url: row.get(2)?,
                    created_at: row.get(3)?,
                    updated_at: row.get(4)?,
                    capture_count: row.get(5)?,
                    kind: if row.get::<_, bool>(6)? {
                        CaptureKind::Session
                    } else {
                        CaptureKind::Moment
                    },
                    duration_ms: row.get(7)?,
                    voice_count: row.get(8)?,
                    status: if row.get::<_, bool>(9)? {
                        ObservationStatus::Filed
                    } else if row.get::<_, bool>(10)? {
                        ObservationStatus::Reviewed
                    } else {
                        ObservationStatus::Draft
                    },
                    thumbnail: sha.zip(size).map(|(sha256, size)| BlobRef {
                        sha256,
                        size: size as u64,
                        media_type: "image/png".into(),
                    }),
                    headline: headline(&notes),
                })
            })?
            .collect()
    }

    /// Deletes an observation; captures, voice notes and reviews go with it. Returns false when
    /// there is none. Blobs stay: other records may share them.
    pub fn delete_observation(&self, id: i64) -> rusqlite::Result<bool> {
        self.db
            .execute("DELETE FROM filings WHERE observation_id = ?1", [id])?;
        Ok(self
            .db
            .execute("DELETE FROM observations WHERE id = ?1", [id])?
            > 0)
    }

    pub fn update_observation(
        &self,
        id: i64,
        revision: u32,
        title: &str,
        notes: &str,
        now: i64,
    ) -> rusqlite::Result<Updated> {
        let changed = self.db.execute(
            "UPDATE observations SET title = ?3, notes = ?4, revision = revision + 1, updated_at = ?5
             WHERE id = ?1 AND revision = ?2",
            params![id, revision, title, notes, now],
        )?;
        Ok(match (changed, self.get_observation(id)?) {
            (1, Some(saved)) => Updated::Saved(saved),
            (_, Some(current)) => Updated::Conflict(current),
            (_, None) => Updated::Missing,
        })
    }

    /// Stores a review; `review.id` is replaced by the new row's ID.
    pub fn create_review(&self, mut review: Review) -> rusqlite::Result<Review> {
        self.db.execute(
            "INSERT INTO reviews (observation_id, body) VALUES (?1, '')",
            [review.observation],
        )?;
        review.id = self.db.last_insert_rowid();
        let body = serde_json::to_string(&review).expect("reviews serialize");
        self.db.execute(
            "UPDATE reviews SET body = ?2 WHERE id = ?1",
            params![review.id, body],
        )?;
        Ok(review)
    }

    pub fn get_review(&self, id: i64) -> rusqlite::Result<Option<Review>> {
        let mut statement = self.db.prepare("SELECT body FROM reviews WHERE id = ?1")?;
        let mut rows = statement.query_map([id], |row| row.get::<_, String>(0))?;
        Ok(match rows.next().transpose()? {
            Some(body) => serde_json::from_str(&body).ok(),
            None => None,
        })
    }

    pub fn list_reviews(&self) -> rusqlite::Result<Vec<ReviewSummary>> {
        let mut statement = self
            .db
            .prepare("SELECT body FROM reviews ORDER BY id DESC")?;
        let bodies = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut reviews = Vec::new();
        for body in bodies {
            if let Ok(review) = serde_json::from_str::<Review>(&body?) {
                reviews.push(ReviewSummary {
                    id: review.id,
                    observation: review.observation,
                    revision: review.revision,
                    created_at: review.created_at,
                    title: review.title,
                    captures: review.items.len() as u32,
                });
            }
        }
        Ok(reviews)
    }

    pub fn save_client(&self, client: &ClientInfo, now: i64) -> rusqlite::Result<()> {
        let body = serde_json::to_string(client).expect("clients serialize");
        self.db.execute(
            "INSERT INTO clients (profile, body, last_seen) VALUES (?1, ?2, ?3)
             ON CONFLICT(profile) DO UPDATE SET body = excluded.body, last_seen = excluded.last_seen",
            params![client.profile, body, now],
        )?;
        Ok(())
    }

    pub fn list_clients(&self) -> rusqlite::Result<Vec<ClientSeen>> {
        let mut statement = self
            .db
            .prepare("SELECT body, last_seen FROM clients ORDER BY last_seen DESC")?;
        let rows = statement.query_map([], |row| Ok((row.get::<_, String>(0)?, row.get(1)?)))?;
        let mut clients = Vec::new();
        for row in rows {
            let (body, last_seen) = row?;
            if let Ok(client) = serde_json::from_str(&body) {
                clients.push(ClientSeen { client, last_seen });
            }
        }
        Ok(clients)
    }

    pub fn count(&self, table: &str) -> rusqlite::Result<u32> {
        // `table` is one of this file's own names, never input.
        self.db
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
    }

    pub fn setting(&self, key: &str) -> rusqlite::Result<Option<String>> {
        let mut statement = self
            .db
            .prepare("SELECT value FROM settings WHERE key = ?1")?;
        statement
            .query_map([key], |row| row.get(0))?
            .next()
            .transpose()
    }

    pub fn set_setting(&self, key: &str, value: &str) -> rusqlite::Result<()> {
        self.db.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, value],
        )?;
        Ok(())
    }

    pub fn filing(&self, review: i64) -> rusqlite::Result<Option<Attempt>> {
        let mut statement = self
            .db
            .prepare("SELECT body FROM filings WHERE review_id = ?1")?;
        let body: Option<String> = statement
            .query_map([review], |row| row.get(0))?
            .next()
            .transpose()?;
        Ok(body.and_then(|b| serde_json::from_str(&b).ok()))
    }

    pub fn save_filing(&self, attempt: &Attempt) -> rusqlite::Result<()> {
        let body = serde_json::to_string(attempt).expect("attempts serialize");
        self.db.execute(
            "INSERT INTO filings (review_id, observation_id, body) VALUES (?1, ?2, ?3)
             ON CONFLICT(review_id) DO UPDATE SET body = excluded.body",
            params![attempt.review, attempt.observation, body],
        )?;
        Ok(())
    }

    /// The highest VibeQ revision this observation has a filing for, finished or not.
    pub fn filed_revision(&self, observation: i64) -> rusqlite::Result<Option<u64>> {
        let mut statement = self
            .db
            .prepare("SELECT body FROM filings WHERE observation_id = ?1")?;
        let bodies = statement.query_map([observation], |row| row.get::<_, String>(0))?;
        let mut highest = None;
        for body in bodies {
            if let Ok(attempt) = serde_json::from_str::<Attempt>(&body?) {
                highest = highest.max(Some(attempt.submission.revision));
            }
        }
        Ok(highest)
    }

    pub fn list_projects(&self) -> rusqlite::Result<Vec<Project>> {
        let mut statement = self
            .db
            .prepare("SELECT id, name, origins, enabled FROM projects ORDER BY name, id")?;
        statement
            .query_map([], |row| {
                let origins: String = row.get(2)?;
                Ok(Project {
                    id: row.get(0)?,
                    name: row.get(1)?,
                    origins: serde_json::from_str(&origins).unwrap_or_default(),
                    enabled: row.get(3)?,
                })
            })?
            .collect()
    }

    /// Inserts when `id` is None. Returns None when the given `id` does not exist.
    pub fn save_project(
        &self,
        id: Option<i64>,
        name: &str,
        origins: &[String],
        enabled: bool,
    ) -> rusqlite::Result<Option<Project>> {
        let encoded = serde_json::to_string(origins).expect("strings serialize");
        let id = match id {
            None => {
                self.db.execute(
                    "INSERT INTO projects (name, origins, enabled) VALUES (?1, ?2, ?3)",
                    params![name, encoded, enabled],
                )?;
                self.db.last_insert_rowid()
            }
            Some(id) => {
                let changed = self.db.execute(
                    "UPDATE projects SET name = ?2, origins = ?3, enabled = ?4 WHERE id = ?1",
                    params![id, name, encoded, enabled],
                )?;
                if changed == 0 {
                    return Ok(None);
                }
                id
            }
        };
        Ok(Some(Project {
            id,
            name: name.into(),
            origins: origins.to_vec(),
            enabled,
        }))
    }

    pub fn delete_project(&self, id: i64) -> rusqlite::Result<bool> {
        Ok(self
            .db
            .execute("DELETE FROM projects WHERE id = ?1", [id])?
            > 0)
    }

    /// Adds the capture to `observation`, or to a new observation titled after the page.
    /// Returns None when `observation` does not exist.
    pub fn create_capture(
        &mut self,
        observation: Option<i64>,
        row: CaptureRow,
    ) -> rusqlite::Result<Option<Capture>> {
        let tx = self.db.transaction()?;
        let observation = match observation {
            Some(id) => {
                let exists = tx
                    .prepare("SELECT 1 FROM observations WHERE id = ?1")?
                    .exists([id])?;
                if !exists {
                    return Ok(None);
                }
                id
            }
            None => {
                let title = match row.page_title.trim() {
                    "" => row.page_url.as_str(),
                    title => title,
                };
                tx.execute(
                    "INSERT INTO observations (title, url, created_at) VALUES (?1, ?2, ?3)",
                    params![title, row.page_url, row.created_at],
                )?;
                tx.last_insert_rowid()
            }
        };
        tx.execute(
            "INSERT INTO captures (observation_id, created_at, page_url, page_title, mode,
                screenshot_sha256, screenshot_size, evidence_sha256, evidence_size, event_count, gap_count,
                recording_sha256, recording_size, kind, started_at, shots)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)",
            params![
                observation,
                row.created_at,
                row.page_url,
                row.page_title,
                mode_name(row.mode),
                row.screenshot.sha256,
                row.screenshot.size as i64,
                row.evidence.sha256,
                row.evidence.size as i64,
                row.event_count,
                row.gap_count,
                row.recording.as_ref().map(|r| r.sha256.clone()),
                row.recording.as_ref().map(|r| r.size as i64),
                match row.kind {
                    CaptureKind::Moment => "moment",
                    CaptureKind::Session => "session",
                },
                row.started_at,
                serde_json::to_string(&row.shots).expect("shots serialize")
            ],
        )?;
        let id = tx.last_insert_rowid();
        tx.execute(
            "UPDATE observations SET updated_at = ?2 WHERE id = ?1",
            params![observation, row.created_at],
        )?;
        tx.commit()?;
        Ok(Some(Capture {
            id,
            observation,
            created_at: row.created_at,
            page_url: row.page_url,
            page_title: row.page_title,
            mode: row.mode,
            screenshot: row.screenshot,
            evidence: row.evidence,
            event_count: row.event_count,
            gap_count: row.gap_count,
            annotations: Vec::new(),
            recording: row.recording,
            kind: row.kind,
            started_at: row.started_at,
            edits: Edits::default(),
            shots: row.shots,
        }))
    }

    pub fn add_voice_note(
        &self,
        observation: i64,
        started_at: i64,
        duration_ms: i64,
        audio: &BlobRef,
    ) -> rusqlite::Result<VoiceNote> {
        self.db.execute(
            "INSERT INTO voice_notes (observation_id, started_at, duration_ms, audio_sha256, audio_size, state)
             VALUES (?1, ?2, ?3, ?4, ?5, 'waiting')",
            params![observation, started_at, duration_ms, audio.sha256, audio.size as i64],
        )?;
        let id = self.db.last_insert_rowid();
        Ok(self.get_voice_note(id)?.expect("just inserted"))
    }

    pub fn get_voice_note(&self, id: i64) -> rusqlite::Result<Option<VoiceNote>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {VOICE_COLUMNS} FROM voice_notes WHERE id = ?1"
        ))?;
        statement
            .query_map([id], voice_from_row)?
            .next()
            .transpose()
    }

    pub fn list_voice_notes(&self, observation: i64) -> rusqlite::Result<Vec<VoiceNote>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {VOICE_COLUMNS} FROM voice_notes WHERE observation_id = ?1 ORDER BY started_at, id"
        ))?;
        statement
            .query_map([observation], voice_from_row)?
            .collect()
    }

    /// Voice notes that still need a transcript, oldest first.
    pub fn untranscribed_voice_notes(&self) -> rusqlite::Result<Vec<i64>> {
        let mut statement = self.db.prepare(
            "SELECT id FROM voice_notes WHERE state IN ('waiting', 'transcribing') ORDER BY id",
        )?;
        statement.query_map([], |row| row.get(0))?.collect()
    }

    pub fn set_voice_state(
        &self,
        id: i64,
        state: VoiceState,
        language: Option<&str>,
        segments: &[VoiceSegment],
        detail: Option<&str>,
    ) -> rusqlite::Result<()> {
        let state = match state {
            VoiceState::Waiting => "waiting",
            VoiceState::Transcribing => "transcribing",
            VoiceState::Done => "done",
            VoiceState::Failed => "failed",
        };
        self.db.execute(
            "UPDATE voice_notes SET state = ?2, language = ?3, segments = ?4, detail = ?5 WHERE id = ?1",
            params![
                id,
                state,
                language,
                serde_json::to_string(segments).expect("segments serialize"),
                detail
            ],
        )?;
        Ok(())
    }

    pub fn delete_voice_note(&self, id: i64) -> rusqlite::Result<bool> {
        Ok(self
            .db
            .execute("DELETE FROM voice_notes WHERE id = ?1", [id])?
            > 0)
    }

    pub fn list_captures(&self, observation: i64) -> rusqlite::Result<Vec<Capture>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {CAPTURE_COLUMNS} FROM captures WHERE observation_id = ?1 ORDER BY created_at, id"
        ))?;
        statement
            .query_map([observation], capture_from_row)?
            .collect()
    }

    pub fn get_capture(&self, id: i64) -> rusqlite::Result<Option<Capture>> {
        let mut statement = self.db.prepare(&format!(
            "SELECT {CAPTURE_COLUMNS} FROM captures WHERE id = ?1"
        ))?;
        let mut rows = statement.query_map([id], capture_from_row)?;
        rows.next().transpose()
    }

    /// Returns false when the capture does not exist.
    pub fn save_edits(&self, capture: i64, edits: &Edits) -> rusqlite::Result<bool> {
        let encoded = serde_json::to_string(edits).expect("edits serialize");
        Ok(self.db.execute(
            "UPDATE captures SET edits = ?2 WHERE id = ?1",
            params![capture, encoded],
        )? > 0)
    }

    /// Returns false when the capture does not exist.
    pub fn save_annotations(&self, capture: i64, shapes: &[Shape]) -> rusqlite::Result<bool> {
        let encoded = serde_json::to_string(shapes).expect("shapes serialize");
        Ok(self.db.execute(
            "UPDATE captures SET annotations = ?2 WHERE id = ?1",
            params![capture, encoded],
        )? > 0)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_once_and_keeps_observations() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lens.sqlite");
        let first = Store::open(&path)
            .unwrap()
            .create_observation("Price shows NaN", Some("https://a.test/"), 5)
            .unwrap();
        let reopened = Store::open(&path).unwrap();
        let listed = reopened.list_observations().unwrap();
        assert_eq!(
            (listed.len(), listed[0].id, listed[0].capture_count),
            (1, first.id, 0)
        );
    }

    #[test]
    fn captures_start_or_join_observations() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let blob = |sha: char| BlobRef {
            sha256: sha.to_string().repeat(64),
            size: 3,
            media_type: String::new(),
        };
        let row = |title: &str| CaptureRow {
            created_at: 10,
            page_url: "https://shop.test/cart".into(),
            page_title: title.into(),
            mode: CaptureMode::Deep,
            screenshot: blob('a'),
            evidence: blob('b'),
            event_count: 4,
            gap_count: 1,
            kind: CaptureKind::Moment,
            started_at: 5,
            shots: vec![],
            recording: None,
        };

        let first = store.create_capture(None, row("Cart")).unwrap().unwrap();
        let observations = store.list_observations().unwrap();
        assert_eq!(
            (observations.len(), observations[0].title.as_str()),
            (1, "Cart")
        );

        let second = store
            .create_capture(Some(first.observation), row(""))
            .unwrap()
            .unwrap();
        assert_eq!(store.list_observations().unwrap().len(), 1);
        let captures = store.list_captures(first.observation).unwrap();
        assert_eq!(
            captures.iter().map(|c| c.id).collect::<Vec<_>>(),
            [first.id, second.id]
        );
        assert_eq!(captures[1].mode, CaptureMode::Deep);

        assert!(store.create_capture(Some(999), row("x")).unwrap().is_none());

        let mask = Shape::Mask {
            x: 1.0,
            y: 2.0,
            width: 3.0,
            height: 4.0,
        };
        assert!(
            store
                .save_annotations(first.id, std::slice::from_ref(&mask))
                .unwrap()
        );
        assert_eq!(
            store.get_capture(first.id).unwrap().unwrap().annotations,
            vec![mask]
        );
        assert!(!store.save_annotations(999, &[]).unwrap());
        assert!(store.get_capture(999).unwrap().is_none());
        let untitled = store.create_capture(None, row("  ")).unwrap().unwrap();
        let titles: Vec<_> = store
            .list_observations()
            .unwrap()
            .into_iter()
            .map(|o| (o.id, o.title))
            .collect();
        assert!(titles.contains(&(untitled.observation, "https://shop.test/cart".into())));
    }

    #[test]
    fn updates_need_the_current_revision() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let created = store.create_observation("Cart", None, 1).unwrap();
        assert_eq!(created.revision, 0);

        let Updated::Saved(saved) = store
            .update_observation(created.id, 0, "Cart", "NaN after coupon", 2)
            .unwrap()
        else {
            panic!("the first update must save");
        };
        assert_eq!(
            (saved.revision, saved.notes.as_str(), saved.updated_at),
            (1, "NaN after coupon", 2)
        );

        // A second window still holds revision 0: it must not overwrite the first.
        let Updated::Conflict(current) = store
            .update_observation(created.id, 0, "Cart", "stale", 3)
            .unwrap()
        else {
            panic!("a stale revision must conflict");
        };
        assert_eq!(current.notes, "NaN after coupon");
        assert!(matches!(
            store.update_observation(999, 0, "x", "", 4).unwrap(),
            Updated::Missing
        ));
    }

    #[test]
    fn projects_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::open(&dir.path().join("lens.sqlite")).unwrap();
        let origins = vec!["https://shop.test".to_string()];
        let created = store
            .save_project(None, "Shop", &origins, true)
            .unwrap()
            .unwrap();
        let renamed = store
            .save_project(Some(created.id), "Shop 2", &origins, false)
            .unwrap()
            .unwrap();
        assert_eq!(store.list_projects().unwrap(), vec![renamed]);
        assert!(
            store
                .save_project(Some(999), "x", &origins, true)
                .unwrap()
                .is_none()
        );
        assert!(store.delete_project(created.id).unwrap());
        assert!(store.list_projects().unwrap().is_empty());
    }

    #[test]
    fn refuses_a_newer_schema() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("lens.sqlite");
        Connection::open(&path)
            .unwrap()
            .pragma_update(None, "user_version", 99)
            .unwrap();
        assert!(Store::open(&path).is_err());
    }
}
