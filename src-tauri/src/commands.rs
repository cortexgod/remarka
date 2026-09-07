//! `#[tauri::command]` (§6.1). Все возвращают `Result<T, String>`; JSON-поля и
//! аргументы команд — snake_case (`rename_all = "snake_case"`), как в contracts.ts.

use crate::audio::{self, StartParams};
use crate::capture;
use crate::db::NewMeeting;
use crate::engine::{self, AnalyzeJob};
use crate::models::{
    events, AppStateInfo, AudioDevice, EngineDoctor, EvRecordingStarted, EvRecordingStopped,
    ImportAudioOpts, LlmBackend, MeetingCard, MeetingIdResponse, MeetingStatus, MeetingType,
    ProgressData, RecordingState, Settings, StartRecordingOpts, TrainingTask, TypeSource,
};
use crate::paths::is_valid_meeting_id;
use crate::state::AppState;
use crate::util::{lock, now_iso};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition, State};
use tauri_plugin_opener::OpenerExt;

type CmdResult<T> = Result<T, String>;

fn err<E: std::fmt::Display>(e: E) -> String {
    format!("{e:#}")
}

fn check_id(id: &str) -> CmdResult<()> {
    if is_valid_meeting_id(id) {
        Ok(())
    } else {
        Err(format!("Некорректный идентификатор встречи: {id}"))
    }
}

fn platform_name() -> String {
    if cfg!(target_os = "macos") {
        "macos"
    } else if cfg!(target_os = "windows") {
        "windows"
    } else {
        "linux"
    }
    .to_string()
}

fn emit_meetings_changed(app: &AppHandle) {
    let _ = app.emit(events::MEETINGS_CHANGED, ());
}

// ---------------------------------------------------------------------------
// Окна
// ---------------------------------------------------------------------------

