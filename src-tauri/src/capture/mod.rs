//! Захват системного звука: macOS — сайдкар `remarka-tap` (§7), Windows — WASAPI loopback.

#[cfg(target_os = "macos")]
pub mod macos;
#[cfg(target_os = "windows")]
pub mod windows;

use anyhow::Result;
use std::path::Path;
use std::sync::{Arc, Mutex};

/// Последний уровень системной дорожки, дБFS (пишет захват, читает поток тиков микрофона).
#[derive(Default)]
pub struct LevelCell(Mutex<Option<f32>>);

impl LevelCell {
    pub fn get(&self) -> Option<f32> {
        *crate::util::lock(&self.0)
    }

    pub fn set(&self, v: Option<f32>) {
        *crate::util::lock(&self.0) = v;
    }
}

pub trait SystemCapture: Send {
    /// Начинает запись в `path` (WAV 16 кГц моно int16). Блокирует до реального старта.
    fn start(&mut self, path: &Path) -> Result<()>;
    /// Останавливает запись, возвращает длительность в секундах.
    fn stop(&mut self) -> Result<f64>;
    /// Текущий уровень, дБFS.
    fn level(&self) -> Option<f32>;
    /// Разделяемая ячейка уровня (для тиков без блокировки состояния).
    fn level_cell(&self) -> Arc<LevelCell>;
}

/// Поддерживается ли захват системного звука на этой машине прямо сейчас.
pub fn supported() -> bool {
    #[cfg(target_os = "macos")]
    {
        macos::find_tap_binary().is_some()
    }
    #[cfg(target_os = "windows")]
    {
        true
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        false
    }
}

/// Создаёт захват для текущей платформы; ошибка — готовый текст для пользователя.
pub fn create() -> std::result::Result<Box<dyn SystemCapture>, String> {
    #[cfg(target_os = "macos")]
    {
        match macos::find_tap_binary() {
            Some(bin) => Ok(Box::new(macos::TapCapture::new(bin))),
            None => Err(
                "Захват системного звука недоступен: не найден помощник remarka-tap. \
                 Соберите его командой tap/build.sh или запишите встречу без системного звука."
                    .to_string(),
            ),
        }
    }
    #[cfg(target_os = "windows")]
    {
        Ok(Box::new(windows::LoopbackCapture::new()))
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        Err("Захват системного звука не поддерживается на этой платформе".to_string())
    }
}
