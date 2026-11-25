use crate::locale::t;
use crate::{open_studio, pet_position, refresh, settings_failed, State};
use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    AppHandle, Manager,
};

const TRAY_ID: &str = "main";

fn build_menu<R: tauri::Runtime, M: Manager<R>>(manager: &M) -> tauri::Result<Menu<R>> {
    let show = MenuItem::with_id(manager, "studio", t("host.trayOpen"), true, None::<&str>)?;
    let toggle = MenuItem::with_id(manager, "toggle", t("host.trayToggle"), true, None::<&str>)?;
    let recall = MenuItem::with_id(manager, "recall", t("host.trayRecall"), true, None::<&str>)?;
    let quit = MenuItem::with_id(manager, "quit", t("host.trayQuit"), true, None::<&str>)?;
    let files = MenuItem::with_id(manager, "files", t("host.trayFiles"), true, None::<&str>)?;
    Menu::with_items(manager, &[&show, &toggle, &recall, &files, &quit])
}

fn tooltip() -> String {
    if cfg!(feature = "trial") {
        t("host.trialName")
    } else {
        t("app.name")
    }
}

pub fn install(app: &tauri::App) -> tauri::Result<()> {
    let menu = build_menu(app)?;
    #[cfg(target_os = "macos")]
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::include_image!("icons/tray-cat.png"))
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(tauri::include_image!("icons/tray-cat-windows.png"));
    tray.menu(&menu)
        .tooltip(tooltip())
        .on_menu_event(|app, event| match event.id.as_ref() {
            "studio" => {
                let _ = open_studio(app.clone());
            }
            "toggle" => {
                let state = app.state::<State>();
                match state.update_settings(|s| s.visible = !s.visible) {
                    Ok(()) => {
                        let _ = refresh(app);
                    }
                    Err(e) => settings_failed(app, e),
                }
            }
            "recall" => {
                if let Err(e) = pet_position::recall(app) {
                    settings_failed(app, e);
                }
            }
            "quit" => app.exit(0),
            "files" => crate::file_transfer::lab_expand(app.clone()),
            _ => {}
        })
        .build(app)?;
    Ok(())
}

/// Rebuilds the tray menu items and tooltip in the active locale.
pub fn refresh_locale(app: &AppHandle) {
    let Some(tray) = app.tray_by_id(TRAY_ID) else {
        return;
    };
    if let Ok(menu) = build_menu(app) {
        let _ = tray.set_menu(Some(menu));
    }
    let _ = tray.set_tooltip(Some(tooltip()));
}