pub fn show_main(app: &AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

/// Показывает/прячет оверлей; при показе ставит в правый верхний угол основного монитора.
pub fn set_overlay(app: &AppHandle, visible: bool) {
    let Some(w) = app.get_webview_window("overlay") else {
        return;
    };
    if !visible {
        let _ = w.hide();
        return;
    }
    if let Ok(Some(mon)) = app.primary_monitor() {
        let scale = mon.scale_factor();
        let area = mon.work_area();
        let width = (280.0 * scale).round() as i32;
        let margin = (16.0 * scale).round() as i32;
        let x = area.position.x + area.size.width as i32 - width - margin;
        let y = area.position.y + margin;
        let _ = w.set_position(PhysicalPosition::new(x, y));
    }
    let _ = w.set_always_on_top(true);
    let _ = w.show();
}

// ---------------------------------------------------------------------------
// Запись (общие функции — используются командами и треем)
// ---------------------------------------------------------------------------

fn recording_state(state: &AppState) -> Option<RecordingState> {
    let guard = lock(&state.recorder);
    guard.as_ref().map(|r| RecordingState {
        meeting_id: r.meeting_id.clone(),
        started_at: r.started_at.clone(),
        elapsed_sec: r.elapsed_sec(),
        system_audio: r.system_audio,
        level_db: r.level_db(),
        system_level_db: r.system_level_db(),
        wpm_estimate: r.wpm_estimate(),
    })
}

pub fn do_start_recording(app: &AppHandle, opts: StartRecordingOpts) -> CmdResult<String> {
    let state = app.state::<AppState>();
    if state.is_recording() {
        return Err("Запись уже идёт".to_string());
    }
    if !state.try_begin_start() {
        return Err("Запись уже запускается".to_string());
    }
    let result = start_recording_inner(app, opts);
    state.end_start();
    result
}

fn start_recording_inner(app: &AppHandle, opts: StartRecordingOpts) -> CmdResult<String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let paths = state.paths.clone();

    let meeting_id = uuid::Uuid::new_v4().to_string();
    let started_at = now_iso();
    let training_task_id = opts
        .training_task_id
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);
    let (meeting_type, type_source) = match (opts.meeting_type, &training_task_id) {
        (Some(t), _) => (t, TypeSource::User),
        (None, Some(_)) => (MeetingType::Training, TypeSource::User),
        (None, None) => (MeetingType::Other, TypeSource::Default),
    };
    // тренировка — всегда без системного звука
    let system_wanted = opts.system_audio && training_task_id.is_none();
    let title = opts
        .title
        .as_deref()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .map(str::to_string);

    let dir = paths.meeting_dir(&meeting_id);
    std::fs::create_dir_all(&dir).map_err(err)?;

    // устройства открываем, не держа мьютекс recorder: старт может ждать системный запрос разрешения
    let max_duration_sec = training_task_id
        .as_deref()
        .and_then(|tid| load_training_tasks(&settings).into_iter().find(|t| t.id == tid))
        .map(|t| t.duration_sec)
        .filter(|d| *d > 0.0);
    let params = StartParams {
        meeting_id: meeting_id.clone(),
        started_at: started_at.clone(),
        mic_path: paths.mic_wav(&meeting_id),
        system_path: system_wanted.then(|| paths.system_wav(&meeting_id)),
        input_device: opts.input_device.clone().or(settings.input_device.clone()),
        max_duration_sec,
    };
    let rec = match audio::start_recording(app, params) {
        Ok(r) => r,
        Err(e) => {
            let _ = std::fs::remove_dir_all(&dir);
            return Err(e);
        }
    };
    let has_system = rec.system_audio;
    if let Err(e) = lock(&state.db).insert(&NewMeeting {
        id: meeting_id.clone(),
        started_at: started_at.clone(),
        duration_sec: 0.0,
        meeting_type,
        type_source,
        title,
        status: MeetingStatus::Recording,
        has_system_track: has_system,
        training_task_id,
    }) {
        let _ = rec.stop();
        let _ = std::fs::remove_dir_all(&dir);
        return Err(format!("Не удалось сохранить встречу в базу: {e:#}"));
    }
    {
        let mut guard = lock(&state.recorder);
        if guard.is_some() {
            drop(guard);
            let _ = rec.stop();
            let _ = lock(&state.db).delete(&meeting_id);
            let _ = std::fs::remove_dir_all(&dir);
            return Err("Запись уже идёт".to_string());
        }
        *guard = Some(rec);
    }
    let rec = has_system;

    let _ = app.emit(
        events::RECORDING_STARTED,
        EvRecordingStarted {
            meeting_id: meeting_id.clone(),
            started_at,
            system_audio: rec,
        },
    );
    emit_meetings_changed(app);
    if settings.show_overlay {
        set_overlay(app, true);
    }
    crate::tray::update(app);
    log::info!("запись начата: {meeting_id} (системный звук: {rec})");
    Ok(meeting_id)
}

