//! Windows: WASAPI loopback через cpal — устройство вывода по умолчанию открывается как вход.
//! Компилируется только под `target_os = "windows"`.

use super::{LevelCell, SystemCapture};
use crate::audio::mic::{self, MicHandle};
use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait};
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

pub struct LoopbackCapture {
    handle: Option<MicHandle>,
    level: Arc<LevelCell>,
}

impl LoopbackCapture {
    pub fn new() -> Self {
        LoopbackCapture {
            handle: None,
            level: Arc::new(LevelCell::default()),
        }
    }
}

impl Default for LoopbackCapture {
    fn default() -> Self {
        Self::new()
    }
}

impl SystemCapture for LoopbackCapture {
    fn start(&mut self, path: &Path) -> Result<()> {
        if self.handle.is_some() {
            return Err(anyhow!("захват системного звука уже запущен"));
        }
        let picker: mic::DevicePicker = Box::new(|host: &cpal::Host| {
            let device = host
                .default_output_device()
                .ok_or_else(|| anyhow!("нет устройства вывода по умолчанию"))?;
            // WASAPI: input stream на устройстве вывода = loopback
            let config = device
                .default_output_config()
                .context("устройство вывода не отдаёт конфигурацию")?;
            Ok((device, config))
        });
        let level = self.level.clone();
        let tick: mic::TickFn = Box::new(move |t: mic::MicTick| {
            level.set(Some(t.level_db));
        });
        let handle = mic::start_with_picker(picker, path, tick, Duration::from_millis(200))
            .context("не удалось открыть loopback-поток WASAPI")?;
        self.handle = Some(handle);
        Ok(())
    }

    fn stop(&mut self) -> Result<f64> {
        let handle = self
            .handle
            .take()
            .ok_or_else(|| anyhow!("захват системного звука не запущен"))?;
        let d = handle.stop()?;
        self.level.set(None);
        Ok(d)
    }

    fn level(&self) -> Option<f32> {
        self.level.get()
    }

    fn level_cell(&self) -> Arc<LevelCell> {
        self.level.clone()
    }
}
