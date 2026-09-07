//! Иконка в трее и её меню (§6.2).

use crate::state::AppState;
use crate::util::lock;
use tauri::menu::{Menu, MenuItem, PredefinedMenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIcon, TrayIconBuilder, TrayIconEvent};
use tauri::{AppHandle, Manager, Wry};

pub const TRAY_ID: &str = "main";

pub struct TrayHandles {
    pub tray: TrayIcon<Wry>,
    pub toggle: MenuItem<Wry>,
}

pub fn build(app: &AppHandle) -> tauri::Result<()> {
    let toggle = MenuItem::with_id(app, "toggle_record", "Начать запись", true, None::<&str>)?;
    let open = MenuItem::with_id(app, "open", "Открыть Ремарку", true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Выйти", true, None::<&str>)?;
    let sep = PredefinedMenuItem::separator(app)?;
    let menu = Menu::with_items(app, &[&toggle, &open, &sep, &quit])?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::include_image!("icons/tray@2x.png"))
        .icon_as_template(true)
        .tooltip("Ремарка")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, ev| match ev.id().as_ref() {
            "toggle_record" => crate::commands::tray_toggle_recording(app),
            "open" => crate::commands::show_main(app),
            "quit" => {
                crate::commands::shutdown(app);
                app.exit(0);
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, ev| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = ev
            {
                crate::commands::show_main(tray.app_handle());
            }
        })
        .build(app)?;

    app.manage(TrayHandles { tray, toggle });
    Ok(())
}

pub fn app_title(app_id: &str) -> &'static str {
    match app_id {
        "zoom" => "Zoom",
        "teams" => "Teams",
        "telemost" => "Телемосте",
        "meet" => "Meet",
        _ => "звонке",
    }
}

/// Обновляет пункт «Начать/Остановить запись» и tooltip по текущему состоянию.
pub fn update(app: &AppHandle) {
    let Some(handles) = app.try_state::<TrayHandles>() else {
        return;
    };
    let state = app.state::<AppState>();
    let recording = state.is_recording();
    let meeting_app = lock(&state.meeting_app).clone();
    let _ = handles.toggle.set_text(if recording {
        "Остановить запись"
    } else {
        "Начать запись"
    });
    let tooltip = match (recording, meeting_app.as_deref()) {
        (true, _) => "Ремарка — идёт запись".to_string(),
        (false, Some(a)) => format!("Ремарка — идёт звонок в {}", app_title(a)),
        (false, None) => "Ремарка".to_string(),
    };
    let _ = handles.tray.set_tooltip(Some(tooltip));
}