pub fn do_stop_recording(app: &AppHandle) -> CmdResult<String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let paths = state.paths.clone();
    let rec = lock(&state.recorder)
        .take()
        .ok_or_else(|| "Запись не идёт".to_string())?;
    let meeting_id = rec.meeting_id.clone();
    let had_system = rec.system_audio;

    let finish = |duration: f64, status: MeetingStatus, error: Option<&str>| {
        let db = lock(&state.db);
        let _ = db.set_duration(&meeting_id, duration);
        let _ = db.set_status(&meeting_id, status, error);
    };

    let duration = match rec.stop() {
        Ok(info) => {
            if had_system {
                let ok = info.system_error.is_none()
                    && info.system_duration_sec.unwrap_or(0.0) > 0.0
                    && paths.system_wav(&meeting_id).is_file();
                if !ok {
                    log::warn!("системная дорожка не записалась: {:?}", info.system_error);
                    let _ = lock(&state.db).set_has_system_track(&meeting_id, false);
                }
            }
            finish(info.mic_duration_sec, MeetingStatus::Recorded, None);
            info.mic_duration_sec
        }
        Err(e) => {
            let dur = audio::wav_duration_sec(&paths.mic_wav(&meeting_id)).unwrap_or(0.0);
            let msg = format!("Запись микрофона прервалась: {e:#}");
            if dur > 0.5 {
                finish(dur, MeetingStatus::Recorded, None);
            } else {
                finish(dur, MeetingStatus::Error, Some(&msg));
            }
            let _ = app.emit(
                events::RECORDING_STOPPED,
                EvRecordingStopped { meeting_id: meeting_id.clone(), duration_sec: dur },
            );
            emit_meetings_changed(app);
            set_overlay(app, false);
            crate::tray::update(app);
            // записанное до обрыва разбираем как обычно
            if dur > 0.5 && settings.auto_analyze {
                let _ = engine::enqueue(
                    app,
                    AnalyzeJob { meeting_id: meeting_id.clone(), llm: settings.llm_backend != LlmBackend::None },
                );
            }
            return Err(msg);
        }
    };

    let _ = app.emit(
        events::RECORDING_STOPPED,
        EvRecordingStopped { meeting_id: meeting_id.clone(), duration_sec: duration },
    );
    emit_meetings_changed(app);
    set_overlay(app, false);
    crate::tray::update(app);
    log::info!("запись остановлена: {meeting_id}, {duration:.1} с");

    if settings.auto_analyze {
        if let Err(e) = engine::enqueue(
            app,
            AnalyzeJob {
                meeting_id: meeting_id.clone(),
                llm: settings.llm_backend != LlmBackend::None,
            },
        ) {
            log::error!("не удалось поставить анализ в очередь: {e:#}");
        }
    }
    Ok(meeting_id)
}

pub fn do_cancel_recording(app: &AppHandle) -> CmdResult<()> {
    let state = app.state::<AppState>();
    let rec = lock(&state.recorder)
        .take()
        .ok_or_else(|| "Запись не идёт".to_string())?;
    let meeting_id = rec.meeting_id.clone();
    let _ = rec.stop();
    let _ = lock(&state.db).delete(&meeting_id);
    let _ = std::fs::remove_dir_all(state.paths.meeting_dir(&meeting_id));
    let _ = app.emit(
        events::RECORDING_STOPPED,
        EvRecordingStopped { meeting_id: meeting_id.clone(), duration_sec: 0.0 },
    );
    emit_meetings_changed(app);
    set_overlay(app, false);
    crate::tray::update(app);
    log::info!("запись отменена: {meeting_id}");
    Ok(())
}

/// Пункт меню трея «Начать/Остановить запись».
pub fn tray_toggle_recording(app: &AppHandle) {
    let state = app.state::<AppState>();
    let result = if state.is_recording() {
        do_stop_recording(app).map(|_| ())
    } else {
        let settings = state.settings();
        do_start_recording(
            app,
            StartRecordingOpts {
                system_audio: settings.system_audio_default,
                ..Default::default()
            },
        )
        .map(|_| ())
    };
    if let Err(e) = result {
        log::error!("трей: {e}");
        show_main(app);
    }
}

/// Перед выходом: корректно закрыть WAV, если шла запись (без анализа).
pub fn shutdown(app: &AppHandle) {
    engine::shutdown(app);
    let Some(state) = app.try_state::<AppState>() else {
        return;
    };
    let rec = lock(&state.recorder).take();
    if let Some(rec) = rec {
        let id = rec.meeting_id.clone();
        match rec.stop() {
            Ok(info) => {
                let db = lock(&state.db);
                let _ = db.set_duration(&id, info.mic_duration_sec);
                let _ = db.set_status(&id, MeetingStatus::Recorded, None);
            }
            Err(e) => log::error!("остановка записи при выходе: {e:#}"),
        }
    }
}

// ---------------------------------------------------------------------------
// Команды
// ---------------------------------------------------------------------------

