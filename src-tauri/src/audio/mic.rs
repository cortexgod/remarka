//! Захват микрофона: cpal input stream на выделенном потоке → downmix → ресемплинг
//! в 16 кГц моно → hound WAV int16. На том же потоке — уровень (дБFS) и оценка темпа,
//! тики раз в 250 мс через callback.

use crate::audio::level::LevelMeter;
use crate::audio::resample::{downmix, Resampler};
use crate::audio::tempo::TempoEstimator;
use crate::models::AudioDevice;
use crate::util::lock;
use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{FromSample, Sample, SampleFormat, SizedSample};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

pub const TARGET_RATE: u32 = 16000;
/// Сколько ждать первого ответа устройства (включая системный запрос разрешения).
pub const READY_TIMEOUT: Duration = Duration::from_secs(45);

#[derive(Debug, Clone)]
pub struct MicTick {
    pub elapsed_sec: f64,
    pub level_db: f32,
    pub wpm_estimate: Option<f32>,
    /// Поток микрофона оборвался (устройство отключено и т. п.): запись остановлена, WAV дописан.
    pub error: Option<String>,
}

pub type TickFn = Box<dyn FnMut(MicTick) + Send>;

/// Как выбрать устройство и конфигурацию потока.
pub type DevicePicker =
    Box<dyn FnOnce(&cpal::Host) -> Result<(cpal::Device, cpal::SupportedStreamConfig)> + Send>;

#[derive(Default)]
pub struct MicShared {
    pub samples_written: AtomicU64,
    level_bits: AtomicU32,
    wpm: Mutex<Option<f32>>,
    pub error: Mutex<Option<String>>,
}

impl MicShared {
    pub fn level_db(&self) -> f32 {
        f32::from_bits(self.level_bits.load(Ordering::Relaxed))
    }

    pub fn wpm_estimate(&self) -> Option<f32> {
        *lock(&self.wpm)
    }

    pub fn elapsed_sec(&self) -> f64 {
        self.samples_written.load(Ordering::Relaxed) as f64 / TARGET_RATE as f64
    }
}

pub struct MicHandle {
    stop: Arc<AtomicBool>,
    thread: Option<JoinHandle<Result<f64>>>,
    pub shared: Arc<MicShared>,
}

impl MicHandle {
    /// Останавливает поток и дописывает WAV. Возвращает длительность в секундах.
    pub fn stop(mut self) -> Result<f64> {
        self.stop.store(true, Ordering::SeqCst);
        match self.thread.take() {
            Some(t) => t
                .join()
                .map_err(|_| anyhow!("поток записи микрофона аварийно завершился"))?,
            None => Ok(self.shared.elapsed_sec()),
        }
    }

    pub fn elapsed_sec(&self) -> f64 {
        self.shared.elapsed_sec()
    }

    pub fn level_db(&self) -> f32 {
        self.shared.level_db()
    }

    pub fn wpm_estimate(&self) -> Option<f32> {
        self.shared.wpm_estimate()
    }
}

impl Drop for MicHandle {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
    }
}

fn device_name(d: &cpal::Device) -> String {
    d.description()
        .map(|x| x.name().to_string())
        .unwrap_or_else(|_| "Микрофон".to_string())
}

fn device_id_str(d: &cpal::Device) -> String {
    d.id()
        .map(|i| i.to_string())
        .unwrap_or_else(|_| device_name(d))
}

pub fn list_devices() -> Result<Vec<AudioDevice>> {
    let host = cpal::default_host();
    let default_id = host.default_input_device().map(|d| device_id_str(&d));
    let mut out = Vec::new();
    for d in host
        .input_devices()
        .context("не удалось перечислить устройства ввода")?
    {
        let id = device_id_str(&d);
        out.push(AudioDevice {
            is_default: default_id.as_deref() == Some(id.as_str()),
            name: device_name(&d),
            id,
        });
    }
    Ok(out)
}

fn pick_input_device(host: &cpal::Host, wanted: Option<&str>) -> Result<cpal::Device> {
    if let Some(wanted) = wanted.map(str::trim).filter(|w| !w.is_empty()) {
        if let Ok(did) = wanted.parse::<cpal::DeviceId>() {
            if let Some(d) = host.device_by_id(&did) {
                return Ok(d);
            }
        }
        if let Ok(devs) = host.input_devices() {
            for d in devs {
                if device_name(&d) == wanted || device_id_str(&d) == wanted {
                    return Ok(d);
                }
            }
        }
        log::warn!("устройство ввода «{wanted}» не найдено, используем устройство по умолчанию");
    }
    host.default_input_device()
        .ok_or_else(|| anyhow!("Не найдено устройство ввода (микрофон)"))
}

