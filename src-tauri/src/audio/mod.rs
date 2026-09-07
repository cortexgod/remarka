//! Recorder: старт/стоп записи, два писателя WAV (микрофон + системный звук), тики.

pub mod level;
pub mod mic;
pub mod resample;
pub mod tempo;

use crate::capture::{self, LevelCell, SystemCapture};
use crate::models::{events, EvRecordingTick};
use anyhow::{anyhow, Context, Result};
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;
use tauri::{AppHandle, Emitter};

pub const TICK_INTERVAL: Duration = Duration::from_millis(250);

pub struct StartParams {
    pub meeting_id: String,
    pub started_at: String,
    pub mic_path: PathBuf,
    /// Some(path) → писать системный звук.
    pub system_path: Option<PathBuf>,
    pub input_device: Option<String>,
}

pub struct StopInfo {
    pub mic_duration_sec: f64,
    pub system_duration_sec: Option<f64>,
    pub system_error: Option<String>,
}

pub struct ActiveRecording {
    pub meeting_id: String,
    pub started_at: String,
    pub system_audio: bool,
    mic: Option<mic::MicHandle>,
    system: Option<Box<dyn SystemCapture>>,
    system_level: Option<Arc<LevelCell>>,
}

impl ActiveRecording {
    pub fn elapsed_sec(&self) -> f64 {
        self.mic.as_ref().map(|m| m.elapsed_sec()).unwrap_or(0.0)
    }

    pub fn level_db(&self) -> f32 {
        self.mic.as_ref().map(|m| m.level_db()).unwrap_or(level::MIN_DB)
    }

    pub fn wpm_estimate(&self) -> Option<f32> {
        self.mic.as_ref().and_then(|m| m.wpm_estimate())
    }

    pub fn system_level_db(&self) -> Option<f32> {
        self.system_level.as_ref().and_then(|c| c.get())
    }

    /// Останавливает обе дорожки. Ошибка микрофона — фатальна, системного звука — нет.
    pub fn stop(mut self) -> Result<StopInfo> {
        let mic_duration = match self.mic.take() {
            Some(m) => m.stop()?,
            None => 0.0,
        };
        let mut system_duration = None;
        let mut system_error = None;
        if let Some(mut cap) = self.system.take() {
            match cap.stop() {
                Ok(d) => system_duration = Some(d),
                Err(e) => {
                    log::error!("системный звук: {e:#}");
                    system_error = Some(format!("{e:#}"));
                }
            }
        }
        Ok(StopInfo {
            mic_duration_sec: mic_duration,
            system_duration_sec: system_duration,
            system_error,
        })
    }
}

/// Запускает запись: сначала системный звук (если просили), затем микрофон.
/// Ошибки — на русском, готовые для показа пользователю.
pub fn start_recording(app: &AppHandle, params: StartParams) -> Result<ActiveRecording, String> {
    let mut system: Option<Box<dyn SystemCapture>> = None;
    let mut system_level: Option<Arc<LevelCell>> = None;
    if let Some(path) = &params.system_path {
        let mut cap = capture::create()?;
        cap.start(path)
            .map_err(|e| format!("Не удалось начать запись системного звука: {e:#}"))?;
        system_level = Some(cap.level_cell());
        system = Some(cap);
    }

    let app_tick = app.clone();
    let id_tick = params.meeting_id.clone();
    let sys_level_tick = system_level.clone();
    let tick: mic::TickFn = Box::new(move |t: mic::MicTick| {
        let _ = app_tick.emit(
            events::RECORDING_TICK,
            EvRecordingTick {
                meeting_id: id_tick.clone(),
                elapsed_sec: t.elapsed_sec,
                level_db: t.level_db,
                system_level_db: sys_level_tick.as_ref().and_then(|c| c.get()),
                wpm_estimate: t.wpm_estimate,
            },
        );
    });

    let mic = match mic::start(params.input_device.as_deref(), &params.mic_path, tick, TICK_INTERVAL) {
        Ok(m) => m,
        Err(e) => {
            if let Some(mut cap) = system.take() {
                let _ = cap.stop();
            }
            return Err(format!("Не удалось начать запись микрофона: {e:#}"));
        }
    };

    Ok(ActiveRecording {
        meeting_id: params.meeting_id,
        started_at: params.started_at,
        system_audio: system.is_some(),
        mic: Some(mic),
        system,
        system_level,
    })
}

