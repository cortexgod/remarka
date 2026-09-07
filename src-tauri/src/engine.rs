//! Запуск python-движка (§3, §6): поиск python, очередь анализа (по одной задаче),
//! парсинг JSON lines stdout → события `analysis:*`, stderr → `meetings/<id>/engine.log`,
//! автоматическая калибровка (baseline) после 3 готовых встреч.

use crate::db::ReportSummary;
use crate::models::{
    events, EngineDoctor, EngineEvent, EvAnalysisDone, EvAnalysisError, EvAnalysisProgress,
    LlmBackend, MeetingStatus, MeetingType, Settings, TypeSource,
};
use crate::paths::exe_dir;
use crate::state::AppState;
use crate::util::{lock, tail_lines};
use anyhow::{anyhow, Context, Result};
use serde::Deserialize;
use serde_json::Value;
use std::collections::VecDeque;
use std::fs::OpenOptions;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

pub const BASELINE_MEETINGS_NEEDED: u32 = 3;
const PATTERNS_MAX_REPORTS: usize = 12;

// ---------------------------------------------------------------------------
// Поиск движка
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub enum Launcher {
    /// `<python> -m remarka_engine …` с cwd = engine/ (если известен).
    Python {
        python: PathBuf,
        engine_dir: Option<PathBuf>,
    },
    /// Сайдкар `remarka-engine` рядом с бинарником (PyInstaller, на будущее).
    Sidecar(PathBuf),
}

/// `<CARGO_MANIFEST_DIR>/../engine` — только в debug-сборке.
pub fn dev_engine_dir() -> Option<PathBuf> {
    if cfg!(debug_assertions) {
        let p = Path::new(env!("CARGO_MANIFEST_DIR")).join("..").join("engine");
        if p.is_dir() {
            return Some(p.canonicalize().unwrap_or(p));
        }
    }
    None
}

pub fn find_launcher(settings: &Settings) -> Option<Launcher> {
    if let Some(custom) = settings.engine_python.as_deref().map(str::trim) {
        if !custom.is_empty() {
            let p = PathBuf::from(custom);
            if p.is_file() {
                return Some(Launcher::Python {
                    python: p,
                    engine_dir: dev_engine_dir(),
                });
            }
            log::warn!("settings.engine_python = {custom}: файла нет, ищем дальше");
        }
    }
    // движок, вложенный в приложение (bundle.resources → engine-dist/)
    if let Some(p) = bundled_engine() {
        return Some(Launcher::Sidecar(p));
    }
    if let Some(dir) = dev_engine_dir() {
        let py = if cfg!(windows) {
            dir.join(".venv").join("Scripts").join("python.exe")
        } else {
            dir.join(".venv").join("bin").join("python")
        };
        if py.is_file() {
            return Some(Launcher::Python {
                python: py,
                engine_dir: Some(dir),
            });
        }
    }
    if let Some(dir) = exe_dir() {
        for name in ["remarka-engine", "remarka-engine.exe"] {
            let p = dir.join(name);
            if p.is_file() {
                return Some(Launcher::Sidecar(p));
            }
        }
    }
    None
}

/// `Remarka.app/Contents/Resources/engine-dist/remarka-engine` (macOS) или `<exe>/engine-dist/` (Windows/Linux).
pub fn bundled_engine() -> Option<PathBuf> {
    let dir = exe_dir()?;
    let name = if cfg!(windows) { "remarka-engine.exe" } else { "remarka-engine" };
    let candidates = [
        dir.join("..").join("Resources").join("engine-dist").join(name),
        dir.join("engine-dist").join(name),
    ];
    candidates.into_iter().find(|p| p.is_file())
}

/// Скачана ли модель распознавания в кэш HF (`~/.cache/huggingface/hub/models--<repo>/snapshots/*/model.bin`).
pub fn asr_model_cached(model: &str) -> bool {
    let repo = match model {
        "large-v3-turbo" | "turbo" => "mobiuslabsgmbh/faster-whisper-large-v3-turbo".to_string(),
        m if m.contains('/') => m.to_string(),
        m => format!("Systran/faster-whisper-{m}"),
    };
    let cache = std::env::var_os("HF_HUB_CACHE")
        .map(PathBuf::from)
        .or_else(|| std::env::var_os("HF_HOME").map(|h| PathBuf::from(h).join("hub")))
        .or_else(|| dirs_home().map(|h| h.join(".cache").join("huggingface").join("hub")));
    let Some(cache) = cache else { return false };
    let snaps = cache.join(format!("models--{}", repo.replace('/', "--"))).join("snapshots");
    let Ok(rd) = std::fs::read_dir(snaps) else { return false };
    rd.flatten().any(|e| e.path().join("model.bin").is_file())
}

fn dirs_home() -> Option<PathBuf> {
    std::env::var_os("HOME").map(PathBuf::from)
}

pub fn engine_ok(settings: &Settings) -> bool {
    find_launcher(settings).is_some()
}

impl Launcher {
    pub fn python_display(&self) -> String {
        match self {
            Launcher::Python { python, .. } => python.display().to_string(),
            Launcher::Sidecar(p) => p.display().to_string(),
        }
    }