/// Запуск записи микрофона (`device_id` — из `list_audio_devices`, None = по умолчанию).
pub fn start(
    device_id: Option<&str>,
    out_path: &Path,
    tick: TickFn,
    tick_interval: Duration,
    lead_from: Option<Instant>,
) -> Result<MicHandle> {
    let wanted = device_id.map(str::to_string);
    let picker: DevicePicker = Box::new(move |host| {
        let device = pick_input_device(host, wanted.as_deref())?;
        let config = device
            .default_input_config()
            .context("микрофон не отдаёт конфигурацию по умолчанию")?;
        Ok((device, config))
    });
    start_with_picker(picker, out_path, tick, tick_interval, lead_from)
}

/// Общий запуск для микрофона и (на Windows) loopback-захвата.
/// `lead_from` — момент старта другой дорожки (системного звука): в начало WAV дописывается
/// тишина на разницу во времени, чтобы дорожки были выровнены по t=0.
pub fn start_with_picker(
    picker: DevicePicker,
    out_path: &Path,
    mut tick: TickFn,
    tick_interval: Duration,
    lead_from: Option<Instant>,
) -> Result<MicHandle> {
    let out_path: PathBuf = out_path.to_path_buf();
    if let Some(parent) = out_path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let stop = Arc::new(AtomicBool::new(false));
    let shared = Arc::new(MicShared::default());
    let (ready_tx, ready_rx) = mpsc::sync_channel::<Result<()>>(1);

    let stop_t = stop.clone();
    let shared_t = shared.clone();
    let thread = std::thread::Builder::new()
        .name("mic-capture".into())
        .spawn(move || -> Result<f64> {
            let host = cpal::default_host();
            let (device, supported) = match picker(&host) {
                Ok(x) => x,
                Err(e) => {
                    let _ = ready_tx.send(Err(anyhow!("{e:#}")));
                    return Err(e);
                }
            };
            let in_rate = supported.sample_rate();
            let channels = supported.channels() as usize;
            let format = supported.sample_format();
            let config: cpal::StreamConfig = supported.config();
            log::info!(
                "микрофон: «{}», {} Гц, {} кан., {:?}",
                device_name(&device),
                in_rate,
                channels,
                format
            );

            let spec = hound::WavSpec {
                channels: 1,
                sample_rate: TARGET_RATE,
                bits_per_sample: 16,
                sample_format: hound::SampleFormat::Int,
            };
            let mut writer = match hound::WavWriter::create(&out_path, spec) {
                Ok(w) => w,
                Err(e) => {
                    let _ = ready_tx.send(Err(anyhow!("не удалось создать {}: {e}", out_path.display())));
                    return Err(anyhow!("{e}"));
                }
            };

            let (tx, rx) = mpsc::channel::<Vec<f32>>();
            let stream = match build_stream(&device, &config, format, tx, shared_t.clone()) {
                Ok(s) => s,
                Err(e) => {
                    let _ = ready_tx.send(Err(anyhow!("{e:#}")));
                    return Err(e);
                }
            };
            if let Err(e) = stream.play() {
                let _ = ready_tx.send(Err(anyhow!("не удалось запустить поток микрофона: {e}")));
                return Err(anyhow!("{e}"));
            }
            let _ = ready_tx.send(Ok(()));

            let mut pipe = Pipeline {
                channels,
                in_rate,
                lead_from,
                resampler: Resampler::new(in_rate, TARGET_RATE),
                level: LevelMeter::new(TARGET_RATE),
                tempo: TempoEstimator::new(TARGET_RATE),
                written: 0,
                shared: shared_t.clone(),
            };
            shared_t.level_bits.store(crate::audio::level::MIN_DB.to_bits(), Ordering::Relaxed);
            let mut last_tick = Instant::now();
            let mut last_flush = Instant::now();
            let mut failure: Option<String> = None;

            loop {
                if stop_t.load(Ordering::SeqCst) {
                    break;
                }
                // ошибка потока cpal (устройство отключено, смена частоты) — фиксируем и завершаем
                if let Some(e) = lock(&shared_t.error).clone() {
                    failure = Some(e);
                    break;
                }
                match rx.recv_timeout(Duration::from_millis(50)) {
                    Ok(chunk) => pipe.consume(&chunk, &mut writer)?,
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Err(mpsc::RecvTimeoutError::Disconnected) => {
                        failure = Some("поток микрофона закрылся".into());
                        *lock(&shared_t.error) = failure.clone();
                        break;
                    }
                }
                if last_tick.elapsed() >= tick_interval {
                    last_tick = Instant::now();
                    let db = pipe.level.dbfs();
                    let wpm = pipe.tempo.wpm_estimate();
                    shared_t.level_bits.store(db.to_bits(), Ordering::Relaxed);
                    *lock(&shared_t.wpm) = wpm;
                    tick(MicTick {
                        elapsed_sec: pipe.written as f64 / TARGET_RATE as f64,
                        level_db: db,
                        wpm_estimate: wpm,
                        error: None,
                    });
                }
                if last_flush.elapsed() >= Duration::from_secs(5) {
                    last_flush = Instant::now();
                    writer.flush()?;
                }
            }
            drop(stream);
            while let Ok(chunk) = rx.try_recv() {
                pipe.consume(&chunk, &mut writer)?;
            }
            let tail = pipe.resampler.flush();
            pipe.write_out(&tail, &mut writer)?;
            writer.finalize()?;
            let duration = pipe.written as f64 / TARGET_RATE as f64;
            if let Some(msg) = failure {
                let text = format!("Микрофон перестал отдавать звук ({msg}) — запись остановлена, записанное сохранено");
                tick(MicTick {
                    elapsed_sec: duration,
                    level_db: crate::audio::level::MIN_DB,
                    wpm_estimate: None,
                    error: Some(text.clone()),
                });
                return Err(anyhow!(text));
            }
            Ok(duration)
        })?;

    // На macOS первый доступ к микрофону блокируется до ответа на системный запрос (TCC),
    // поэтому ждём долго; команда start_recording асинхронная и UI не блокирует.
    match ready_rx.recv_timeout(READY_TIMEOUT) {
        Ok(Ok(())) => Ok(MicHandle {
            stop,
            thread: Some(thread),
            shared,
        }),
        Ok(Err(e)) => {
            let _ = thread.join();
            Err(e)
        }
        Err(_) => {
            stop.store(true, Ordering::SeqCst);
            Err(anyhow!(
                "Микрофон не ответил за {} с. Возможно, macOS ждёт ответа на запрос доступа к микрофону — \
                 разрешите доступ (Системные настройки → Конфиденциальность → Микрофон) и попробуйте снова",
                READY_TIMEOUT.as_secs()
            ))
        }
    }
}