/// Конвертирует любой WAV (int/float, любой rate/каналы) в 16 кГц моно int16.
/// Возвращает длительность в секундах.
pub fn convert_wav_to_16k(src: &Path, dst: &Path) -> Result<f64> {
    let mut reader = hound::WavReader::open(src)
        .with_context(|| format!("{} — не WAV или файл повреждён", src.display()))?;
    let spec = reader.spec();
    let channels = spec.channels as usize;
    let samples: Vec<f32> = match spec.sample_format {
        hound::SampleFormat::Float => reader
            .samples::<f32>()
            .collect::<std::result::Result<Vec<_>, _>>()?,
        hound::SampleFormat::Int => {
            let scale = 1.0 / ((1u64 << (spec.bits_per_sample - 1)) as f32);
            reader
                .samples::<i32>()
                .map(|s| s.map(|v| v as f32 * scale))
                .collect::<std::result::Result<Vec<_>, _>>()?
        }
    };
    let mono = resample::downmix(&samples, channels);
    let mut rs = resample::Resampler::new(spec.sample_rate, mic::TARGET_RATE);
    let mut out = rs.process(&mono);
    out.extend(rs.flush());
    if let Some(parent) = dst.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let out_spec = hound::WavSpec {
        channels: 1,
        sample_rate: mic::TARGET_RATE,
        bits_per_sample: 16,
        sample_format: hound::SampleFormat::Int,
    };
    let mut writer = hound::WavWriter::create(dst, out_spec)?;
    for s in &out {
        writer.write_sample((s.clamp(-1.0, 1.0) * 32767.0).round() as i16)?;
    }
    writer.finalize()?;
    if out.is_empty() {
        return Err(anyhow!("в файле {} нет аудио", src.display()));
    }
    Ok(out.len() as f64 / mic::TARGET_RATE as f64)
}

/// Длительность WAV по заголовку.
pub fn wav_duration_sec(path: &Path) -> Option<f64> {
    let reader = hound::WavReader::open(path).ok()?;
    let spec = reader.spec();
    if spec.sample_rate == 0 || spec.channels == 0 {
        return None;
    }
    Some(reader.len() as f64 / spec.channels as f64 / spec.sample_rate as f64)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn convert_stereo_48k_to_mono_16k() {
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.wav");
        let dst = dir.path().join("out.wav");
        let spec = hound::WavSpec { channels: 2, sample_rate: 48000, bits_per_sample: 16, sample_format: hound::SampleFormat::Int };
        let mut w = hound::WavWriter::create(&src, spec).unwrap();
        for i in 0..96000 {
            let v = (0.5 * (2.0 * std::f32::consts::PI * 440.0 * i as f32 / 48000.0).sin() * 32767.0) as i16;
            w.write_sample(v).unwrap();
            w.write_sample(v).unwrap();
        }
        w.finalize().unwrap();
        let dur = convert_wav_to_16k(&src, &dst).unwrap();
        assert!((dur - 2.0).abs() < 0.05, "{dur}");
        let r = hound::WavReader::open(&dst).unwrap();
        assert_eq!(r.spec().sample_rate, 16000);
        assert_eq!(r.spec().channels, 1);
        assert_eq!(r.spec().bits_per_sample, 16);
        assert!((wav_duration_sec(&dst).unwrap() - 2.0).abs() < 0.05);
        assert!(convert_wav_to_16k(Path::new("/nonexistent.wav"), &dst).is_err());
    }
}
