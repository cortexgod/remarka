//! Ремарка — оболочка (Rust / Tauri 2). См. docs/CONTRACTS.md §6.

pub mod audio;
pub mod capture;
pub mod commands;
pub mod db;
pub mod engine;
pub mod meeting_apps;
pub mod models;
pub mod paths;
pub mod progress;
pub mod settings;
pub mod state;
pub mod tray;
pub mod util;

use state::AppState;
use tauri::{Manager, RunEvent, WindowEvent};

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let _ = env_logger::Builder::from_env(
        env_logger::Env::default().default_filter_or("info,remarka_lib=debug"),
    )
    .try_init();

    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
        .setup(|app| {
            let data_dir = app.path().app_data_dir()?;
            let paths = paths::Paths::new(data_dir)?;
            let settings = settings::load(&paths.settings_path());
            if !paths.settings_path().is_file() {
                let _ = settings::save(&paths.settings_path(), &settings);
            }
            let db = db::Db::open(&paths.db_path())?;
            // Разбор, прерванный выходом из приложения, мог успеть записать report.json — тогда встреча готова.
            for id in db.ids_with_status("analyzing").unwrap_or_default() {
                let report = paths.report_json(&id);
                let mic = paths.mic_wav(&id);
                let fresh = match (std::fs::metadata(&report), std::fs::metadata(&mic)) {
                    (Ok(r), Ok(m)) => r.modified().ok() >= m.modified().ok(),
                    _ => false,
                };
                if fresh {
                    if let Ok(doc) = engine::read_json(&report) {
                        let _ = db.apply_report(&id, &engine::summarize_report(&doc));
                        log::info!("встреча {id}: отчёт был дописан до выхода — помечена готовой");
                    }
                }
            }
            let recovered = db.recover_interrupted()?;
            if recovered > 0 {
                log::info!("встреч, прерванных при прошлом запуске: {recovered}");
            }
            log::info!("каталог данных: {}", paths.data_dir.display());
            app.manage(AppState::new(paths, db, settings));
            tray::build(app.handle())?;
            meeting_apps::start_poller(app.handle().clone());
            #[cfg(debug_assertions)]
            {
                commands::dev_import_from_env(app.handle());
                commands::dev_open_route_from_env(app.handle());
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if let WindowEvent::CloseRequested { api, .. } = event {
                if window.label() == "main" {
                    api.prevent_close();
                    let _ = window.hide();
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            commands::get_app_state,
            commands::list_audio_devices,
            commands::start_recording,
            commands::stop_recording,
            commands::cancel_recording,
            commands::list_meetings,
            commands::get_meeting,
            commands::get_report,
            commands::analyze_meeting,
            commands::delete_meeting,
            commands::update_meeting,
            commands::get_audio_path,
            commands::get_progress,
            commands::get_baseline,
            commands::get_settings,
            commands::set_settings,
            commands::engine_doctor,
            commands::prepare_meeting,
            commands::get_patterns,
            commands::refresh_patterns,
            commands::list_training_tasks,
            commands::show_main_window,
            commands::set_overlay_visible,
            commands::import_audio,
            commands::open_data_dir,
            commands::download_model,
        ])
        .build(tauri::generate_context!())
        .expect("не удалось собрать приложение Tauri");

    app.run(|app, event| match event {
        #[cfg(target_os = "macos")]
        RunEvent::Reopen { .. } => commands::show_main(app),
        RunEvent::Exit => commands::shutdown(app),
        _ => {}
    });
}