#[tauri::command(rename_all = "snake_case")]
pub fn get_app_state(state: State<'_, AppState>) -> CmdResult<AppStateInfo> {
    let settings = state.settings();
    Ok(AppStateInfo {
        recording: recording_state(&state),
        analyzing: lock(&state.engine).analyzing_ids(),
        engine_ok: engine::engine_ok(&settings),
        platform: platform_name(),
        system_audio_supported: capture::supported(),
        meeting_app_running: lock(&state.meeting_app).clone(),
        data_dir: state.paths.data_dir.display().to_string(),
    })
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_audio_devices() -> CmdResult<Vec<AudioDevice>> {
    audio::mic::list_devices().map_err(err)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn start_recording(app: AppHandle, opts: StartRecordingOpts) -> CmdResult<MeetingIdResponse> {
    let meeting_id = tauri::async_runtime::spawn_blocking(move || do_start_recording(&app, opts))
        .await
        .map_err(err)??;
    Ok(MeetingIdResponse { meeting_id })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn stop_recording(app: AppHandle) -> CmdResult<MeetingIdResponse> {
    let meeting_id = tauri::async_runtime::spawn_blocking(move || do_stop_recording(&app))
        .await
        .map_err(err)??;
    Ok(MeetingIdResponse { meeting_id })
}

#[tauri::command(rename_all = "snake_case")]
pub async fn cancel_recording(app: AppHandle) -> CmdResult<()> {
    tauri::async_runtime::spawn_blocking(move || do_cancel_recording(&app))
        .await
        .map_err(err)?
}

#[tauri::command(rename_all = "snake_case")]
pub fn list_meetings(state: State<'_, AppState>) -> CmdResult<Vec<MeetingCard>> {
    lock(&state.db).cards().map_err(err)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_meeting(state: State<'_, AppState>, id: String) -> CmdResult<MeetingCard> {
    check_id(&id)?;
    lock(&state.db)
        .card(&id)
        .map_err(err)?
        .ok_or_else(|| "Встреча не найдена".to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_report(state: State<'_, AppState>, id: String) -> CmdResult<Value> {
    check_id(&id)?;
    let path = state.paths.report_json(&id);
    if !path.is_file() {
        return Err("Разбор этой встречи ещё не готов".to_string());
    }
    engine::read_json(&path).map_err(err)
}

#[tauri::command(rename_all = "snake_case")]
pub fn analyze_meeting(app: AppHandle, state: State<'_, AppState>, id: String, llm: Option<bool>) -> CmdResult<()> {
    check_id(&id)?;
    let row = lock(&state.db)
        .get(&id)
        .map_err(err)?
        .ok_or_else(|| "Встреча не найдена".to_string())?;
    if row.status == MeetingStatus::Recording {
        return Err("Встреча ещё записывается".to_string());
    }
    if !state.paths.mic_wav(&id).is_file() {
        return Err("Нет файла записи микрофона — анализировать нечего".to_string());
    }
    let settings = state.settings();
    let llm = llm.unwrap_or(settings.llm_backend != LlmBackend::None);
    engine::enqueue(&app, AnalyzeJob { meeting_id: id, llm }).map_err(err)
}

#[tauri::command(rename_all = "snake_case")]
pub fn delete_meeting(app: AppHandle, state: State<'_, AppState>, id: String) -> CmdResult<()> {
    check_id(&id)?;
    if state.recording_id().as_deref() == Some(id.as_str()) {
        return Err("Эта встреча сейчас записывается — сначала остановите запись".to_string());
    }
    engine::cancel(&app, &id);
    lock(&state.db).delete(&id).map_err(err)?;
    let dir = state.paths.meeting_dir(&id);
    if dir.is_dir() {
        std::fs::remove_dir_all(&dir).map_err(err)?;
    }
    emit_meetings_changed(&app);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn update_meeting(
    app: AppHandle,
    state: State<'_, AppState>,
    id: String,
    title: Option<String>,
    meeting_type: Option<MeetingType>,
) -> CmdResult<MeetingCard> {
    check_id(&id)?;
    let rescore_type = {
        let db = lock(&state.db);
        let Some(row) = db.get(&id).map_err(err)? else {
            return Err("Встреча не найдена".to_string());
        };
        db.update_meta(&id, title.as_deref().map(str::trim), meeting_type)
            .map_err(err)?;
        // тип изменился у готовой встречи → ориентиры, статусы и оценка в отчёте пересчитываются движком
        meeting_type.filter(|t| row.status == MeetingStatus::Ready && (*t != row.meeting_type || row.type_source != TypeSource::User))
    };
    if let Some(t) = rescore_type {
        engine::rescore(&app, &id, t).map_err(|e| format!("Тип сохранён, но пересчитать отчёт не удалось: {e:#}"))?;
    }
    let card = lock(&state.db)
        .card(&id)
        .map_err(err)?
        .ok_or_else(|| "Встреча не найдена".to_string())?;
    emit_meetings_changed(&app);
    Ok(card)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_audio_path(state: State<'_, AppState>, id: String, track: String) -> CmdResult<String> {
    check_id(&id)?;
    let path = match track.as_str() {
        "mic" => state.paths.mic_wav(&id),
        "system" => state.paths.system_wav(&id),
        other => return Err(format!("Неизвестная дорожка: {other}")),
    };
    if !path.is_file() {
        return Err("Аудиофайл не найден".to_string());
    }
    Ok(path.display().to_string())
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_progress(state: State<'_, AppState>) -> CmdResult<ProgressData> {
    crate::progress::build(&state).map_err(err)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_baseline(state: State<'_, AppState>) -> CmdResult<Option<Value>> {
    engine::read_optional_json(&state.paths.baseline_path()).map_err(err)
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_settings(state: State<'_, AppState>) -> CmdResult<Settings> {
    Ok(state.settings())
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_settings(app: AppHandle, state: State<'_, AppState>, patch: Value) -> CmdResult<Settings> {
    let updated = {
        let mut guard = lock(&state.settings);
        let updated = crate::settings::apply_patch(&guard, &patch).map_err(err)?;
        crate::settings::save(&state.paths.settings_path(), &updated).map_err(err)?;
        *guard = updated.clone();
        updated
    };
    let _ = app.emit(events::SETTINGS_CHANGED, updated.clone());
    crate::tray::update(&app);
    Ok(updated)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn engine_doctor(app: AppHandle) -> CmdResult<EngineDoctor> {
    tauri::async_runtime::spawn_blocking(move || engine::doctor(&app))
        .await
        .map_err(err)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn prepare_meeting(app: AppHandle, topic: String, meeting_type: MeetingType) -> CmdResult<Value> {
    let topic = topic.trim().to_string();
    if topic.is_empty() {
        return Err("Опишите тему или повестку встречи".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || engine::prepare(&app, &topic, meeting_type).map_err(err))
        .await
        .map_err(err)?
}

/// Вне §6.1 (по запросу фронтенда): скачать модель ASR заранее. Блокирует до конца загрузки.
#[tauri::command(rename_all = "snake_case")]
pub async fn download_model(app: AppHandle, asr_model: String) -> CmdResult<()> {
    let name = asr_model.trim().to_string();
    if name.is_empty() {
        return Err("Не указана модель ASR".to_string());
    }
    tauri::async_runtime::spawn_blocking(move || engine::download_model(&app, &name).map_err(err))
        .await
        .map_err(err)?
}

#[tauri::command(rename_all = "snake_case")]
pub fn get_patterns(state: State<'_, AppState>) -> CmdResult<Option<Value>> {
    engine::read_optional_json(&state.paths.patterns_path()).map_err(err)
}

#[tauri::command(rename_all = "snake_case")]
pub async fn refresh_patterns(app: AppHandle) -> CmdResult<Value> {
    tauri::async_runtime::spawn_blocking(move || engine::refresh_patterns(&app).map_err(err))
        .await
        .map_err(err)?
}

pub const TRAINING_TASKS_JSON: &str = include_str!("../resources/training_tasks.json");

#[tauri::command(rename_all = "snake_case")]
pub fn list_training_tasks(state: State<'_, AppState>) -> CmdResult<Vec<TrainingTask>> {
    Ok(load_training_tasks(&state.settings()))
}

/// Задания тренажёра: из data/training_tasks.json движка, иначе — встроенная копия.
pub fn load_training_tasks(settings: &Settings) -> Vec<TrainingTask> {
    if let Some(dir) = engine::engine_data_dir(settings) {
        let p = dir.join("training_tasks.json");
        if let Ok(text) = std::fs::read_to_string(&p) {
            match serde_json::from_str::<Vec<TrainingTask>>(&text) {
                Ok(tasks) if !tasks.is_empty() => return tasks,
                Ok(_) => {}
                Err(e) => log::warn!("{}: {e}", p.display()),
            }
        }
    }
    serde_json::from_str(TRAINING_TASKS_JSON).unwrap_or_default()
}

#[tauri::command(rename_all = "snake_case")]
pub fn show_main_window(app: AppHandle) -> CmdResult<()> {
    show_main(&app);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub fn set_overlay_visible(app: AppHandle, visible: bool) -> CmdResult<()> {
    set_overlay(&app, visible);
    Ok(())
}

#[tauri::command(rename_all = "snake_case")]
pub async fn import_audio(app: AppHandle, opts: ImportAudioOpts) -> CmdResult<MeetingIdResponse> {
    let meeting_id = tauri::async_runtime::spawn_blocking(move || do_import_audio(&app, opts))
        .await
        .map_err(err)??;
    Ok(MeetingIdResponse { meeting_id })
}

/// Только dev-сборка: импорт записи при старте из переменных окружения — сквозная проверка
/// оболочки без диалогов. `REMARKA_IMPORT_WAV=/путь/mic.wav` (обязательно),
/// `REMARKA_IMPORT_SYSTEM_WAV`, `REMARKA_IMPORT_TYPE=pitch`, `REMARKA_IMPORT_TITLE`.
#[cfg(debug_assertions)]
pub fn dev_import_from_env(app: &AppHandle) {
    let Some(mic) = std::env::var_os("REMARKA_IMPORT_WAV") else {
        return;
    };
    let nonempty = |k: &str| std::env::var(k).ok().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let opts = ImportAudioOpts {
        mic_path: mic.to_string_lossy().into_owned(),
        system_path: nonempty("REMARKA_IMPORT_SYSTEM_WAV"),
        started_at: None,
        meeting_type: nonempty("REMARKA_IMPORT_TYPE").and_then(|t| MeetingType::parse(&t)),
        title: nonempty("REMARKA_IMPORT_TITLE"),
    };
    let app = app.clone();
    let _ = std::thread::Builder::new()
        .name("dev-import".into())
        .spawn(move || match do_import_audio(&app, opts) {
            Ok(id) => log::info!("dev-импорт: встреча {id} добавлена"),
            Err(e) => log::error!("dev-импорт не удался: {e}"),
        });
}

/// Только dev-сборка: `REMARKA_DEV_ROUTE=/meeting/<id>` — открыть маршрут в главном окне после
/// загрузки интерфейса (для скриншотов и проверок без кликов).
#[cfg(debug_assertions)]
pub fn dev_open_route_from_env(app: &AppHandle) {
    let Some(route) = std::env::var("REMARKA_DEV_ROUTE").ok().filter(|r| r.starts_with('/')) else {
        return;
    };
    let app = app.clone();
    let _ = std::thread::Builder::new().name("dev-route".into()).spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(2500));
        if let Some(w) = app.get_webview_window("main") {
            let hash = serde_json::to_string(&format!("#{route}")).unwrap_or_default();
            match w.eval(&format!("location.hash = {hash};")) {
                Ok(()) => log::info!("dev-маршрут: {route}"),
                Err(e) => log::error!("dev-маршрут: {e}"),
            }
        }
    });
}

pub fn do_import_audio(app: &AppHandle, opts: ImportAudioOpts) -> CmdResult<String> {
    let state = app.state::<AppState>();
    let settings = state.settings();
    let paths = state.paths.clone();
    let src = std::path::Path::new(&opts.mic_path);
    if !src.is_file() {
        return Err(format!("Файл не найден: {}", opts.mic_path));
    }
    let meeting_id = uuid::Uuid::new_v4().to_string();
    let dir = paths.meeting_dir(&meeting_id);
    std::fs::create_dir_all(&dir).map_err(err)?;
    let cleanup = |e: String| {
        let _ = std::fs::remove_dir_all(&dir);
        e
    };
    let duration = audio::convert_wav_to_16k(src, &paths.mic_wav(&meeting_id))
        .map_err(|e| cleanup(format!("Не удалось импортировать WAV: {e:#}")))?;
    let mut has_system = false;
    if let Some(sys) = opts.system_path.as_deref().map(str::trim).filter(|s| !s.is_empty()) {
        audio::convert_wav_to_16k(std::path::Path::new(sys), &paths.system_wav(&meeting_id))
            .map_err(|e| cleanup(format!("Не удалось импортировать системную дорожку: {e:#}")))?;
        has_system = true;
    }
    let started_at = opts
        .started_at
        .as_deref()
        .map(str::trim)
        .filter(|s| chrono::DateTime::parse_from_rfc3339(s).is_ok())
        .map(str::to_string)
        .or_else(|| {
            std::fs::metadata(src)
                .and_then(|m| m.modified())
                .ok()
                .map(|t| {
                    chrono::DateTime::<chrono::Local>::from(t)
                        .to_rfc3339_opts(chrono::SecondsFormat::Millis, false)
                })
        })
        .unwrap_or_else(now_iso);
    let (meeting_type, type_source) = match opts.meeting_type {
        Some(t) => (t, TypeSource::User),
        None => (MeetingType::Other, TypeSource::Default),
    };
    lock(&state.db)
        .insert(&NewMeeting {
            id: meeting_id.clone(),
            started_at,
            duration_sec: duration,
            meeting_type,
            type_source,
            title: opts.title.as_deref().map(str::trim).filter(|t| !t.is_empty()).map(str::to_string),
            status: MeetingStatus::Recorded,
            has_system_track: has_system,
            training_task_id: None,
        })
        .map_err(|e| cleanup(format!("Не удалось сохранить встречу: {e:#}")))?;
    emit_meetings_changed(app);
    if settings.auto_analyze {
        let _ = engine::enqueue(
            app,
            AnalyzeJob { meeting_id: meeting_id.clone(), llm: settings.llm_backend != LlmBackend::None },
        );
    }
    Ok(meeting_id)
}

#[tauri::command(rename_all = "snake_case")]
pub fn open_data_dir(app: AppHandle, state: State<'_, AppState>) -> CmdResult<()> {
    app.opener()
        .open_path(state.paths.data_dir.to_string_lossy().to_string(), None::<&str>)
        .map_err(err)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_training_tasks_are_valid() {
        let tasks: Vec<TrainingTask> = serde_json::from_str(TRAINING_TASKS_JSON).unwrap();
        assert!(tasks.len() >= 8, "{}", tasks.len());
        assert!(tasks.iter().any(|t| t.id == "elevator_60"));
        assert!(tasks.iter().all(|t| t.meeting_type == MeetingType::Training && t.duration_sec > 0.0));
        let ids: std::collections::HashSet<_> = tasks.iter().map(|t| t.id.as_str()).collect();
        assert_eq!(ids.len(), tasks.len(), "id заданий должны быть уникальны");
    }

    #[test]
    fn platform_is_known() {
        assert!(["macos", "windows", "linux"].contains(&platform_name().as_str()));
    }
}