type WavOut = hound::WavWriter<std::io::BufWriter<std::fs::File>>;

/// Обработка на потоке записи: downmix → ресемплинг → уровень/темп → WAV.
struct Pipeline {
    channels: usize,
    in_rate: u32,
    /// Пока Some — ждём первого чанка, чтобы дописать ведущую тишину (выравнивание с системной дорожкой).
    lead_from: Option<Instant>,
    resampler: Resampler,
    level: LevelMeter,
    tempo: TempoEstimator,
    written: u64,
    shared: Arc<MicShared>,
}

impl Pipeline {
    fn consume(&mut self, chunk: &[f32], writer: &mut WavOut) -> Result<()> {
        if let Some(t0) = self.lead_from.take() {
            // первый чанк: его начало = сейчас − длительность чанка; всё до этого — тишина
            let chunk_sec = (chunk.len() / self.channels.max(1)) as f64 / self.in_rate.max(1) as f64;
            let offset = Instant::now().saturating_duration_since(t0).as_secs_f64() - chunk_sec;
            if offset > 0.02 {
                let n = (offset.min(600.0) * TARGET_RATE as f64).round() as usize;
                log::info!("выравнивание дорожек: микрофон стартовал на {offset:.3} с позже — дописываю тишину");
                let zeros = vec![0.0f32; n];
                self.write_out(&zeros, writer)?;
            }
        }
        let mono = downmix(chunk, self.channels);
        let out = self.resampler.process(&mono);
        self.level.push(&out);
        self.tempo.push(&out);
        self.write_out(&out, writer)
    }

    fn write_out(&mut self, samples: &[f32], writer: &mut WavOut) -> Result<()> {
        for s in samples {
            writer.write_sample((s.clamp(-1.0, 1.0) * 32767.0).round() as i16)?;
        }
        self.written += samples.len() as u64;
        self.shared
            .samples_written
            .store(self.written, Ordering::Relaxed);
        Ok(())
    }
}

fn build_stream(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    format: SampleFormat,
    tx: mpsc::Sender<Vec<f32>>,
    shared: Arc<MicShared>,
) -> Result<cpal::Stream> {
    match format {
        SampleFormat::F32 => build_typed::<f32>(device, config, tx, shared),
        SampleFormat::I16 => build_typed::<i16>(device, config, tx, shared),
        SampleFormat::U16 => build_typed::<u16>(device, config, tx, shared),
        SampleFormat::I32 => build_typed::<i32>(device, config, tx, shared),
        SampleFormat::I8 => build_typed::<i8>(device, config, tx, shared),
        SampleFormat::U8 => build_typed::<u8>(device, config, tx, shared),
        SampleFormat::F64 => build_typed::<f64>(device, config, tx, shared),
        other => Err(anyhow!("неподдерживаемый формат сэмплов микрофона: {other:?}")),
    }
}

fn build_typed<T>(
    device: &cpal::Device,
    config: &cpal::StreamConfig,
    tx: mpsc::Sender<Vec<f32>>,
    shared: Arc<MicShared>,
) -> Result<cpal::Stream>
where
    T: SizedSample + Send + 'static,
    f32: FromSample<T>,
{
    let stream = device
        .build_input_stream::<T, _, _>(
            config.clone(),
            move |data: &[T], _: &cpal::InputCallbackInfo| {
                let v: Vec<f32> = data.iter().map(|s| f32::from_sample(*s)).collect();
                let _ = tx.send(v);
            },
            move |e| {
                log::error!("cpal: {e}");
                *lock(&shared.error) = Some(e.to_string());
            },
            None,
        )
        .context("не удалось открыть поток микрофона")?;
    Ok(stream)
}
