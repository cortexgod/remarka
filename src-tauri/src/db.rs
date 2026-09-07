//! SQLite (rusqlite, bundled) + миграции в коде (§2).

use crate::models::{MeetingCard, MeetingStatus, MeetingType, TypeSource};
use crate::util::now_iso;
use anyhow::{Context, Result};
use rusqlite::{params, Connection, OptionalExtension, Row};
use std::path::Path;

const SCHEMA_VERSION: i64 = 1;

const MIGRATION_1: &str = r#"
CREATE TABLE IF NOT EXISTS meetings (
  id TEXT PRIMARY KEY,
  started_at TEXT NOT NULL,
  duration_sec REAL NOT NULL DEFAULT 0,
  meeting_type TEXT NOT NULL DEFAULT 'other',
  type_source TEXT NOT NULL DEFAULT 'default',
  title TEXT,
  status TEXT NOT NULL,
  has_system_track INTEGER NOT NULL DEFAULT 0,
  training_task_id TEXT,
  score REAL,
  wpm REAL, filled_pauses_per_min REAL, talk_ratio REAL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS meetings_started ON meetings(started_at DESC);
"#;

pub struct Db {
    conn: Connection,
}

#[derive(Debug, Clone)]
pub struct MeetingRow {
    pub id: String,
    pub started_at: String,
    pub duration_sec: f64,
    pub meeting_type: MeetingType,
    pub type_source: TypeSource,
    pub title: Option<String>,
    pub status: MeetingStatus,
    pub has_system_track: bool,
    pub training_task_id: Option<String>,
    pub score: Option<f64>,
    pub wpm: Option<f64>,
    pub filled_pauses_per_min: Option<f64>,
    pub talk_ratio: Option<f64>,
    pub error: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone)]
pub struct NewMeeting {
    pub id: String,
    pub started_at: String,
    pub duration_sec: f64,
    pub meeting_type: MeetingType,
    pub type_source: TypeSource,
    pub title: Option<String>,
    pub status: MeetingStatus,
    pub has_system_track: bool,
    pub training_task_id: Option<String>,
}

/// Денормализованные поля из report.json.
#[derive(Debug, Clone, Default)]
pub struct ReportSummary {
    pub score: Option<f64>,
    pub wpm: Option<f64>,
    pub filled_pauses_per_min: Option<f64>,
    pub talk_ratio: Option<f64>,
    pub duration_sec: Option<f64>,
    /// Тип, определённый LLM (применяется только если в БД type_source = default).
    pub llm_type: Option<MeetingType>,
}

fn row_to_meeting(r: &Row<'_>) -> rusqlite::Result<MeetingRow> {
    let meeting_type: String = r.get("meeting_type")?;
    let type_source: String = r.get("type_source")?;
    let status: String = r.get("status")?;
    let has_system: i64 = r.get("has_system_track")?;
    Ok(MeetingRow {
        id: r.get("id")?,
        started_at: r.get("started_at")?,
        duration_sec: r.get("duration_sec")?,
        meeting_type: MeetingType::parse(&meeting_type).unwrap_or_default(),
        type_source: TypeSource::parse(&type_source).unwrap_or_default(),
        title: r.get("title")?,
        status: MeetingStatus::parse(&status).unwrap_or(MeetingStatus::Error),
        has_system_track: has_system != 0,
        training_task_id: r.get("training_task_id")?,
        score: r.get("score")?,
        wpm: r.get("wpm")?,
        filled_pauses_per_min: r.get("filled_pauses_per_min")?,
        talk_ratio: r.get("talk_ratio")?,
        error: r.get("error")?,
        created_at: r.get("created_at")?,
    })
}

const SELECT: &str = "SELECT id, started_at, duration_sec, meeting_type, type_source, title, status, \
    has_system_track, training_task_id, score, wpm, filled_pauses_per_min, talk_ratio, error, created_at \
    FROM meetings";

