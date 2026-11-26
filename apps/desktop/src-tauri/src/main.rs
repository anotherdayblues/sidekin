#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]
use crate::locale::t;
#[cfg(feature = "acceptance")]
mod acceptance;
mod app_events;
mod app_runtime;
mod app_setup;
mod attachments;
mod autostart;
mod brain;
mod bubble_history;
mod capture_image;
mod chat;
mod chat_images;
mod chat_window;
mod companion;
mod copy_twice;
mod clipboard;
mod credentials;
mod documents;
mod external;
mod file_transfer;
mod focus;
mod focus_clock;
mod focus_log;
mod history;
mod host;
mod idle_release;
mod inbox;
mod library;
mod locale;
mod memory;
mod migrate;
mod model_setup;
mod ocr;
mod permissions;
mod persona;
mod pet_action;
mod pet_position;
mod phone;
mod profile;
#[cfg(test)]
mod qa_core;
mod reminders;
mod reveal;
mod schedule;
mod scheduled;
mod search_quota;
mod selection;
mod shortcuts;
mod skill_paths;
mod snip;
mod snip_card;
mod studio_window;
mod teaching;
mod tips;
mod todo;
mod tool_cards;
mod topics;
mod translations;
mod tray_menu;
mod usage;
mod voice;
mod wardrobe;
mod window_material;
mod window_memory;
use serde::{Deserialize, Serialize};
use std::{collections::HashMap, sync::Mutex};
use tauri::{Emitter, Manager};

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
struct Settings {
    active_id: Option<String>,
    visible: bool,
    paused: bool,
    #[serde(deserialize_with = "read_pet_size")]
    size: u32,
    position: Option<(i32, i32)>,
    position_scale: Option<f64>,
    behaviors: HashMap<String, serde_json::Value>,
    /// "system", "day", "night" or "clock".
    theme: String,
    /// Management window skin: "native" (the default) or "studio".
    skin: String,
    /// The pet page's cards, top to bottom, each small or big; None until
    /// first changed (plan/33).
    home_cards: Option<Vec<HomeCard>>,
    /// Per-pet OpenPets wardrobe preferences (always-wear outfit and/or custom schedule).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pet_wardrobe_preferences: HashMap<String, wardrobe::PetWardrobePreference>,
    /// Per-pet horizontal flip toggle (absent or false means unflipped).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pet_horizontal_flip: HashMap<String, bool>,
    /// Per-pet enabled idle activity IDs (absent means all declared activities enabled).
    #[serde(default, skip_serializing_if = "HashMap::is_empty")]
    pet_activity_preferences: HashMap<String, Vec<String>>,
}
fn read_pet_size<'de, D: serde::Deserializer<'de>>(deserializer: D) -> Result<u32, D::Error> {
    u32::deserialize(deserializer).map(|size| size.min(280))
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            active_id: None,
            visible: false,
            paused: false,
            size: 160,
            position: None,
            position_scale: None,
            behaviors: HashMap::new(),
            theme: "system".into(),
            skin: "native".into(),
            home_cards: None,
            pet_wardrobe_preferences: HashMap::new(),
            pet_horizontal_flip: HashMap::new(),
            pet_activity_preferences: HashMap::new(),
        }
    }
}
struct State {
    root: std::path::PathBuf,
    settings: Mutex<Settings>,
}
#[cfg(test)]
#[path = "settings_save_tests.rs"]
mod save_regression;
#[cfg(test)]
#[path = "settings_size_tests.rs"]
mod size_regression;
impl State {
    fn update_settings(&self, edit: impl FnOnce(&mut Settings)) -> Result<(), String> {
        let mut saved = self.settings.lock().map_err(|e| e.to_string())?;
        let mut next = saved.clone();
        edit(&mut next);
        library::write_json(&self.root.join("settings.json"), &next)?;
        *saved = next;
        Ok(())
    }
}
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Snapshot {
    pets: Vec<library::Pet>,
    settings: Settings,
    drafts: Vec<teaching::Draft>,
    custom: HashMap<String, teaching::Custom>,
}
fn snapshot(app: &tauri::AppHandle) -> Result<Snapshot, String> {
    let state = app.state::<State>();
    let settings = get_settings(state.clone())?;
    let pets = library::list(&state.root)?;
    let custom = custom_layers(&state.root, &pets)?;
    Ok(Snapshot {
        pets,
        settings,
        drafts: teaching::drafts(&state.root),
        custom,
    })
}
fn custom_layers(
    root: &std::path::Path,
    pets: &[library::Pet],
) -> Result<HashMap<String, teaching::Custom>, String> {
    pets.iter()
        .map(|p| teaching::custom(root, &p.id).map(|custom| (p.id.clone(), custom)))
        .collect()
}
fn refresh(app: &tauri::AppHandle) -> Result<(), String> {
    let s = snapshot(app)?;
    if let Some(win) = app.get_webview_window("pet") {
        let show = s.settings.visible && s.settings.active_id.is_some();
        let reopening = show && !win.is_visible().map_err(|e| e.to_string())?;
        if !file_transfer::resize(app, s.settings.size) {
            win.set_size(tauri::LogicalSize::new(
                s.settings.size as f64,
                s.settings.size as f64 * 208.0 / 192.0,
            ))
            .map_err(|e| e.to_string())?;
        }
        // On macOS, showing an already visible pet takes focus from the studio.
        if reopening {
            if s.settings.position.is_some() {
                pet_position::restore(app, &win, &s.settings)?;
            }
            win.show().map_err(|e| e.to_string())?;
            window_memory::shown(&win);
        } else if !show {
            win.hide().map_err(|e| e.to_string())?;
            window_memory::hidden(&win);
        }
    }
    focus_clock::sync(app, focus::on(app));
    let _ = focus_clock::place(app);
    app.emit("library-changed", s).map_err(|e| e.to_string())
}
#[tauri::command]
fn get_state(app: tauri::AppHandle) -> Result<Snapshot, String> {
    snapshot(&app)
}
#[tauri::command]
fn get_settings(state: tauri::State<'_, State>) -> Result<Settings, String> {
    Ok(state.settings.lock().map_err(|e| e.to_string())?.clone())
}
fn store_example(root: &std::path::Path) -> Result<library::ImportResult, String> {
    library::store_with_outfits(
        root,
        include_bytes!("../../../../examples/lizi/pet.json"),
        include_bytes!("../../../../examples/lizi/spritesheet.webp"),
        vec![(
            "outfits/moon-pajamas.webp".into(),
            include_bytes!("../../../../examples/lizi/outfits/moon-pajamas.webp").to_vec(),
        )],
        vec![(
            "outfits/moon-pajamas-sleep.png".into(),
            include_bytes!("../../../../examples/lizi/outfits/moon-pajamas-sleep.png").to_vec(),
        )],
    )
}

