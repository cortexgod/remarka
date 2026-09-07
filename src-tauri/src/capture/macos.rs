//! macOS: запуск сайдкара `remarka-tap` (Core Audio Process Taps), протокол §7:
//! stdout JSON lines `ready` / `level` / `stopped` / `error`; стоп — строка `stop` в stdin.

use super::{LevelCell, SystemCapture};
use crate::paths::exe_dir;
use anyhow::{anyhow, Context, Result};
use serde_json::Value;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

const TAP_NAMES: [&str; 3] = [
    "remarka-tap",
    "remarka-tap-aarch64-apple-darwin",
    "remarka-tap-x86_64-apple-darwin",
];

/// Ищет бинарник: рядом с исполняемым файлом, затем (debug) `<CARGO_MANIFEST_DIR>/binaries/`.
pub fn find_tap_binary() -> Option<PathBuf> {
    if let Some(dir) = exe_dir() {
        for n in TAP_NAMES {
            let p = dir.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    if cfg!(debug_assertions) {
        let dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("binaries");
        for n in TAP_NAMES {
            let p = dir.join(n);
            if p.is_file() {
                return Some(p);
            }
        }
    }
    None
}

#[derive(Default)]
struct TapShared {
    ready: AtomicBool,
    exited: AtomicBool,
    level: Arc<LevelCell>,
    stopped_duration: Mutex<Option<f64>>,
    error: Mutex<Option<String>>,
}

pub struct TapCapture {
    binary: PathBuf,
    child: Option<Child>,
    stdin: Option<ChildStdin>,
    reader: Option<JoinHandle<()>>,
    shared: Arc<TapShared>,
    path: Option<PathBuf>,
}

impl TapCapture {
    pub fn new(binary: PathBuf) -> Self {
        TapCapture {
            binary,
            child: None,
            stdin: None,
            reader: None,
            shared: Arc::new(TapShared::default()),
            path: None,
        }
    }

    fn error_text(&self) -> Option<String> {
        crate::util::lock(&self.shared.error).clone()
    }
}

fn humanize(msg: &str) -> String {
    let lower = msg.to_lowercase();
    if lower.contains("разреш") {
        // сайдкар уже объяснил по-русски — не дублируем
        return msg.to_string();
    }
    if lower.contains("permission") || lower.contains("tcc") || lower.contains("denied") {
        format!(
            "Нет разрешения на запись системного звука. Разрешите Ремарке «Запись системного звука» \
             в Системных настройках → Конфиденциальность и безопасность. ({msg})"
        )
    } else {
        msg.to_string()
    }
}

fn reader_loop(stdout: std::process::ChildStdout, shared: Arc<TapShared>) {
    for line in BufReader::new(stdout).lines() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(line.trim()) else {
            log::debug!("remarka-tap: {line}");
            continue;
        };
        match v.get("event").and_then(Value::as_str) {
            Some("ready") => shared.ready.store(true, Ordering::SeqCst),
            Some("level") => shared
                .level
                .set(v.get("db").and_then(Value::as_f64).map(|d| d as f32)),
            Some("stopped") => {
                *crate::util::lock(&shared.stopped_duration) =
                    v.get("duration_sec").and_then(Value::as_f64);
            }
            Some("error") => {
                let msg = v
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("неизвестная ошибка remarka-tap")
                    .to_string();
                log::error!("remarka-tap: {msg}");
                *crate::util::lock(&shared.error) = Some(humanize(&msg));
            }
            other => log::debug!("remarka-tap: событие {other:?}"),
        }
    }
    shared.exited.store(true, Ordering::SeqCst);
    // процесс завершился: уровня больше нет; если это не штатный stop — это обрыв дорожки
    shared.level.set(None);
    let stopped = crate::util::lock(&shared.stopped_duration).is_some();
    if !stopped {
        let msg = crate::util::lock(&shared.error).clone().unwrap_or_else(|| {
            "Помощник записи системного звука (remarka-tap) завершился неожиданно — системная дорожка оборвалась".to_string()
        });
        if crate::util::lock(&shared.error).is_none() {
            *crate::util::lock(&shared.error) = Some(msg.clone());
        }
        if shared.ready.load(Ordering::SeqCst) {
            shared.level.set_error(Some(msg));
        }
    }
}

/// Сколько ждать `ready`: сайдкар сам ждёт ответа на системный диалог разрешения до 180 с
/// и сам завершается с `error`, если захват не пошёл, — поэтому здесь только запас.
const READY_TIMEOUT: Duration = Duration::from_secs(190);

impl SystemCapture for TapCapture {
    fn start(&mut self, path: &Path) -> Result<()> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut cmd = Command::new(&self.binary);
        cmd.arg("--out")
            .arg(path)
            .arg("--rate")
            .arg("16000")
            .arg("--exclude-pid")
            .arg(std::process::id().to_string())
            .arg("--level-interval-ms")
            .arg("200")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        // stderr сайдкара — в tap.log рядом с записью (в бандле иначе теряется)
        match path
            .parent()
            .map(|d| d.join("tap.log"))
            .and_then(|p| std::fs::File::create(p).ok())
        {
            Some(f) => {
                cmd.stderr(Stdio::from(f));
            }
            None => {
                cmd.stderr(Stdio::inherit());
            }
        }
        let mut child = cmd
            .spawn()
            .with_context(|| format!("не удалось запустить {}", self.binary.display()))?;
        let stdout = child.stdout.take().context("нет stdout у remarka-tap")?;
        self.stdin = child.stdin.take();
        let shared = self.shared.clone();
        self.reader = Some(
            std::thread::Builder::new()
                .name("remarka-tap-reader".into())
                .spawn(move || reader_loop(stdout, shared))?,
        );
        self.child = Some(child);
        self.path = Some(path.to_path_buf());

        let t = Instant::now();
        loop {
            if self.shared.ready.load(Ordering::SeqCst) {
                return Ok(());
            }
            if let Some(e) = self.error_text() {
                let _ = self.stop();
                return Err(anyhow!(e));
            }
            if self.shared.exited.load(Ordering::SeqCst) {
                let _ = self.stop();
                return Err(anyhow!("remarka-tap завершился, не начав запись"));
            }
            if t.elapsed() > READY_TIMEOUT {
                let stop_err = self.stop().err().map(|e| format!("{e:#}"));
                return Err(anyhow!(
                    "remarka-tap не начал запись за {} с{}",
                    READY_TIMEOUT.as_secs(),
                    stop_err.map(|e| format!(": {e}")).unwrap_or_default()
                ));
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }

    fn stop(&mut self) -> Result<f64> {
        let Some(mut child) = self.child.take() else {
            return Err(anyhow!("захват системного звука не запущен"));
        };
        if let Some(mut stdin) = self.stdin.take() {
            let _ = stdin.write_all(b"stop\n");
            let _ = stdin.flush();
            drop(stdin);
        }
        let t = Instant::now();
        let mut exited = false;
        while t.elapsed() < Duration::from_secs(6) {
            if let Ok(Some(_)) = child.try_wait() {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(30));
        }
        if !exited {
            log::warn!("remarka-tap не остановился по stop — посылаем SIGTERM");
            unsafe {
                libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
            }
            let t = Instant::now();
            while t.elapsed() < Duration::from_secs(3) {
                if let Ok(Some(_)) = child.try_wait() {
                    exited = true;
                    break;
                }
                std::thread::sleep(Duration::from_millis(30));
            }
            if !exited {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Some(r) = self.reader.take() {
            let _ = r.join();
        }
        if let Some(d) = *crate::util::lock(&self.shared.stopped_duration) {
            return Ok(d);
        }
        if let Some(e) = self.error_text() {
            return Err(anyhow!(e));
        }
        match self.path.as_deref().and_then(crate::audio::wav_duration_sec) {
            Some(d) => Ok(d),
            None => Err(anyhow!("remarka-tap не сообщил длительность и не оставил валидный WAV")),
        }
    }

    fn level(&self) -> Option<f32> {
        self.shared.level.get()
    }

    fn level_cell(&self) -> Arc<LevelCell> {
        self.shared.level.clone()
    }

    fn error(&self) -> Option<String> {
        self.error_text()
    }
}

impl Drop for TapCapture {
    fn drop(&mut self) {
        if self.child.is_some() {
            let _ = self.stop();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// Имитация remarka-tap по протоколу §7: ready → level каждые N мс → stop по stdin → stopped.
    const FAKE_TAP: &str = r#"
import sys, json, time, argparse, wave, struct, select
p = argparse.ArgumentParser()
p.add_argument('--out'); p.add_argument('--rate', type=int, default=16000)
p.add_argument('--exclude-pid', action='append'); p.add_argument('--level-interval-ms', type=int, default=200)
p.add_argument('--fail', action='store_true')
a = p.parse_args()
if a.fail:
    print(json.dumps({"event":"error","message":"TCC: audio capture permission denied"}), flush=True)
    sys.exit(1)
print(json.dumps({"event":"ready"}), flush=True)
w = wave.open(a.out, 'wb'); w.setnchannels(1); w.setsampwidth(2); w.setframerate(a.rate)
n = 0
while True:
    r, _, _ = select.select([sys.stdin], [], [], a.level_interval_ms / 1000)
    if r:
        line = sys.stdin.readline()
        if not line or line.strip() == 'stop':
            break
    print(json.dumps({"event":"level","db":-31.2}), flush=True)
    k = a.rate // 5
    w.writeframes(struct.pack('<%dh' % k, *([1000] * k))); n += k
w.close()
print(json.dumps({"event":"stopped","duration_sec": n / a.rate, "path": a.out}), flush=True)
"#;

    fn fake_tap(dir: &Path, extra: &str) -> PathBuf {
        let script = dir.join("fake_tap.py");
        std::fs::write(&script, FAKE_TAP).unwrap();
        let wrapper = dir.join("remarka-tap");
        std::fs::write(
            &wrapper,
            format!("#!/bin/sh\nexec python3 \"{}\" {} \"$@\"\n", script.display(), extra),
        )
        .unwrap();
        std::fs::set_permissions(&wrapper, std::fs::Permissions::from_mode(0o755)).unwrap();
        wrapper
    }

    #[test]
    fn tap_protocol_roundtrip() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_tap(dir.path(), "");
        let out = dir.path().join("system.wav");
        let mut cap = TapCapture::new(bin);
        cap.start(&out).unwrap();
        std::thread::sleep(Duration::from_millis(700));
        let cell = cap.level_cell();
        assert_eq!(cap.level(), Some(-31.2));
        assert_eq!(cell.get(), Some(-31.2));
        let d = cap.stop().unwrap();
        assert!(d > 0.3, "{d}");
        let r = hound::WavReader::open(&out).unwrap();
        assert_eq!(r.spec().sample_rate, 16000);
        assert_eq!(r.spec().channels, 1);
        assert!((r.len() as f64 / 16000.0 - d).abs() < 0.01);
        assert!(cap.stop().is_err(), "повторный stop — ошибка, не паника");
    }

    #[test]
    fn tap_error_is_reported_in_russian() {
        let dir = tempfile::tempdir().unwrap();
        let bin = fake_tap(dir.path(), "--fail");
        let mut cap = TapCapture::new(bin);
        let e = cap.start(&dir.path().join("system.wav")).unwrap_err().to_string();
        assert!(e.contains("Нет разрешения"), "{e}");
        assert!(e.contains("TCC"), "{e}");
    }

    #[test]
    fn missing_binary_fails_cleanly() {
        let mut cap = TapCapture::new(PathBuf::from("/nonexistent/remarka-tap"));
        assert!(cap.start(Path::new("/tmp/x.wav")).is_err());
    }
}