    /// Базовая команда без подкоманды: cwd, env (`PYTHONUNBUFFERED`, `ANTHROPIC_API_KEY`).
    pub fn command(&self, settings: &Settings, data_dir: &Path) -> Command {
        let mut cmd = match self {
            Launcher::Python { python, engine_dir } => {
                let mut c = Command::new(python);
                c.arg("-m").arg("remarka_engine");
                c.current_dir(engine_dir.clone().unwrap_or_else(|| data_dir.to_path_buf()));
                c
            }
            Launcher::Sidecar(p) => {
                let mut c = Command::new(p);
                c.current_dir(data_dir);
                c
            }
        };
        cmd.env("PYTHONUNBUFFERED", "1")
            .env("PYTHONIOENCODING", "utf-8")
            .env("PATH", extended_path())
            .stdin(Stdio::null());
        if let Some(key) = settings.anthropic_api_key.as_deref().map(str::trim) {
            if !key.is_empty() {
                cmd.env("ANTHROPIC_API_KEY", key);
            }
        }
        // профиль человека — в промпт слоя смысла
        if !settings.profile.is_empty() {
            if let Ok(js) = serde_json::to_string(&settings.profile) {
                cmd.env("REMARKA_PROFILE_JSON", js);
            }
        }
        // claude CLI не из PATH: локальный бинарник или SSH-обёртка (слой смысла на VPS)
        if let Some(p) = settings.llm_cli_path.as_deref().map(str::trim) {
            if !p.is_empty() {
                cmd.env("REMARKA_CLAUDE_CLI", p);
            }
        }
        #[cfg(target_os = "windows")]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            cmd.creation_flags(CREATE_NO_WINDOW);
        }
        cmd
    }
}

/// PATH для дочернего процесса движка. GUI-приложение на macOS получает минимальный PATH
/// (`/usr/bin:/bin:…`), а `claude` CLI для слоя смысла обычно лежит в `/opt/homebrew/bin`
/// или `~/.local/bin` — добавляем эти каталоги, если их ещё нет.
pub fn extended_path() -> String {
    let current = std::env::var("PATH").unwrap_or_default();
    let mut parts: Vec<String> = std::env::split_paths(&current)
        .map(|p| p.to_string_lossy().into_owned())
        .filter(|p| !p.is_empty())
        .collect();
    let mut extra: Vec<PathBuf> = vec![
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
    ];
    if let Some(home) = std::env::var_os("HOME") {
        let home = PathBuf::from(home);
        extra.push(home.join(".local").join("bin"));
        extra.push(home.join(".claude").join("local"));
    }
    for e in extra {
        let s = e.to_string_lossy().into_owned();
        if e.is_dir() && !parts.iter().any(|p| p == &s) {
            parts.push(s);
        }
    }
    std::env::join_paths(parts.iter().map(PathBuf::from))
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or(current)
}

// ---------------------------------------------------------------------------
// Протокол stdout
// ---------------------------------------------------------------------------

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

/// Разбирает одну строку stdout движка. Не-JSON и строки без `event` → None.
pub fn parse_event(line: &str) -> Option<EngineEvent> {
    let line = line.trim();
    if !line.starts_with('{') {
        return None;
    }
    let v: Value = serde_json::from_str(line).ok()?;
    let kind = v.get("event")?.as_str()?.to_string();
    Some(match kind.as_str() {
        "progress" => EngineEvent::Progress {
            stage: str_field(&v, "stage"),
            pct: v.get("pct").and_then(Value::as_f64).unwrap_or(0.0),
            message: str_field(&v, "message"),
        },
        "log" => EngineEvent::Log {
            level: v
                .get("level")
                .and_then(Value::as_str)
                .unwrap_or("info")
                .to_string(),
            message: str_field(&v, "message"),
        },
        "done" => EngineEvent::Done {
            out: str_field(&v, "out"),
        },
        "error" => EngineEvent::Error {
            message: str_field(&v, "message"),
            stage: v.get("stage").and_then(Value::as_str).map(String::from),
        },
        "doctor" => EngineEvent::Doctor(v),
        _ => EngineEvent::Other(kind, v),
    })
}

// ---------------------------------------------------------------------------
// Запуск процесса
// ---------------------------------------------------------------------------

#[derive(Debug, Default)]
pub struct RunOutcome {
    pub exit_code: Option<i32>,
    pub done_out: Option<String>,
    pub error: Option<String>,
    pub doctor: Option<Value>,
    pub timed_out: bool,
    pub stdout_lines: usize,
}

impl RunOutcome {
    pub fn succeeded(&self) -> bool {
        self.done_out.is_some() && self.error.is_none() && !self.timed_out
    }

    /// Человекочитаемая причина неудачи (русский), с хвостом лога.
    pub fn failure_message(&self, log_path: &Path) -> String {
        let base = if self.timed_out {
            "Движок не ответил вовремя и был остановлен".to_string()
        } else if let Some(e) = &self.error {
            if e == "cancelled" {
                "Анализ отменён".to_string()
            } else {
                e.clone()
            }
        } else {
            match self.exit_code {
                Some(0) => "Движок завершился без события done".to_string(),
                Some(c) => format!("Движок завершился с кодом {c}"),
                None => "Движок был прерван сигналом".to_string(),
            }
        };
        let tail = tail_lines(log_path, 6);
        if tail.trim().is_empty() {
            base
        } else {
            format!("{base}\n— engine.log:\n{tail}")
        }
    }
}

pub struct RunOptions<'a> {
    pub stderr_log: &'a Path,
    pub append_log: bool,
    pub timeout: Option<Duration>,
    pub pid_slot: Option<Arc<Mutex<Option<u32>>>>,
}

