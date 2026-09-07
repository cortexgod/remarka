//! Поллинг процессов (sysinfo) раз в 5 с: Zoom / Microsoft Teams / Яндекс Телемост.
//! Google Meet живёт в браузере — по заголовкам окон не ловим (пропускаем).
//! Zoom считается «в звонке» только по процессу CptHost, который живёт лишь во время встречи:
//! сам zoom.us у многих висит в фоне постоянно.

use crate::models::{events, EvMeetingApp};
use crate::state::AppState;
use crate::util::lock;
use std::time::Duration;
use sysinfo::{ProcessRefreshKind, ProcessesToUpdate, RefreshKind, System};
use tauri::{AppHandle, Emitter, Manager};

pub const POLL_INTERVAL: Duration = Duration::from_secs(5);

/// По списку имён процессов определяет приложение звонка (приоритет: zoom > teams > telemost).
pub fn detect<I, S>(names: I) -> Option<String>
where
    I: IntoIterator<Item = S>,
    S: AsRef<str>,
{
    let mut zoom = false;
    let mut teams = false;
    let mut telemost = false;
    for n in names {
        let n = n.as_ref().to_lowercase();
        if n == "cpthost" || n == "cpthost.exe" {
            zoom = true;
        } else if n == "msteams"
            || n == "msteams.exe"
            || n == "ms-teams.exe"
            || n == "teams.exe"
            || n == "microsoft teams"
            || n.starts_with("microsoft teams")
        {
            teams = true;
        } else if n.contains("telemost") || n.contains("телемост") {
            telemost = true;
        }
    }
    if zoom {
        Some("zoom".into())
    } else if teams {
        Some("teams".into())
    } else if telemost {
        Some("telemost".into())
    } else {
        None
    }
}

pub fn scan() -> Option<String> {
    let mut sys = System::new_with_specifics(
        RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
    );
    sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing());
    detect(
        sys.processes()
            .values()
            .map(|p| p.name().to_string_lossy().to_string()),
    )
}

pub fn start_poller(app: AppHandle) {
    let result = std::thread::Builder::new()
        .name("meeting-apps".into())
        .spawn(move || {
            let mut sys = System::new_with_specifics(
                RefreshKind::nothing().with_processes(ProcessRefreshKind::nothing()),
            );
            let mut current: Option<String> = None;
            loop {
                sys.refresh_processes_specifics(
                    ProcessesToUpdate::All,
                    true,
                    ProcessRefreshKind::nothing(),
                );
                let detected = detect(
                    sys.processes()
                        .values()
                        .map(|p| p.name().to_string_lossy().to_string()),
                );
                if detected != current {
                    let started = detected.is_some();
                    current = detected.clone();
                    log::info!("приложение для звонков: {:?}", current);
                    let mut suggest = false;
                    if let Some(state) = app.try_state::<AppState>() {
                        *lock(&state.meeting_app) = current.clone();
                        suggest = started && state.settings().ask_on_meeting_app && !state.is_recording();
                    }
                    let _ = app.emit(events::MEETING_APP, EvMeetingApp { app: current.clone() });
                    crate::tray::update(&app);
                    if suggest {
                        let name = match current.as_deref() {
                            Some("zoom") => "Zoom",
                            Some("teams") => "Teams",
                            Some("telemost") => "Телемосте",
                            _ => "приложении для звонков",
                        };
                        crate::util::notify(
                            &app,
                            &format!("Идёт звонок в {name} — начать запись?"),
                            "Откройте Ремарку или выберите «Начать запись» в меню в строке меню",
                        );
                    }
                }
                std::thread::sleep(POLL_INTERVAL);
            }
        });
    if let Err(e) = result {
        log::error!("не удалось запустить поллер приложений: {e}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn detects_known_apps() {
        // zoom.us в фоне — не звонок; CptHost появляется только во время встречи
        assert_eq!(detect(["Finder", "zoom.us", "Safari"]), None);
        assert_eq!(detect(["Finder", "zoom.us", "CptHost"]), Some("zoom".into()));
        assert_eq!(detect(["Zoom.exe", "CptHost.exe"]), Some("zoom".into()));
        assert_eq!(detect(["MSTeams"]), Some("teams".into()));
        assert_eq!(detect(["Microsoft Teams Helper"]), Some("teams".into()));
        assert_eq!(detect(["Yandex.Telemost", "kernel_task"]), Some("telemost".into()));
        assert_eq!(detect(["Яндекс Телемост"]), Some("telemost".into()));
        assert_eq!(detect(["Finder", "Safari"]), None);
        // приоритет zoom
        assert_eq!(detect(["MSTeams", "CptHost"]), Some("zoom".into()));
        // zoomer — не zoom
        assert_eq!(detect(["zoomer"]), None);
    }

    #[test]
    fn scan_does_not_panic() {
        let _ = scan();
    }
}
