use crate::locale::t;
use crate::{open_studio, pet_position, refresh, settings_failed, State};
use tauri::Manager;
pub fn install(app: &tauri::App) -> tauri::Result<()> {
    use tauri::{
        menu::{Menu, MenuItem},
        tray::TrayIconBuilder,
    };
    let show = MenuItem::with_id(app, "studio", t("host.trayOpen"), true, None::<&str>)?;
    let toggle = MenuItem::with_id(app, "toggle", t("host.trayToggle"), true, None::<&str>)?;
    let recall = MenuItem::with_id(app, "recall", t("host.trayRecall"), true, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", t("host.trayQuit"), true, None::<&str>)?;
    let files = MenuItem::with_id(app, "files", t("host.trayFiles"), true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show, &toggle, &recall, &files, &quit])?;
    #[cfg(target_os = "macos")]
    let tray = TrayIconBuilder::new()
        .icon(tauri::include_image!("icons/tray-cat.png"))
        .icon_as_template(true);
    #[cfg(not(target_os = "macos"))]
    let tray = TrayIconBuilder::new().icon(tauri::include_image!("icons/tray-cat-windows.png"));
    tray.menu(&menu)
        .tooltip(if cfg!(feature = "trial") {
            "随伴试玩版".to_string()
        } else {
            t("app.name")
        })
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
