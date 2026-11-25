use crate::*;
pub fn run(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    selection::watch_apps();
    #[cfg(feature = "acceptance")]
    let root = acceptance::data_root(app.handle())?;
    #[cfg(not(feature = "acceptance"))]
    let root = app.path().app_data_dir()?;
    profile::check(&app.config().identifier, &root)?;
    std::fs::create_dir_all(root.join("pets"))?;
    #[cfg(not(feature = "acceptance"))]
    profile::seed_first_run(&root)?;
    app.manage(companion::Companion::open(&root)?);

    let settings: Settings = std::fs::read(root.join("settings.json"))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    clipboard::setup(app.handle(), root.clone());
    app.manage(State {
        root,
        settings: Mutex::new(settings.clone()),
    });
    #[cfg(not(feature = "acceptance"))]
    file_transfer::setup(app)?;
    chat::ensure(app.handle()).map_err(std::io::Error::other)?;
    let _ = app
        .state::<companion::Companion>()
        .host
        .app
        .set(app.handle().clone());
    if let Some(pet) = app.get_webview_window("pet") {
        #[cfg(feature = "acceptance")]
        if settings.position.is_none() {
            pet.set_position(tauri::LogicalPosition::new(1100.0, 650.0))?;
        }
        if !cfg!(feature = "acceptance") || settings.position.is_some() {
            pet_position::restore(app.handle(), &pet, &settings).map_err(std::io::Error::other)?;
        }
    }
    tray_menu::install(app)?;
    refresh_window_titles(app.handle());
    #[cfg(feature = "acceptance")]
    acceptance::launch(app.handle())?;
    refresh(app.handle()).map_err(std::io::Error::other)?;
    copy_twice::watch(app.handle().clone());
    companion::startup(app.handle().clone());
    focus::watch(app.handle().clone());
    todo::setup(app.handle());
    focus_clock::sync(app.handle(), focus::on(app.handle()));
    studio_window::setup(app.handle());
    let greet = app.handle().clone();
    std::thread::spawn(move || {
        // Brief beat for windows to initialize; guide-open queues cleanly until studio_ready.
        std::thread::sleep(std::time::Duration::from_millis(400));
        tips::first_launch(&greet);
    });
    let handle = app.handle().clone();
    let watch_layout = pet_position::watch_layout(app.handle());
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(5));
        watch_layout();
        let root = handle.state::<State>().root.clone();
        let results = inbox::scan(&root);
        if results.is_empty() {
            continue;
        }
        for r in results {
            match r {
                Ok(inbox::Arrival::Pet {
                    pet_id,
                    name,
                    updated,
                }) => {
                    // A new or updated pet becomes the one on stage.
                    let state = handle.state::<State>();
                    if let Err(e) = state.update_settings(|s| s.active_id = Some(pet_id)) {
                        settings_failed(&handle, e);
                        continue;
                    }
                    if !updated {
                        tips::used(&handle, "make-pet");
                    }
                    let _ = refresh(&handle);
                    let _ = open_studio(handle.clone());
                    studio_window::emit(
                        &handle,
                        "pet-arrived",
                        serde_json::json!({ "name": name, "updated": updated }),
                    );
                }
                Ok(inbox::Arrival::Teaching { summary, .. }) => {
                    tips::used(&handle, "teach");
                    let _ = refresh(&handle);
                    let _ = open_studio(handle.clone());
                    studio_window::emit(&handle, "draft-arrived", summary);
                }
                Ok(inbox::Arrival::Tool { .. }) => {
                    let _ = open_studio(handle.clone());
                    studio_window::emit(&handle, "settings-section", "tools");
                }
                Err(e) => {
                    let _ = refresh(&handle);
                    studio_window::emit(&handle, "draft-failed", e);
                }
            }
        }
    });
    Ok(())
}