fn handle_line<F: FnMut(&EngineEvent)>(line: &str, outcome: &mut RunOutcome, on_event: &mut F) {
    outcome.stdout_lines += 1;
    match parse_event(line) {
        Some(ev) => {
            match &ev {
                EngineEvent::Done { out } => outcome.done_out = Some(out.clone()),
                EngineEvent::Error { message, .. } => outcome.error = Some(message.clone()),
                EngineEvent::Doctor(v) => outcome.doctor = Some(v.clone()),
                EngineEvent::Log { level, message } => {
                    if level == "warn" {
                        log::warn!("engine: {message}");
                    } else {
                        log::info!("engine: {message}");
                    }
                }
                _ => {}
            }
            on_event(&ev);
        }
        None => {
            if !line.trim().is_empty() {
                log::debug!("engine stdout (не JSON): {line}");
            }
        }
    }
}

/// Запускает процесс, читает stdout построчно, stderr пишет в лог. Блокирует до завершения.
pub fn run_streaming<F: FnMut(&EngineEvent)>(
    mut cmd: Command,
    opts: RunOptions<'_>,
    mut on_event: F,
) -> Result<RunOutcome> {
    if let Some(parent) = opts.stderr_log.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let log = OpenOptions::new()
        .create(true)
        .write(true)
        .append(opts.append_log)
        .truncate(!opts.append_log)
        .open(opts.stderr_log)
        .with_context(|| format!("не удалось открыть {}", opts.stderr_log.display()))?;
    cmd.stdout(Stdio::piped()).stderr(Stdio::from(log));
    // только программа и аргументы: Debug у Command печатает и переменные окружения (ключ API)
    log::info!(
        "engine: {:?} {}",
        cmd.get_program(),
        cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect::<Vec<_>>().join(" ")
    );
    let mut child = cmd
        .spawn()
        .with_context(|| format!("не удалось запустить движок {:?}", cmd.get_program()))?;
    if let Some(slot) = &opts.pid_slot {
        *lock(slot) = Some(child.id());
    }
    let stdout = child.stdout.take().context("нет stdout у процесса движка")?;
    let (tx, rx) = mpsc::channel::<String>();
    let reader = std::thread::Builder::new()
        .name("engine-stdout".into())
        .spawn(move || {
            for line in BufReader::new(stdout).lines() {
                match line {
                    Ok(l) => {
                        if tx.send(l).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        })?;

    let started = Instant::now();
    let mut outcome = RunOutcome::default();
    loop {
        if let Some(t) = opts.timeout {
            if started.elapsed() >= t {
                outcome.timed_out = true;
                break;
            }
        }
        match rx.recv_timeout(Duration::from_millis(500)) {
            Ok(line) => handle_line(&line, &mut outcome, &mut on_event),
            Err(mpsc::RecvTimeoutError::Timeout) => continue,
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
    if outcome.timed_out {
        terminate_child(&mut child);
        while let Ok(line) = rx.try_recv() {
            handle_line(&line, &mut outcome, &mut on_event);
        }
    }
    let status = child.wait()?;
    outcome.exit_code = status.code();
    if let Some(slot) = &opts.pid_slot {
        *lock(slot) = None;
    }
    let _ = reader.join();
    Ok(outcome)
}

/// SIGTERM (движок отвечает `{"event":"error","message":"cancelled"}`), затем kill.
pub fn terminate_pid(pid: u32) {
    #[cfg(unix)]
    unsafe {
        libc::kill(pid as libc::pid_t, libc::SIGTERM);
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .output();
    }
}

fn terminate_child(child: &mut Child) {
    terminate_pid(child.id());
    let t = Instant::now();
    while t.elapsed() < Duration::from_secs(3) {
        if let Ok(Some(_)) = child.try_wait() {
            return;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let _ = child.kill();
}

// ---------------------------------------------------------------------------
// Очередь анализа
// ---------------------------------------------------------------------------

#[derive(Debug, Clone)]
pub struct AnalyzeJob {
    pub meeting_id: String,
    pub llm: bool,
}

#[derive(Default)]
pub struct EngineQueue {
    pending: VecDeque<AnalyzeJob>,
    running: Option<(String, Arc<Mutex<Option<u32>>>)>,
    worker_alive: bool,
}

impl EngineQueue {
    pub fn analyzing_ids(&self) -> Vec<String> {
        let mut ids = Vec::new();
        if let Some((id, _)) = &self.running {
            ids.push(id.clone());
        }
        ids.extend(self.pending.iter().map(|j| j.meeting_id.clone()));
        ids
    }

    pub fn is_analyzing(&self, id: &str) -> bool {
        self.analyzing_ids().iter().any(|x| x == id)
    }
}

fn emit_meetings_changed(app: &AppHandle) {
    let _ = app.emit(events::MEETINGS_CHANGED, ());
}

/// Ставит анализ в очередь (статус встречи → analyzing) и при необходимости поднимает воркер.
pub fn enqueue(app: &AppHandle, job: AnalyzeJob) -> Result<()> {
    let state = app.state::<AppState>();
    let spawn_worker = {
        let mut q = lock(&state.engine);
        if q.is_analyzing(&job.meeting_id) {
            return Ok(());
        }
        q.pending.push_back(job.clone());
        if q.worker_alive {
            false
        } else {
            q.worker_alive = true;
            true
        }
    };
    lock(&state.db).set_status(&job.meeting_id, MeetingStatus::Analyzing, None)?;
    emit_meetings_changed(app);
    if spawn_worker {
        let app2 = app.clone();
        std::thread::Builder::new()
            .name("engine-worker".into())
            .spawn(move || worker(app2))?;
    }
    Ok(())
}

fn worker(app: AppHandle) {
    loop {
        let next = {
            let state = app.state::<AppState>();
            let mut q = lock(&state.engine);
            match q.pending.pop_front() {
                Some(job) => {
                    let pid = Arc::new(Mutex::new(None));
                    q.running = Some((job.meeting_id.clone(), pid.clone()));
                    Some((job, pid))
                }
                None => {
                    q.running = None;
                    q.worker_alive = false;
                    None
                }
            }
        };
        let Some((job, pid)) = next else { return };
        if let Err(e) = run_analysis(&app, &job, &pid) {
            log::error!("анализ {}: {e:#}", job.meeting_id);
            fail_meeting(&app, &job.meeting_id, &format!("{e:#}"));
        }
        let state = app.state::<AppState>();
        lock(&state.engine).running = None;
    }
}

fn fail_meeting(app: &AppHandle, meeting_id: &str, message: &str) {
    crate::util::notify(app, "Ремарка: разбор не удался", message);
    let state = app.state::<AppState>();
    let exists = lock(&state.db)
        .get(meeting_id)
        .ok()
        .flatten()
        .is_some();
    if !exists {
        return; // встреча удалена во время анализа
    }
    if let Err(e) = lock(&state.db).set_status(meeting_id, MeetingStatus::Error, Some(message)) {
        log::error!("не удалось записать ошибку встречи: {e}");
    }
    let _ = app.emit(
        events::ANALYSIS_ERROR,
        EvAnalysisError {
            meeting_id: meeting_id.to_string(),
            message: message.to_string(),
        },
    );
    emit_meetings_changed(app);
}

fn run_analysis(app: &AppHandle, job: &AnalyzeJob, pid_slot: &Arc<Mutex<Option<u32>>>) -> Result<()> {
    let state = app.state::<AppState>();
    let paths = state.paths.clone();
    let settings = state.settings();
    let Some(row) = lock(&state.db).get(&job.meeting_id)? else {
        return Ok(()); // удалена, пока ждала очереди
    };
    let id = row.id.clone();
    let launcher = find_launcher(&settings).ok_or_else(|| {
        anyhow!(
            "Python движка не найден. Создайте engine/.venv (uv sync) или укажите путь к python в настройках"
        )
    })?;
    let mic = paths.mic_wav(&id);
    if !mic.is_file() {
        anyhow::bail!("Нет файла записи микрофона ({})", mic.display());
    }
    let report_path = paths.report_json(&id);

    let mut cmd = launcher.command(&settings, &paths.data_dir);
    cmd.arg("analyze").arg("--mic").arg(&mic);
    let system = paths.system_wav(&id);
    if row.has_system_track && system.is_file() {
        cmd.arg("--system").arg(&system);
    }
    cmd.arg("--out")
        .arg(&report_path)
        .arg("--meeting-id")
        .arg(&id)
        .arg("--started-at")
        .arg(&row.started_at);
    if row.type_source == TypeSource::User {
        cmd.arg("--meeting-type").arg(row.meeting_type.as_str());
    }
    if let Some(t) = row.title.as_deref().filter(|t| !t.trim().is_empty()) {
        cmd.arg("--title").arg(t);
    }
    if let Some(t) = &row.training_task_id {
        cmd.arg("--training-task").arg(t);
    }
    let baseline = paths.baseline_path();
    if baseline.is_file() {
        cmd.arg("--baseline").arg(&baseline);
    } else {
        // пока базы нет — сколько встреч уже готово (для BaselineComparison.status = calibrating)
        let ready = lock(&state.db).count_ready_non_training().unwrap_or(0);
        cmd.arg("--calibration-meetings").arg(ready.to_string());
    }
    let llm = if job.llm {
        settings.llm_backend
    } else {
        LlmBackend::None
    };
    cmd.arg("--llm").arg(llm.as_str());
    cmd.arg("--llm-model").arg(&settings.llm_model);
    cmd.arg("--asr-model")
        .arg(&settings.asr_model)
        .arg("--compute-type")
        .arg(&settings.asr_compute_type)
        .arg("--language")
        .arg(&settings.language);

    let log_path = paths.engine_log(&id);
    let app_ev = app.clone();
    let id_ev = id.clone();
    let outcome = run_streaming(
        cmd,
        RunOptions {
            stderr_log: &log_path,
            append_log: false,
            timeout: None,
            pid_slot: Some(pid_slot.clone()),
        },
        |ev| {
            if let EngineEvent::Progress { stage, pct, message } = ev {
                let _ = app_ev.emit(
                    events::ANALYSIS_PROGRESS,
                    EvAnalysisProgress {
                        meeting_id: id_ev.clone(),
                        stage: stage.clone(),
                        pct: *pct,
                        message: message.clone(),
                    },
                );
            }
        },
    )?;

    // встречу могли удалить, пока шёл анализ
    if lock(&state.db).get(&id)?.is_none() {
        return Ok(());
    }

    if outcome.succeeded() && report_path.is_file() {
        let report = read_json(&report_path)?;
        let summary = summarize_report(&report);
        lock(&state.db).apply_report(&id, &summary)?;
        let _ = app.emit(
            events::ANALYSIS_DONE,
            EvAnalysisDone {
                meeting_id: id.clone(),
                score: summary.score,
            },
        );
        emit_meetings_changed(app);
        {
            let title = row.title.clone().unwrap_or_else(|| "встреча".to_string());
            let body = match summary.score {
                Some(s) => format!("{title} · оценка {}", s.round() as i64),
                None => title,
            };
            crate::util::notify(app, "Ремарка: разбор готов", &body);
        }
        match maybe_build_baseline(app) {
            Ok(true) => log::info!("baseline.json построен"),
            Ok(false) => {}
            Err(e) => log::warn!("не удалось построить baseline: {e:#}"),
        }
        Ok(())
    } else {
        let msg = outcome.failure_message(&log_path);
        fail_meeting(app, &id, &msg);
        Ok(())
    }
}

/// При выходе из приложения: снять очередь и остановить запущенный движок,
/// чтобы осиротевший python не грузил процессор после закрытия Ремарки.
pub fn shutdown(app: &AppHandle) {
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let running = {
        let mut q = lock(&state.engine);
        q.pending.clear();
        q.running.as_ref().and_then(|(_, pid)| *lock(pid))
    };
    if let Some(pid) = running {
        log::info!("выход: останавливаю движок (pid {pid})");
        terminate_pid(pid);
        let t = std::time::Instant::now();
        while t.elapsed() < Duration::from_secs(3) {
            // ESRCH (процесс исчез) — kill(pid, 0) вернёт -1
            if unsafe { libc::kill(pid as libc::pid_t, 0) } != 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc::kill(pid as libc::pid_t, libc::SIGKILL);
        }
    }
}

/// Пересчёт готового отчёта под другой тип встречи (без повторного распознавания): `rescore`.
pub fn rescore(app: &AppHandle, meeting_id: &str, meeting_type: MeetingType) -> Result<()> {
    let state = app.state::<AppState>();
    let paths = state.paths.clone();
    let settings = state.settings();
    let launcher = find_launcher(&settings).ok_or_else(|| anyhow!("Python движка не найден"))?;
    let report_path = paths.report_json(meeting_id);
    if !report_path.is_file() {
        anyhow::bail!("Отчёт ещё не построен");
    }
    let mut cmd = launcher.command(&settings, &paths.data_dir);
    cmd.arg("rescore")
        .arg("--report")
        .arg(&report_path)
        .arg("--meeting-type")
        .arg(meeting_type.as_str())
        .arg("--type-source")
        .arg("user");
    let baseline = paths.baseline_path();
    if baseline.is_file() {
        cmd.arg("--baseline").arg(&baseline);
    } else {
        let ready = lock(&state.db).count_ready_non_training().unwrap_or(0);
        cmd.arg("--calibration-meetings").arg(ready.to_string());
    }
    let log_path = paths.engine_log(meeting_id);
    let outcome = run_streaming(
        cmd,
        RunOptions { stderr_log: &log_path, append_log: true, timeout: Some(Duration::from_secs(60)), pid_slot: None },
        |_| {},
    )?;
    if !outcome.succeeded() {
        anyhow::bail!("{}", outcome.failure_message(&log_path));
    }
    let report = read_json(&report_path)?;
    lock(&state.db).apply_report(meeting_id, &summarize_report(&report))?;
    Ok(())
}

/// Снимает задачу с очереди или посылает SIGTERM запущенному анализу.
pub fn cancel(app: &AppHandle, meeting_id: &str) -> bool {
    let state = app.state::<AppState>();
    let mut q = lock(&state.engine);
    let before = q.pending.len();
    q.pending.retain(|j| j.meeting_id != meeting_id);
    if q.pending.len() != before {
        return true;
    }
    if let Some((id, pid)) = &q.running {
        if id == meeting_id {
            if let Some(pid) = *lock(pid) {
                terminate_pid(pid);
            }
            return true;
        }
    }
    false
}

pub fn read_json(path: &Path) -> Result<Value> {
    let text = std::fs::read_to_string(path)
        .with_context(|| format!("не удалось прочитать {}", path.display()))?;
    serde_json::from_str(&text).with_context(|| format!("{} — некорректный JSON", path.display()))
}

fn metric_value(report: &Value, layer: &str, name: &str) -> Option<f64> {
    report
        .get("metrics")?
        .get(layer)?
        .get(name)?
        .get("value")?
        .as_f64()
}

/// Денормализация report.json для карточек.
pub fn summarize_report(report: &Value) -> ReportSummary {
    let meeting = report.get("meeting");
    let llm_type = meeting
        .filter(|m| m.get("type_source").and_then(Value::as_str) == Some("llm"))
        .and_then(|m| m.get("type"))
        .and_then(Value::as_str)
        .and_then(MeetingType::parse);
    ReportSummary {
        score: report
            .get("score")
            .and_then(|s| s.get("overall"))
            .and_then(Value::as_f64),
        wpm: metric_value(report, "layer1", "wpm"),
        filled_pauses_per_min: metric_value(report, "layer1", "filled_pauses_per_min"),
        talk_ratio: metric_value(report, "layer1", "talk_ratio"),
        duration_sec: meeting
            .and_then(|m| m.get("duration_sec"))
            .and_then(Value::as_f64),
        llm_type,
    }
}

// ---------------------------------------------------------------------------
// baseline / doctor / prepare / patterns
// ---------------------------------------------------------------------------

/// Строит baseline.json из первых трёх готовых встреч (тип ≠ training), если его ещё нет.
pub fn maybe_build_baseline(app: &AppHandle) -> Result<bool> {
    let state = app.state::<AppState>();
    let paths = state.paths.clone();
    if paths.baseline_path().is_file() {
        return Ok(false);
    }
    let rows = lock(&state.db).ready_rows()?;
    let reports: Vec<PathBuf> = rows
        .iter()
        .filter(|r| r.meeting_type != MeetingType::Training)
        .map(|r| paths.report_json(&r.id))
        .filter(|p| p.is_file())
        .take(BASELINE_MEETINGS_NEEDED as usize)
        .collect();
    if reports.len() < BASELINE_MEETINGS_NEEDED as usize {
        return Ok(false);
    }
    let settings = state.settings();
    let launcher = find_launcher(&settings).ok_or_else(|| anyhow!("Python движка не найден"))?;
    let mut cmd = launcher.command(&settings, &paths.data_dir);
    cmd.arg("baseline").arg("--reports");
    for r in &reports {
        cmd.arg(r);
    }
    cmd.arg("--out").arg(paths.baseline_path());
    let log_path = paths.engine_shared_log();
    let outcome = run_streaming(
        cmd,
        RunOptions {
            stderr_log: &log_path,
            append_log: true,
            timeout: Some(Duration::from_secs(120)),
            pid_slot: None,
        },
        |_| {},
    )?;
    if paths.baseline_path().is_file() && outcome.error.is_none() {
        Ok(true)
    } else {
        Err(anyhow!(outcome.failure_message(&log_path)))
    }
}

#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct DoctorLine {
    ok: bool,
    python: Option<String>,
    engine_version: Option<String>,
    asr_model_cached: bool,
    llm_backend_available: bool,
    messages: Vec<String>,
}

fn doctor_unavailable(python: Option<String>, messages: Vec<String>) -> EngineDoctor {
    EngineDoctor {
        ok: false,
        python,
        engine_version: None,
        asr_model_cached: false,
        llm_backend_available: false,
        messages,
    }
}

pub fn doctor(app: &AppHandle) -> EngineDoctor {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let paths = state.paths.clone();
    let Some(launcher) = find_launcher(&settings) else {
        return doctor_unavailable(
            None,
            vec![
                "Python движка не найден. Создайте окружение engine/.venv (uv sync) или укажите путь к python в настройках."
                    .to_string(),
            ],
        );
    };
    let python = launcher.python_display();
    let mut cmd = launcher.command(&settings, &paths.data_dir);
    cmd.args([
        "doctor",
        "--asr-model",
        &settings.asr_model,
        "--llm",
        settings.llm_backend.as_str(),
    ]);
    let log_path = paths.engine_shared_log();
    match run_streaming(
        cmd,
        RunOptions {
            stderr_log: &log_path,
            append_log: true,
            timeout: Some(Duration::from_secs(180)),
            pid_slot: None,
        },
        |_| {},
    ) {
        Ok(outcome) => match outcome.doctor {
            Some(v) => {
                let d: DoctorLine = serde_json::from_value(v).unwrap_or_default();
                EngineDoctor {
                    ok: d.ok,
                    python: d.python.or(Some(python)),
                    engine_version: d.engine_version,
                    asr_model_cached: d.asr_model_cached,
                    llm_backend_available: d.llm_backend_available,
                    messages: d.messages,
                }
            }
            None => doctor_unavailable(
                Some(python),
                vec![
                    "Движок не ответил на doctor — возможно, пакет remarka_engine не установлен."
                        .to_string(),
                    outcome.failure_message(&log_path),
                ],
            ),
        },
        Err(e) => doctor_unavailable(Some(python), vec![format!("{e:#}")]),
    }
}

/// `prepare --topic … --type … --out …` → PrepResult как JSON.
pub fn prepare(app: &AppHandle, topic: &str, meeting_type: MeetingType) -> Result<Value> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let paths = state.paths.clone();
    let launcher = find_launcher(&settings)
        .ok_or_else(|| anyhow!("Python движка не найден — проверьте движок в настройках"))?;
    std::fs::create_dir_all(paths.prep_dir())?;
    let out = paths
        .prep_dir()
        .join(format!("{}.json", uuid::Uuid::new_v4()));
    let mut cmd = launcher.command(&settings, &paths.data_dir);
    cmd.arg("prepare")
        .arg("--topic")
        .arg(topic)
        .arg("--type")
        .arg(meeting_type.as_str())
        .arg("--out")
        .arg(&out)
        .arg("--llm")
        .arg(settings.llm_backend.as_str())
        .arg("--llm-model")
        .arg(&settings.llm_model);
    let log_path = paths.engine_shared_log();
    let outcome = run_streaming(
        cmd,
        RunOptions {
            stderr_log: &log_path,
            append_log: true,
            timeout: Some(Duration::from_secs(400)),
            pid_slot: None,
        },
        |_| {},
    )?;
    if out.is_file() && outcome.error.is_none() {
        read_json(&out)
    } else {
        Err(anyhow!(outcome.failure_message(&log_path)))
    }
}

/// `patterns --reports … --out patterns.json` по последним готовым встречам.
pub fn refresh_patterns(app: &AppHandle) -> Result<Value> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let paths = state.paths.clone();
    let launcher = find_launcher(&settings)
        .ok_or_else(|| anyhow!("Python движка не найден — проверьте движок в настройках"))?;
    let rows = lock(&state.db).ready_rows()?;
    let mut reports: Vec<PathBuf> = rows
        .iter()
        .map(|r| paths.report_json(&r.id))
        .filter(|p| p.is_file())
        .collect();
    if reports.is_empty() {
        anyhow::bail!("Пока нет готовых разборов — паттерны строятся по готовым встречам");
    }
    if reports.len() > PATTERNS_MAX_REPORTS {
        reports = reports.split_off(reports.len() - PATTERNS_MAX_REPORTS);
    }
    let mut cmd = launcher.command(&settings, &paths.data_dir);
    cmd.arg("patterns").arg("--reports");
    for r in &reports {
        cmd.arg(r);
    }
    cmd.arg("--out")
        .arg(paths.patterns_path())
        .arg("--llm")
        .arg(settings.llm_backend.as_str())
        .arg("--llm-model")
        .arg(&settings.llm_model);
    let log_path = paths.engine_shared_log();
    let outcome = run_streaming(
        cmd,
        RunOptions {
            stderr_log: &log_path,
            append_log: true,
            timeout: Some(Duration::from_secs(400)),
            pid_slot: None,
        },
        |_| {},
    )?;
    if paths.patterns_path().is_file() && outcome.error.is_none() {
        read_json(&paths.patterns_path())
    } else {
        Err(anyhow!(outcome.failure_message(&log_path)))
    }
}

/// `download-model --asr-model NAME` — заранее скачать модель ASR в кэш HF. Долго (гигабайты).
pub fn download_model(app: &AppHandle, asr_model: &str) -> Result<()> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let paths = state.paths.clone();
    let launcher = find_launcher(&settings)
        .ok_or_else(|| anyhow!("Python движка не найден — проверьте движок в настройках"))?;
    let mut cmd = launcher.command(&settings, &paths.data_dir);
    cmd.args(["download-model", "--asr-model", asr_model]);
    let log_path = paths.engine_shared_log();
    let outcome = run_streaming(
        cmd,
        RunOptions {
            stderr_log: &log_path,
            append_log: true,
            timeout: Some(Duration::from_secs(3 * 3600)),
            pid_slot: None,
        },
        |_| {},
    )?;
    if outcome.exit_code == Some(0) && outcome.error.is_none() {
        Ok(())
    } else {
        Err(anyhow!(outcome.failure_message(&log_path)))
    }
}

pub fn read_optional_json(path: &Path) -> Result<Option<Value>> {
    if !path.is_file() {
        return Ok(None);
    }
    read_json(path).map(Some)
}

/// Каталог данных движка (для training_tasks.json), если движок рядом.
pub fn engine_data_dir(settings: &Settings) -> Option<PathBuf> {
    match find_launcher(settings)? {
        Launcher::Python { engine_dir, .. } => engine_dir.map(|d| d.join("remarka_engine").join("data")),
        Launcher::Sidecar(_) => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_protocol_lines() {
        let ev = parse_event(r#"{"event":"progress","stage":"asr","pct":42,"message":"Распознавание: 13:20 из 32:10"}"#)
            .unwrap();
        assert_eq!(
            ev,
            EngineEvent::Progress {
                stage: "asr".into(),
                pct: 42.0,
                message: "Распознавание: 13:20 из 32:10".into()
            }
        );
        assert_eq!(
            parse_event(r#"{"event":"log","level":"warn","message":"x"}"#).unwrap(),
            EngineEvent::Log { level: "warn".into(), message: "x".into() }
        );
        assert_eq!(
            parse_event(r#"{"event":"done","out":"/tmp/report.json"}"#).unwrap(),
            EngineEvent::Done { out: "/tmp/report.json".into() }
        );
        assert_eq!(
            parse_event(r#"{"event":"error","message":"cancelled","stage":null}"#).unwrap(),
            EngineEvent::Error { message: "cancelled".into(), stage: None }
        );
        assert_eq!(
            parse_event(r#"{"event":"error","message":"boom","stage":"asr"}"#).unwrap(),
            EngineEvent::Error { message: "boom".into(), stage: Some("asr".into()) }
        );
        match parse_event(r#"{"event":"doctor","ok":true,"python":"/x/python","messages":[]}"#).unwrap() {
            EngineEvent::Doctor(v) => assert_eq!(v["ok"], true),
            other => panic!("{other:?}"),
        }
        match parse_event(r#"{"event":"heartbeat","n":1}"#).unwrap() {
            EngineEvent::Other(kind, _) => assert_eq!(kind, "heartbeat"),
            other => panic!("{other:?}"),
        }
        assert_eq!(parse_event("100%|██████| tqdm noise"), None);
        assert_eq!(parse_event("{not json"), None);
        assert_eq!(parse_event(r#"{"no_event":1}"#), None);
        assert_eq!(parse_event(""), None);
    }

    /// Настоящий stdout движка (`analyze` на fixtures, `--asr-model small --llm claude_cli`
    /// без авторизации CLI): все строки разбираются, стадии идут по контракту §3.1,
    /// pct не убывает, в конце — `done`.
    #[test]
    fn parses_real_engine_stdout_fixture() {
        const REAL: &str = include_str!("../tests/fixtures/engine_stdout.jsonl");
        const ORDER: [&str; 10] = [
            "load", "vad", "asr", "align", "fillers", "prosody", "metrics", "meaning", "summary", "write",
        ];
        let mut outcome = RunOutcome::default();
        let mut last_pct = -1.0_f64;
        let mut last_stage_idx = 0usize;
        let mut progress_n = 0;
        let mut warn_n = 0;
        let mut lines = 0;
        for line in REAL.lines().filter(|l| !l.trim().is_empty()) {
            lines += 1;
            let parsed = parse_event(line);
            assert!(parsed.is_some(), "строка движка не разобрана: {line}");
            handle_line(line, &mut outcome, &mut |ev| match ev {
                EngineEvent::Progress { stage, pct, message } => {
                    progress_n += 1;
                    let idx = ORDER.iter().position(|s| s == stage).unwrap_or_else(|| panic!("неизвестная стадия {stage}"));
                    assert!(idx >= last_stage_idx, "стадия {stage} после {}", ORDER[last_stage_idx]);
                    last_stage_idx = idx;
                    assert!((0.0..=100.0).contains(pct), "pct вне 0–100: {pct}");
                    assert!(*pct >= last_pct, "pct убывает: {pct} после {last_pct}");
                    last_pct = *pct;
                    assert!(!message.is_empty());
                }
                EngineEvent::Log { level, .. } => {
                    if level == "warn" {
                        warn_n += 1;
                    }
                }
                _ => {}
            });
        }
        assert!(lines >= 20, "фикстура слишком короткая: {lines}");
        assert!(progress_n >= 15, "{progress_n}");
        assert!(warn_n >= 1, "ожидалось предупреждение слоя смысла (CLI не авторизован)");
        assert_eq!(last_pct, 100.0);
        assert_eq!(ORDER[last_stage_idx], "write");
        assert!(outcome.succeeded(), "{outcome:?}");
        assert!(outcome.done_out.as_deref().unwrap().ends_with(".json"));
        assert_eq!(outcome.stdout_lines, lines);
    }

    #[test]
    fn extended_path_keeps_existing_and_adds_homebrew() {
        let p = extended_path();
        let parts: Vec<&str> = p.split(':').collect();
        for orig in std::env::var("PATH").unwrap_or_default().split(':').filter(|s| !s.is_empty()) {
            assert!(parts.contains(&orig), "потерян {orig}");
        }
        if Path::new("/opt/homebrew/bin").is_dir() {
            assert!(parts.contains(&"/opt/homebrew/bin"));
            assert_eq!(parts.iter().filter(|p| **p == "/opt/homebrew/bin").count(), 1, "дубликат");
        }
    }

    #[test]
    fn run_streaming_collects_outcome_and_stderr() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("engine.log");
        let script = r#"
import sys
print('{"event":"progress","stage":"load","pct":2,"message":"Читаю"}', flush=True)
print('warning from lib', file=sys.stderr)
print('not json', flush=True)
print('{"event":"log","level":"info","message":"ok"}', flush=True)
print('{"event":"done","out":"/tmp/r.json"}', flush=True)
"#;
        let mut cmd = Command::new("python3");
        cmd.arg("-c").arg(script);
        let mut seen = Vec::new();
        let outcome = run_streaming(
            cmd,
            RunOptions { stderr_log: &log, append_log: false, timeout: Some(Duration::from_secs(30)), pid_slot: None },
            |ev| seen.push(ev.clone()),
        )
        .unwrap();
        assert!(outcome.succeeded(), "{outcome:?}");
        assert_eq!(outcome.exit_code, Some(0));
        assert_eq!(outcome.done_out.as_deref(), Some("/tmp/r.json"));
        assert_eq!(seen.len(), 3);
        assert!(std::fs::read_to_string(&log).unwrap().contains("warning from lib"));
    }

    #[test]
    fn run_streaming_timeout_terminates() {
        let dir = tempfile::tempdir().unwrap();
        let log = dir.path().join("engine.log");
        let mut cmd = Command::new("python3");
        cmd.arg("-c").arg("import time\nprint('{\"event\":\"progress\",\"stage\":\"asr\",\"pct\":1,\"message\":\"\"}', flush=True)\ntime.sleep(30)");
        let pid = Arc::new(Mutex::new(None));
        let t = Instant::now();
        let outcome = run_streaming(
            cmd,
            RunOptions { stderr_log: &log, append_log: false, timeout: Some(Duration::from_secs(2)), pid_slot: Some(pid.clone()) },
            |_| {},
        )
        .unwrap();
        assert!(outcome.timed_out);
        assert!(!outcome.succeeded());
        assert!(t.elapsed() < Duration::from_secs(10));
        assert!(lock(&pid).is_none());
        let msg = outcome.failure_message(&log);
        assert!(msg.contains("не ответил"), "{msg}");
    }

    #[test]
    fn summarize_report_extracts_card_fields() {
        let report = serde_json::json!({
            "meeting": {"duration_sec": 1930.5, "type": "pitch", "type_source": "llm"},
            "metrics": {"layer1": {"wpm": {"value": 148.2}, "filled_pauses_per_min": {"value": 0.7}, "talk_ratio": {"value": null}}},
            "score": {"overall": 64}
        });
        let s = summarize_report(&report);
        assert_eq!(s.score, Some(64.0));
        assert_eq!(s.wpm, Some(148.2));
        assert_eq!(s.filled_pauses_per_min, Some(0.7));
        assert_eq!(s.talk_ratio, None);
        assert_eq!(s.duration_sec, Some(1930.5));
        assert_eq!(s.llm_type, Some(MeetingType::Pitch));

        let user_typed = serde_json::json!({"meeting": {"type": "demo", "type_source": "user"}, "score": {"overall": 70}});
        assert_eq!(summarize_report(&user_typed).llm_type, None);
    }

    #[test]
    fn launcher_builds_command_with_env() {
        let s = Settings { anthropic_api_key: Some(" sk-test ".into()), ..Default::default() };
        let l = Launcher::Python { python: PathBuf::from("/usr/bin/python3"), engine_dir: None };
        let cmd = l.command(&s, Path::new("/tmp"));
        let envs: Vec<_> = cmd.get_envs().map(|(k, v)| (k.to_string_lossy().to_string(), v.map(|v| v.to_string_lossy().to_string()))).collect();
        assert!(envs.iter().any(|(k, v)| k == "ANTHROPIC_API_KEY" && v.as_deref() == Some("sk-test")));
        assert!(envs.iter().any(|(k, _)| k == "PYTHONUNBUFFERED"));
        let args: Vec<_> = cmd.get_args().map(|a| a.to_string_lossy().to_string()).collect();
        assert_eq!(args, vec!["-m", "remarka_engine"]);
        assert_eq!(cmd.get_current_dir(), Some(Path::new("/tmp")));
    }
}