#[tauri::command]
async fn import_example(app: tauri::AppHandle) -> Result<(), String> {
    let root = app.state::<State>().root.clone();
    let result = tauri::async_runtime::spawn_blocking(move || store_example(&root))
        .await
        .map_err(|e| e.to_string())??;
    let state = app.state::<State>();
    state.update_settings(|s| s.active_id = Some(result.pet.id))?;
    refresh(&app)
}
#[derive(Serialize)]
#[serde(untagged)]
enum Imported {
    Pet(library::ImportResult),
    Draft { draft: teaching::Draft },
}
#[tauri::command]
async fn import_pet(app: tauri::AppHandle, path: String) -> Result<Imported, String> {
    let root = app.state::<State>().root.clone();
    let source = std::path::PathBuf::from(&path);
    if source.join("teaching.json").is_file() {
        let draft = tauri::async_runtime::spawn_blocking(move || teaching::intake(&root, &source))
            .await
            .map_err(|e| e.to_string())??;
        refresh(&app)?;
        return Ok(Imported::Draft { draft });
    }
    let result = tauri::async_runtime::spawn_blocking(move || library::import(&root, &source))
        .await
        .map_err(|e| e.to_string())??;
    let state = app.state::<State>();
    state.update_settings(|s| s.active_id = Some(result.pet.id.clone()))?;
    refresh(&app)?;
    Ok(Imported::Pet(result))
}
#[tauri::command]
async fn export_pet(app: tauri::AppHandle, id: String, path: String) -> Result<(), String> {
    let root = app.state::<State>().root.clone();
    let dest = std::path::PathBuf::from(path);
    tauri::async_runtime::spawn_blocking(move || library::export(&root, &id, &dest))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
fn rename_pet(app: tauri::AppHandle, id: String, name: String) -> Result<(), String> {
    library::rename(&app.state::<State>().root, &id, &name)?;
    refresh(&app)
}
const SKINS: [&str; 2] = ["native", "studio"];
/// An unknown skin, such as a retired one (room, game) or one from a newer
/// build, falls back to native.
fn known_skin(skin: &str) -> &str {
    if SKINS.contains(&skin) {
        skin
    } else {
        "native"
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct HomeCard {
    id: String,
}
const CARDS: [&str; 5] = ["today", "focus", "memory", "chats", "usage"];
/// Cards this build knows, each once, in the order given; one from a newer
/// build is dropped. A size saved by an older build is ignored.
fn known_cards(list: Vec<HomeCard>) -> Vec<HomeCard> {
    let mut out: Vec<HomeCard> = Vec::new();
    for c in list {
        if CARDS.contains(&c.id.as_str()) && !out.iter().any(|o| o.id == c.id) {
            out.push(c);
        }
    }
    out
}
#[tauri::command]
fn save_settings(app: tauri::AppHandle, mut settings: Settings) -> Result<(), String> {
    let state = app.state::<State>();
    if !["system", "day", "night", "clock"].contains(&settings.theme.as_str()) {
        settings.theme = "system".into();
    }
    settings.skin = known_skin(&settings.skin).into();
    settings.home_cards = settings.home_cards.map(known_cards);
    if !(80..=280).contains(&settings.size) {
        return Err(t("host.petSize").into());
    }
    if let Some(id) = &settings.active_id {
        library::pet(&state.root, id)?;
    }
    let mut size_changed = false;
    state.update_settings(|s| {
        size_changed = s.size != settings.size;
        settings.position = s.position;
        settings.position_scale = s.position_scale;
        settings.pet_wardrobe_preferences = s.pet_wardrobe_preferences.clone();
        settings.pet_horizontal_flip = s.pet_horizontal_flip.clone();
        settings.pet_activity_preferences = s.pet_activity_preferences.clone();
        *s = settings;
    })?;
    refresh(&app)?;
    if size_changed {
        if let Some(win) = app.get_webview_window("pet") {
            let s = state.settings.lock().unwrap().clone();
            pet_position::restore(&app, &win, &s)?;
        }
    }
    Ok(())
}
fn data_url(path: &std::path::Path) -> Result<String, String> {
    use base64::Engine;
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    let mime = if path.extension().is_some_and(|e| e == "png") {
        "image/png"
    } else {
        "image/webp"
    };
    Ok(format!(
        "data:{};base64,{}",
        mime,
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}
#[tauri::command]
async fn read_pet_thumbnail(app: tauri::AppHandle, id: String) -> Result<String, String> {
    let root = app.state::<State>().root.clone();
    tauri::async_runtime::spawn_blocking(move || data_url(&library::thumbnail(&root, &id)?))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_sprite(
    app: tauri::AppHandle,
    id: String,
    sleep: Option<bool>,
    outfit: Option<String>,
) -> Result<String, String> {
    let root = app.state::<State>().root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if sleep == Some(true) {
            return data_url(&library::outfit_sleep_path(
                &root,
                &id,
                outfit.as_deref(),
            )?);
        }
        let pet = library::pet(&root, &id)?;
        if let Some(outfit_id) = outfit
            .as_deref()
            .filter(|s| !s.is_empty() && *s != wardrobe::DEFAULT_OUTFIT_ID)
        {
            return data_url(&library::outfit_sheet_path(&root, &id, outfit_id)?);
        }
        data_url(&root.join("pets").join(id).join(&pet.spritesheet_path))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_pet_asset(
    app: tauri::AppHandle,
    pet_id: String,
    path: String,
) -> Result<String, String> {
    let root = app.state::<State>().root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        data_url(&library::pet_asset_path(&root, &pet_id, &path)?)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
async fn read_outfit_thumbnail(
    app: tauri::AppHandle,
    pet_id: String,
    outfit_id: String,
) -> Result<String, String> {
    let root = app.state::<State>().root.clone();
    tauri::async_runtime::spawn_blocking(move || {
        data_url(&library::outfit_thumbnail(&root, &pet_id, &outfit_id)?)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
fn set_pet_wardrobe_pref(
    app: tauri::AppHandle,
    pet_id: String,
    preference: Option<wardrobe::PetWardrobePreference>,
) -> Result<(), String> {
    let state = app.state::<State>();
    let pet = library::pet(&state.root, &pet_id)?;
    let validated = wardrobe::validate_wardrobe_preference(&pet, preference)?;
    state.update_settings(|s| {
        if let Some(pref) = validated {
            s.pet_wardrobe_preferences.insert(pet_id, pref);
        } else {
            s.pet_wardrobe_preferences.remove(&pet_id);
        }
    })?;
    refresh(&app)
}
#[tauri::command]
fn delete_pet_outfit(
    app: tauri::AppHandle,
    pet_id: String,
    outfit_id: String,
) -> Result<String, String> {
    let state = app.state::<State>();
    let removed_name = library::delete_outfit(&state.root, &pet_id, &outfit_id)?;
    state.update_settings(|s| {
        if let Some(pref) = s.pet_wardrobe_preferences.get_mut(&pet_id) {
            if pref.outfit.as_deref() == Some(outfit_id.as_str()) {
                pref.outfit = None;
            }
            if let Some(schedule) = pref.schedule.as_mut() {
                schedule.retain(|rule| rule.outfit != outfit_id);
                if schedule.is_empty() {
                    pref.schedule = None;
                }
            }
            if pref.outfit.is_none() && pref.schedule.is_none() {
                s.pet_wardrobe_preferences.remove(&pet_id);
            }
        }
    })?;
    refresh(&app)?;
    Ok(removed_name)
}
#[tauri::command]
fn set_pet_flip(app: tauri::AppHandle, pet_id: String, flipped: bool) -> Result<(), String> {
    let state = app.state::<State>();
    library::pet(&state.root, &pet_id)?;
    state.update_settings(|s| {
        if flipped {
            s.pet_horizontal_flip.insert(pet_id, true);
        } else {
            s.pet_horizontal_flip.remove(&pet_id);
        }
    })?;
    refresh(&app)
}
#[tauri::command]
fn set_pet_activity_pref(
    app: tauri::AppHandle,
    pet_id: String,
    enabled: Option<Vec<String>>,
) -> Result<(), String> {
    let state = app.state::<State>();
    let pet = library::pet(&state.root, &pet_id)?;
    let validated = wardrobe::validate_activity_preference(&pet, enabled)?;
    state.update_settings(|s| {
        if let Some(ids) = validated {
            s.pet_activity_preferences.insert(pet_id, ids);
        } else {
            s.pet_activity_preferences.remove(&pet_id);
        }
    })?;
    refresh(&app)
}
#[tauri::command]
fn preview_activity(
    app: tauri::AppHandle,
    pet_id: String,
    activity_id: String,
) -> Result<(), String> {
    let state = app.state::<State>();
    let pet = library::pet(&state.root, &pet_id)?;
    let exists = pet
        .activities
        .as_ref()
        .is_some_and(|list| list.iter().any(|a| a.id == activity_id));
    if !exists {
        return Err(format!("Unknown pet activity: {activity_id}"));
    }
    let needs_update = {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        !s.visible || s.active_id.as_deref() != Some(pet_id.as_str())
    };
    if needs_update {
        state.update_settings(|s| {
            s.active_id = Some(pet_id.clone());
            s.visible = true;
        })?;
    }
    refresh(&app)?;
    app.emit_to(
        "pet",
        "preview-activity",
        serde_json::json!({ "petId": pet_id, "activityId": activity_id }),
    )
    .map_err(|e| e.to_string())
}
#[tauri::command]
fn read_action_image(
    app: tauri::AppHandle,
    pet_id: String,
    draft_id: Option<String>,
    action: String,
) -> Result<String, String> {
    let root = &app.state::<State>().root;
    data_url(&teaching::image_path(
        root,
        &pet_id,
        draft_id.as_deref(),
        &action,
    )?)
}
#[tauri::command]
fn saved_actions(
    app: tauri::AppHandle,
    pet_id: String,
) -> Result<Vec<teaching::archive::SavedAction>, String> {
    teaching::archive::list(&app.state::<State>().root, &pet_id)
}
#[tauri::command]
fn read_saved_action(app: tauri::AppHandle, pet_id: String, id: String) -> Result<String, String> {
    data_url(&teaching::archive::image(
        &app.state::<State>().root,
        &pet_id,
        &id,
    )?)
}
#[tauri::command]
fn use_saved_action(app: tauri::AppHandle, pet_id: String, id: String) -> Result<(), String> {
    teaching::archive::select(&app.state::<State>().root, &pet_id, &id)?;
    refresh(&app)
}
#[tauri::command]
fn delete_saved_action(app: tauri::AppHandle, pet_id: String, id: String) -> Result<(), String> {
    teaching::archive::delete(&app.state::<State>().root, &pet_id, &id)?;
    refresh(&app)
}
#[tauri::command]
fn accept_draft(app: tauri::AppHandle, id: String) -> Result<teaching::Version, String> {
    let v = teaching::accept(&app.state::<State>().root, &id)?;
    refresh(&app)?;
    Ok(v)
}
#[tauri::command]
fn discard_draft(app: tauri::AppHandle, id: String) -> Result<(), String> {
    teaching::discard(&app.state::<State>().root, &id)?;
    refresh(&app)
}
#[tauri::command]
fn revert_custom(app: tauri::AppHandle, pet_id: String, version: u32) -> Result<(), String> {
    teaching::revert(&app.state::<State>().root, &pet_id, version)?;
    refresh(&app)
}
/// When a learned action plays: on a double-click, at random, at a time
/// (plan/29). Saved as a new version, like any other change.
#[tauri::command]
fn set_action_plan(
    app: tauri::AppHandle,
    pet_id: String,
    action: String,
    plan: teaching::plan::Plan,
) -> Result<(), String> {
    teaching::plan::set_plan(&app.state::<State>().root, &pet_id, &action, &plan)?;
    refresh(&app)
}
/// Save a new version without one learned action or rule. The studio asks
/// the user first; the previous version stays in the history.
#[tauri::command]
fn forget_custom(
    app: tauri::AppHandle,
    pet_id: String,
    actions: Vec<String>,
    rules: Vec<String>,
) -> Result<teaching::Version, String> {
    let v = teaching::forget(&app.state::<State>().root, &pet_id, &actions, &rules)?;
    refresh(&app)?;
    Ok(v)
}
#[tauri::command]
fn version_layer(
    app: tauri::AppHandle,
    pet_id: String,
    version: u32,
) -> Result<teaching::Layer, String> {
    teaching::version_layer(&app.state::<State>().root, &pet_id, version)
}
/// Play steps on the desktop pet once, optionally with a draft's actions.
#[tauri::command]
fn preview_on_desktop(app: tauri::AppHandle, preview: serde_json::Value) -> Result<(), String> {
    let state = app.state::<State>();
    let hidden = !state.settings.lock().map_err(|e| e.to_string())?.visible;
    if hidden {
        state.update_settings(|s| s.visible = true)?;
    }
    refresh(&app)?;
    app.emit_to("pet", "preview-steps", preview)
        .map_err(|e| e.to_string())
}
/// Seconds since the last keyboard or mouse input, where the OS reports it.
#[tauri::command]
fn system_idle_seconds() -> Option<f64> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/sbin/ioreg")
            .args(["-c", "IOHIDSystem", "-d", "4", "-r", "-k", "HIDIdleTime"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        let line = text.lines().find(|l| l.contains("\"HIDIdleTime\""))?;
        let ns: f64 = line.rsplit('=').next()?.trim().parse().ok()?;
        Some(ns / 1e9)
    }
    #[cfg(windows)]
    {
        extern "C" {
            fn companion_idle_millis() -> i64;
        }
        let ms = unsafe { companion_idle_millis() };
        (ms >= 0).then_some(ms as f64 / 1000.)
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        None
    }
}
#[cfg(all(windows, test))]
mod idle_tests {
    #[test]
    fn windows_idle_time_is_available() {
        assert!(crate::system_idle_seconds().is_some_and(|s| s >= 0.));
    }
}
#[tauri::command]
fn play_action(app: tauri::AppHandle, action: String) -> Result<(), String> {
    if !library::ACTIONS.contains(&action.as_str())
        && !(action.len() <= 40
            && action
                .bytes()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-'))
    {
        return Err(t("host.unknownMotion").into());
    }
    app.emit_to("pet", "play-action", action)
        .map_err(|e| e.to_string())
}
#[tauri::command]
fn open_studio(app: tauri::AppHandle) -> Result<(), String> {
    studio_window::open(&app)
}
#[tauri::command]
fn quit_app(app: tauri::AppHandle) {
    app.exit(0);
}
/// Deletes a pet's files for good; the studio asks the user first.
#[tauri::command]
fn remove_pet(app: tauri::AppHandle, id: String) -> Result<(), String> {
    let state = app.state::<State>();
    teaching::discard_for(&state.root, &id);
    library::remove(&state.root, &id)?;
    let next_id = library::list(&state.root)?.first().map(|p| p.id.clone());
    state.update_settings(|s| {
        s.behaviors.remove(&id);
        s.pet_wardrobe_preferences.remove(&id);
        s.pet_horizontal_flip.remove(&id);
        s.pet_activity_preferences.remove(&id);
        if s.active_id.as_deref() == Some(id.as_str()) {
            s.active_id = next_id;
            if s.active_id.is_none() {
                s.visible = false;
            }
        }
    })?;
    refresh(&app)
}
pub(crate) fn refresh_window_titles(app: &tauri::AppHandle) {
    let titles = [
        ("studio", t("host.studioTitle")),
        ("pet", t("app.name")),
        ("bubble", t("host.titleChat")),
        ("chat", t("host.titleChatWindow")),
        ("snipcard", t("host.titleSnipCard")),
    ];
    for (label, title) in titles {
        if let Some(w) = app.get_webview_window(label) {
            let _ = w.set_title(&title);
        }
    }
}
fn settings_failed(app: &tauri::AppHandle, error: String) {
    let _ = open_studio(app.clone());
    studio_window::emit_all(
        app,
        "settings-error",
        format!("{}: {error}", t("host.settingsSave")),
    );
}
fn main() {
    app_runtime::run();
}
