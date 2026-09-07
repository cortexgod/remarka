//! Состояние приложения, живёт в `tauri::State`.

use crate::audio::ActiveRecording;
use crate::db::Db;
use crate::engine::EngineQueue;
use crate::models::Settings;
use crate::paths::Paths;
use crate::util::lock;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

pub struct AppState {
    pub paths: Paths,
    pub db: Mutex<Db>,
    pub settings: Mutex<Settings>,
    pub recorder: Mutex<Option<ActiveRecording>>,
    /// Запись запускается (устройства открываются, возможен системный запрос разрешения).
    pub starting: AtomicBool,
    pub engine: Mutex<EngineQueue>,
    /// Текущее приложение для звонков ("zoom" | "teams" | "telemost") или None.
    pub meeting_app: Mutex<Option<String>>,
}

impl AppState {
    pub fn new(paths: Paths, db: Db, settings: Settings) -> Self {
        AppState {
            paths,
            db: Mutex::new(db),
            settings: Mutex::new(settings),
            recorder: Mutex::new(None),
            starting: AtomicBool::new(false),
            engine: Mutex::new(EngineQueue::default()),
            meeting_app: Mutex::new(None),
        }
    }

    /// Пытается занять «слот запуска записи»; false — запуск уже идёт.
    pub fn try_begin_start(&self) -> bool {
        self.starting
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
    }

    pub fn end_start(&self) {
        self.starting.store(false, Ordering::SeqCst);
    }

    pub fn settings(&self) -> Settings {
        lock(&self.settings).clone()
    }

    pub fn is_recording(&self) -> bool {
        lock(&self.recorder).is_some()
    }

    pub fn recording_id(&self) -> Option<String> {
        lock(&self.recorder).as_ref().map(|r| r.meeting_id.clone())
    }
}
