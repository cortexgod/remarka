//! Каталог данных (§2): `<data_dir>/remarka.sqlite`, `settings.json`, `baseline.json`,
//! `patterns.json`, `meetings/<id>/{mic.wav,system.wav,report.json,engine.log}`.

use anyhow::{Context, Result};
use std::path::{Path, PathBuf};

#[derive(Debug, Clone)]
pub struct Paths {
    pub data_dir: PathBuf,
}

impl Paths {
    pub fn new(data_dir: PathBuf) -> Result<Self> {
        std::fs::create_dir_all(&data_dir)
            .with_context(|| format!("не удалось создать каталог данных {}", data_dir.display()))?;
        let p = Paths { data_dir };
        std::fs::create_dir_all(p.meetings_dir())?;
        Ok(p)
    }

    pub fn db_path(&self) -> PathBuf {
        self.data_dir.join("remarka.sqlite")
    }

    pub fn settings_path(&self) -> PathBuf {
        self.data_dir.join("settings.json")
    }

    pub fn baseline_path(&self) -> PathBuf {
        self.data_dir.join("baseline.json")
    }

    pub fn patterns_path(&self) -> PathBuf {
        self.data_dir.join("patterns.json")
    }

    /// Общий лог движка для команд без встречи (doctor, baseline, patterns, prepare).
    pub fn engine_shared_log(&self) -> PathBuf {
        self.data_dir.join("engine.log")
    }

    pub fn prep_dir(&self) -> PathBuf {
        self.data_dir.join("prep")
    }

    pub fn meetings_dir(&self) -> PathBuf {
        self.data_dir.join("meetings")
    }

    pub fn meeting_dir(&self, id: &str) -> PathBuf {
        self.meetings_dir().join(id)
    }

    pub fn mic_wav(&self, id: &str) -> PathBuf {
        self.meeting_dir(id).join("mic.wav")
    }

    pub fn system_wav(&self, id: &str) -> PathBuf {
        self.meeting_dir(id).join("system.wav")
    }

    pub fn report_json(&self, id: &str) -> PathBuf {
        self.meeting_dir(id).join("report.json")
    }

    pub fn engine_log(&self, id: &str) -> PathBuf {
        self.meeting_dir(id).join("engine.log")
    }
}

/// Проверка, что id — UUID v4 в нижнем регистре (защита от `..` в путях).
pub fn is_valid_meeting_id(id: &str) -> bool {
    id.len() == 36
        && id
            .chars()
            .all(|c| c == '-' || c.is_ascii_digit() || ('a'..='f').contains(&c))
}

/// Каталог рядом с исполняемым файлом (для сайдкаров).
pub fn exe_dir() -> Option<PathBuf> {
    std::env::current_exe()
        .ok()
        .and_then(|p| p.parent().map(Path::to_path_buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn layout() {
        let dir = tempfile::tempdir().unwrap();
        let p = Paths::new(dir.path().join("data")).unwrap();
        assert!(p.meetings_dir().is_dir());
        let id = "0b7f1c3e-1111-4222-8333-444455556666";
        assert!(is_valid_meeting_id(id));
        assert!(!is_valid_meeting_id("../etc"));
        assert!(!is_valid_meeting_id("0B7F1C3E-1111-4222-8333-444455556666"));
        assert!(p.mic_wav(id).ends_with("meetings/0b7f1c3e-1111-4222-8333-444455556666/mic.wav"));
        assert_eq!(p.db_path().file_name().unwrap(), "remarka.sqlite");
    }
}