impl Db {
    pub fn open(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path)
            .with_context(|| format!("не удалось открыть базу {}", path.display()))?;
        conn.busy_timeout(std::time::Duration::from_secs(5))?;
        conn.pragma_update(None, "journal_mode", "WAL")?;
        conn.pragma_update(None, "synchronous", "NORMAL")?;
        let db = Db { conn };
        db.migrate()?;
        Ok(db)
    }

    pub fn migrate(&self) -> Result<()> {
        let version: i64 = self.conn.query_row("PRAGMA user_version", [], |r| r.get(0))?;
        if version < 1 {
            self.conn.execute_batch(MIGRATION_1)?;
        }
        if version < SCHEMA_VERSION {
            self.conn
                .pragma_update(None, "user_version", SCHEMA_VERSION)?;
        }
        Ok(())
    }

    pub fn insert(&self, m: &NewMeeting) -> Result<()> {
        self.conn.execute(
            "INSERT INTO meetings (id, started_at, duration_sec, meeting_type, type_source, title, status, \
             has_system_track, training_task_id, created_at) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
            params![
                m.id,
                m.started_at,
                m.duration_sec,
                m.meeting_type.as_str(),
                m.type_source.as_str(),
                m.title,
                m.status.as_str(),
                m.has_system_track as i64,
                m.training_task_id,
                now_iso(),
            ],
        )?;
        Ok(())
    }

    pub fn get(&self, id: &str) -> Result<Option<MeetingRow>> {
        let row = self
            .conn
            .query_row(&format!("{SELECT} WHERE id = ?1"), params![id], row_to_meeting)
            .optional()?;
        Ok(row)
    }

    /// Все встречи, started_at DESC.
    pub fn list(&self) -> Result<Vec<MeetingRow>> {
        let mut stmt = self
            .conn
            .prepare(&format!("{SELECT} ORDER BY started_at DESC, created_at DESC"))?;
        let rows = stmt
            .query_map([], row_to_meeting)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    /// Готовые встречи, started_at ASC (для базы и прогресса).
    pub fn ready_rows(&self) -> Result<Vec<MeetingRow>> {
        let mut stmt = self
            .conn
            .prepare(&format!("{SELECT} WHERE status = 'ready' ORDER BY started_at ASC, created_at ASC"))?;
        let rows = stmt
            .query_map([], row_to_meeting)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn count_ready_non_training(&self) -> Result<u32> {
        let n: i64 = self.conn.query_row(
            "SELECT COUNT(*) FROM meetings WHERE status = 'ready' AND meeting_type != 'training'",
            [],
            |r| r.get(0),
        )?;
        Ok(n as u32)
    }

    pub fn set_status(&self, id: &str, status: MeetingStatus, error: Option<&str>) -> Result<()> {
        self.conn.execute(
            "UPDATE meetings SET status = ?2, error = ?3 WHERE id = ?1",
            params![id, status.as_str(), error],
        )?;
        Ok(())
    }

    pub fn set_duration(&self, id: &str, duration_sec: f64) -> Result<()> {
        self.conn.execute(
            "UPDATE meetings SET duration_sec = ?2 WHERE id = ?1",
            params![id, duration_sec],
        )?;
        Ok(())
    }

    pub fn set_has_system_track(&self, id: &str, has: bool) -> Result<()> {
        self.conn.execute(
            "UPDATE meetings SET has_system_track = ?2 WHERE id = ?1",
            params![id, has as i64],
        )?;
        Ok(())
    }

    /// Применяет отчёт: статус ready, денормализованные метрики, тип от LLM (если тип был default).
    pub fn apply_report(&self, id: &str, s: &ReportSummary) -> Result<()> {
        self.conn.execute(
            "UPDATE meetings SET status = 'ready', error = NULL, score = ?2, wpm = ?3, \
             filled_pauses_per_min = ?4, talk_ratio = ?5, duration_sec = COALESCE(?6, duration_sec) \
             WHERE id = ?1",
            params![id, s.score, s.wpm, s.filled_pauses_per_min, s.talk_ratio, s.duration_sec],
        )?;
        if let Some(t) = s.llm_type {
            self.conn.execute(
                "UPDATE meetings SET meeting_type = ?2, type_source = 'llm' \
                 WHERE id = ?1 AND type_source = 'default'",
                params![id, t.as_str()],
            )?;
        }
        Ok(())
    }

    /// Пользовательская правка: заголовок и/или тип (тип → type_source = user).
    pub fn update_meta(
        &self,
        id: &str,
        title: Option<&str>,
        meeting_type: Option<MeetingType>,
    ) -> Result<()> {
        if let Some(t) = title {
            self.conn
                .execute("UPDATE meetings SET title = ?2 WHERE id = ?1", params![id, t])?;
        }
        if let Some(mt) = meeting_type {
            self.conn.execute(
                "UPDATE meetings SET meeting_type = ?2, type_source = 'user' WHERE id = ?1",
                params![id, mt.as_str()],
            )?;
        }
        Ok(())
    }

    pub fn delete(&self, id: &str) -> Result<()> {
        self.conn
            .execute("DELETE FROM meetings WHERE id = ?1", params![id])?;
        Ok(())
    }

    /// После падения: встречи в статусе recording/analyzing → recorded (анализ можно перезапустить).
    pub fn recover_interrupted(&self) -> Result<usize> {
        let n = self.conn.execute(
            "UPDATE meetings SET status = 'recorded' WHERE status IN ('recording', 'analyzing')",
            [],
        )?;
        Ok(n)
    }

    /// Карточки (started_at DESC) с `prev_score` — оценкой предыдущей готовой встречи.
    pub fn cards(&self) -> Result<Vec<MeetingCard>> {
        let rows = self.list()?;
        Ok(rows_to_cards(rows))
    }

    pub fn card(&self, id: &str) -> Result<Option<MeetingCard>> {
        Ok(self.cards()?.into_iter().find(|c| c.id == id))
    }
}

fn rows_to_cards(rows: Vec<MeetingRow>) -> Vec<MeetingCard> {
    // rows идут DESC; идём с конца (от старых к новым), помня последнюю готовую оценку.
    let mut cards: Vec<MeetingCard> = Vec::with_capacity(rows.len());
    let mut last_ready: Option<f64> = None;
    for r in rows.iter().rev() {
        let prev = last_ready;
        if r.status == MeetingStatus::Ready && r.score.is_some() {
            last_ready = r.score;
        }
        cards.push(MeetingCard {
            id: r.id.clone(),
            started_at: r.started_at.clone(),
            duration_sec: r.duration_sec,
            meeting_type: r.meeting_type,
            type_source: r.type_source,
            title: r.title.clone(),
            status: r.status,
            score: r.score,
            prev_score: prev,
            has_system_track: r.has_system_track,
            training_task_id: r.training_task_id.clone(),
            error: r.error.clone(),
            wpm: r.wpm,
            filled_pauses_per_min: r.filled_pauses_per_min,
            talk_ratio: r.talk_ratio,
        });
    }
    cards.reverse();
    cards
}

#[cfg(test)]
mod tests {
    use super::*;

    fn new_meeting(id: &str, started_at: &str, t: MeetingType) -> NewMeeting {
        NewMeeting {
            id: id.to_string(),
            started_at: started_at.to_string(),
            duration_sec: 0.0,
            meeting_type: t,
            type_source: TypeSource::Default,
            title: None,
            status: MeetingStatus::Recording,
            has_system_track: false,
            training_task_id: None,
        }
    }

    #[test]
    fn migrations_and_crud() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("remarka.sqlite");
        let db = Db::open(&path).unwrap();
        // повторная миграция идемпотентна
        db.migrate().unwrap();
        drop(db);
        let db = Db::open(&path).unwrap();
        let v: i64 = db.conn.query_row("PRAGMA user_version", [], |r| r.get(0)).unwrap();
        assert_eq!(v, SCHEMA_VERSION);

        db.insert(&new_meeting("a", "2026-09-01T10:00:00+03:00", MeetingType::Other)).unwrap();
        db.insert(&new_meeting("b", "2026-09-02T10:00:00+03:00", MeetingType::Pitch)).unwrap();
        db.insert(&new_meeting("c", "2026-09-03T10:00:00+03:00", MeetingType::Training)).unwrap();

        let list = db.list().unwrap();
        assert_eq!(list.iter().map(|m| m.id.as_str()).collect::<Vec<_>>(), vec!["c", "b", "a"]);

        db.set_duration("a", 120.5).unwrap();
        db.set_status("a", MeetingStatus::Recorded, None).unwrap();
        let a = db.get("a").unwrap().unwrap();
        assert_eq!(a.duration_sec, 120.5);
        assert_eq!(a.status, MeetingStatus::Recorded);

        db.apply_report(
            "a",
            &ReportSummary {
                score: Some(71.0),
                wpm: Some(128.0),
                filled_pauses_per_min: Some(2.5),
                talk_ratio: None,
                duration_sec: Some(121.0),
                llm_type: Some(MeetingType::Demo),
            },
        )
        .unwrap();
        let a = db.get("a").unwrap().unwrap();
        assert_eq!(a.status, MeetingStatus::Ready);
        assert_eq!(a.meeting_type, MeetingType::Demo);
        assert_eq!(a.type_source, TypeSource::Llm);
        assert_eq!(a.duration_sec, 121.0);
        assert_eq!(a.wpm, Some(128.0));

        // тип, заданный пользователем, LLM не перебивает
        db.update_meta("b", Some("Питч фонду"), Some(MeetingType::Pitch)).unwrap();
        db.apply_report(
            "b",
            &ReportSummary { score: Some(80.0), llm_type: Some(MeetingType::Sales), ..Default::default() },
        )
        .unwrap();
        let b = db.get("b").unwrap().unwrap();
        assert_eq!(b.meeting_type, MeetingType::Pitch);
        assert_eq!(b.type_source, TypeSource::User);
        assert_eq!(b.title.as_deref(), Some("Питч фонду"));

        db.set_status("c", MeetingStatus::Error, Some("движок упал")).unwrap();

        let cards = db.cards().unwrap();
        assert_eq!(cards[0].id, "c");
        assert_eq!(cards[0].prev_score, Some(80.0));
        assert_eq!(cards[0].error.as_deref(), Some("движок упал"));
        assert_eq!(cards[1].id, "b");
        assert_eq!(cards[1].prev_score, Some(71.0));
        assert_eq!(cards[2].id, "a");
        assert_eq!(cards[2].prev_score, None);
        assert_eq!(cards[2].score, Some(71.0));

        assert_eq!(db.count_ready_non_training().unwrap(), 2);
        assert_eq!(db.ready_rows().unwrap().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(), vec!["a", "b"]);

        db.delete("b").unwrap();
        assert!(db.get("b").unwrap().is_none());
        assert_eq!(db.list().unwrap().len(), 2);
        assert!(db.card("zzz").unwrap().is_none());
    }
}
