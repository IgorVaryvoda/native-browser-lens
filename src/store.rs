use crate::protocol::Observation;
use rusqlite::{Connection, params};
use std::path::Path;

/// Each entry moves the schema one version forward. Append; never edit a shipped entry.
const MIGRATIONS: &[&str] = &["CREATE TABLE observations (
        id INTEGER PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT,
        created_at INTEGER NOT NULL
    );"];

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
            "INSERT INTO observations (title, url, created_at) VALUES (?1, ?2, ?3)",
            params![title, url, created_at],
        )?;
        Ok(Observation {
            id: self.db.last_insert_rowid(),
            title: title.into(),
            url: url.map(Into::into),
            created_at,
        })
    }

    pub fn list_observations(&self) -> rusqlite::Result<Vec<Observation>> {
        let mut statement = self.db.prepare(
            "SELECT id, title, url, created_at FROM observations ORDER BY created_at DESC, id DESC",
        )?;
        statement
            .query_map([], |row| {
                Ok(Observation {
                    id: row.get(0)?,
                    title: row.get(1)?,
                    url: row.get(2)?,
                    created_at: row.get(3)?,
                })
            })?
            .collect()
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
        assert_eq!(reopened.list_observations().unwrap(), vec![first]);
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
