//! The chat side panel: opens tall against the right edge of the pet's
//! screen, stays wherever the user drags it, and is opened and put away with
//! one shortcut. Also the topic commands it shares with the chat page.
use crate::idle_release::{self, IdleRelease};
use crate::locale::t;
use crate::{chat, companion::Companion, history, library, topics, State};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Mutex,
    },
    time::Instant,
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindow,
    WebviewWindowBuilder,
};

const LABEL: &str = "chat";
/// The side panel keeps the user's width; its height always fills the screen.
const WIDTH: f64 = 400.;
const MIN_WIDTH: f64 = 340.;
const MAX_WIDTH: f64 = 640.;
/// Gap between the panel and the screen edges, in logical pixels.
const MARGIN: f64 = 8.;
/// Images over this size are refused before decoding.
const MAX_IMAGE: usize = 15 * 1024 * 1024;

/// Where the panel lives. Without a saved spot it opens tall against the
/// right edge; once the user drags it, it stays where it was dropped.
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq)]
struct Place {
    width: f64,
    #[serde(default)]
    height: Option<f64>,
    /// Top-left corner in physical pixels, set when the user moves it.
    #[serde(default)]
    pos: Option<(i32, i32)>,
}
impl Default for Place {
    fn default() -> Self {
        Self {
            width: WIDTH,
            height: None,
            pos: None,
        }
    }
}
pub struct ChatWindow {
    place: Mutex<Option<(Place, Option<Instant>)>>,
    moves: AtomicU64,
    release: IdleRelease,
    focus_turn: Mutex<Option<(i64, i64)>>,
    /// Set when the panel should open on 翻译记录 rather than chat.
    translations: AtomicBool,
    /// Last view shown inside the panel within this session.
    last_translations: AtomicBool,
    /// Always-on-top pin preference kept across auto-release rebuilds.
    pinned: AtomicBool,
}
impl Default for ChatWindow {
    fn default() -> Self {
        Self {
            place: Mutex::new(None),
            moves: AtomicU64::new(0),
            release: IdleRelease::default(),
            focus_turn: Mutex::new(None),
            translations: AtomicBool::new(false),
            last_translations: AtomicBool::new(false),
            pinned: AtomicBool::new(true),
        }
    }
}
/// Open the panel on its 翻译记录 page.
pub fn show_translations(app: &AppHandle) -> Result<(), String> {
    let s = app.state::<ChatWindow>();
    s.translations.store(true, Ordering::SeqCst);
    s.last_translations.store(true, Ordering::SeqCst);
    open_chat_window(app.clone())?;
    let _ = app.emit_to(LABEL, "chat-translations", ());
    Ok(())
}
/// The panel asks once whether to show 翻译记录 when it opens.
#[tauri::command]
pub fn take_translations_request(app: AppHandle) -> bool {
    app.state::<ChatWindow>()
        .translations
        .swap(false, Ordering::SeqCst)
}

#[tauri::command]
pub fn open_chat_turn(app: AppHandle, topic: i64, turn: i64) -> Result<(), String> {
    *app.state::<ChatWindow>().focus_turn.lock().unwrap() = Some((topic, turn));
    open_chat_window(app)
}
#[tauri::command]
pub fn take_chat_turn(app: AppHandle) -> Option<(i64, i64)> {
    app.state::<ChatWindow>().focus_turn.lock().unwrap().take()
}

fn file(app: &AppHandle) -> std::path::PathBuf {
    app.state::<State>().root.join("chat-window.json")
}
fn place(app: &AppHandle) -> Place {
    if let Some((p, _)) = app.state::<ChatWindow>().place.lock().unwrap().clone() {
        return p;
    }
    let mut p: Place = std::fs::read(file(app))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    p.width = p.width.clamp(MIN_WIDTH, MAX_WIDTH);
    p
}
/// A tall panel against the right edge of the work area: (x, y, width, height).
fn docked(width: u32, margin: u32, area: (i32, i32, u32, u32)) -> (i32, i32, u32, u32) {
    let (left, top, w, h) = area;
    let width = width.min(w.saturating_sub(2 * margin));
    (
        left + w as i32 - width as i32 - margin as i32,
        top + margin as i32,
        width,
        h.saturating_sub(2 * margin),
    )
}
/// True when a corner at `pos` leaves at least `keep` pixels of the panel on
/// one of the screens (x, y, width, height).
fn visible_on(pos: (i32, i32), keep: i32, screens: &[(i32, i32, u32, u32)]) -> bool {
    screens.iter().any(|&(x, y, w, h)| {
        pos.0 >= x - keep
            && pos.0 < x + w as i32 - keep
            && pos.1 >= y
            && pos.1 < y + h as i32 - keep
    })
}
/// Put the panel where the user left it, or tall on the right of the pet's screen.
fn dock(app: &AppHandle, w: &WebviewWindow) -> Result<(), String> {
    let p = place(app);
    let screens: Vec<_> = w
        .available_monitors()
        .unwrap_or_default()
        .iter()
        .map(|m| {
            (
                m.position().x,
                m.position().y,
                m.size().width,
                m.size().height,
            )
        })
        .collect();
    if let Some(pos) = p.pos.filter(|&pos| visible_on(pos, 80, &screens)) {
        let scale = w.scale_factor().map_err(|e| e.to_string())?;
        let height = p.height.unwrap_or(640.);
        w.set_size(PhysicalSize::new(
            (p.width * scale) as u32,
            (height * scale) as u32,
        ))
        .map_err(|e| e.to_string())?;
        if w.outer_position().ok() != Some(PhysicalPosition::new(pos.0, pos.1)) {
            w.set_position(PhysicalPosition::new(pos.0, pos.1))
                .map_err(|e| e.to_string())?;
        }
        return Ok(());
    }
    let pet = match app.get_webview_window("pet") {
        Some(pet) => pet.current_monitor().map_err(|e| e.to_string())?,
        None => None,
    };
    let Some(mon) = pet.or(w.primary_monitor().map_err(|e| e.to_string())?) else {
        return Ok(());
    };
    let scale = mon.scale_factor();
    let area = mon.work_area();
    let (x, y, width, height) = docked(
        (p.width * scale) as u32,
        (MARGIN * scale) as u32,
        (
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
        ),
    );
    w.set_size(PhysicalSize::new(width, height))
        .map_err(|e| e.to_string())?;
    w.set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())
}
fn window(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    let pinned = app.state::<ChatWindow>().pinned.load(Ordering::SeqCst);
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?chat".into()))
        .incognito(cfg!(any(feature = "acceptance", feature = "trial")))
        .title(t("host.titleChatWindow"))
        .transparent(true)
        .decorations(false)
        .shadow(true)
        .always_on_top(pinned)
        .skip_taskbar(true)
        .resizable(true)
        .min_inner_size(MIN_WIDTH, 360.)
        .max_inner_size(MAX_WIDTH, 10_000.)
        .inner_size(WIDTH, 640.)
        .visible(false)
        .build()
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn open_chat_window(app: AppHandle) -> Result<(), String> {
    app.state::<ChatWindow>().release.cancel();
    let w = window(&app)?;
    dock(&app, &w)?;
    chat::hide_bubble(app.clone())?;
    let _ = app.emit_to("bubble", "bubble-panel-open", ());
    w.show().map_err(|e| e.to_string())?;
    crate::window_memory::shown(&w);
    w.set_focus().map_err(|e| e.to_string())?;
    app.emit_to(LABEL, "chat-window-open", ())
        .map_err(|e| e.to_string())
}
/// The side-panel shortcut: open it, bring it forward, or put it away.
pub fn toggle(app: &AppHandle) -> Result<(), String> {
    match app.get_webview_window(LABEL) {
        Some(w) if w.is_visible().unwrap_or(false) && w.is_focused().unwrap_or(false) => app
            .emit_to(LABEL, "chat-window-close", ())
            .map_err(|e| e.to_string()),
        _ => open_chat_window(app.clone()),
    }
}
fn write(app: &AppHandle) {
    let state = app.state::<ChatWindow>();
    let mut slot = state.place.lock().unwrap();
    if let Some((p, last)) = slot.as_mut() {
        let _ = library::write_json(&file(app), p);
        *last = Some(Instant::now());
    }
}
fn update(app: &AppHandle, change: impl FnOnce(&mut Place)) {
    let mut p = place(app);
    change(&mut p);
    let due = {
        let state = app.state::<ChatWindow>();
        let mut slot = state.place.lock().unwrap();
        let last = slot.as_ref().and_then(|s| s.1);
        *slot = Some((p, last));
        last.is_none_or(|t| t.elapsed().as_secs() >= 1)
    };
    if due {
        write(app);
    }
}
/// Called on every resize; keeps the size, writing at most once a second.
pub fn remember(w: &WebviewWindow) {
    let (Ok(size), Ok(scale)) = (w.inner_size(), w.scale_factor()) else {
        return;
    };
    let width = (f64::from(size.width) / scale).clamp(MIN_WIDTH, MAX_WIDTH);
    let height = f64::from(size.height) / scale;
    update(w.app_handle(), |p| {
        p.width = width;
        p.height = Some(height);
    });
}
/// Called on every move. Once the window stops moving, remember where it is;
/// it stays exactly there, with no snapping.
pub fn moved(w: &WebviewWindow) {
    let app = w.app_handle().clone();
    let id = app
        .state::<ChatWindow>()
        .moves
        .fetch_add(1, Ordering::SeqCst)
        + 1;
    let w = w.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_millis(300));
        if app.state::<ChatWindow>().moves.load(Ordering::SeqCst) != id
            || !w.is_visible().unwrap_or(false)
        {
            return;
        }
        let (Ok(pos), Ok(size), Ok(scale)) = (w.outer_position(), w.inner_size(), w.scale_factor())
        else {
            return;
        };
        update(&app, |p| {
            p.pos = Some((pos.x, pos.y));
            p.height = Some(f64::from(size.height) / scale);
        });
        write(&app);
    });
}
/// The panel was hidden: release its WebView if it stays hidden and idle.
pub fn hidden(app: &AppHandle) {
    idle_release::schedule::<ChatWindow, _>(
        app,
        LABEL,
        "chat-release-check",
        |s| &s.release,
        chat::busy,
    );
}
#[tauri::command]
pub fn chat_window_release(app: AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    if !app
        .state::<ChatWindow>()
        .release
        .confirm(w.is_visible().unwrap_or(true), chat::busy(&app))
    {
        return;
    }
    idle_release::destroy_later(w);
}
#[tauri::command]
pub fn chat_window_remember_view(app: AppHandle, translations: bool) {
    app.state::<ChatWindow>()
        .last_translations
        .store(translations, Ordering::SeqCst);
}
#[tauri::command]
pub fn chat_window_state(app: AppHandle) -> Value {
    let s = app.state::<ChatWindow>();
    json!({
        "pinned": s.pinned.load(Ordering::SeqCst),
        "translations": s.last_translations.load(Ordering::SeqCst),
    })
}
#[tauri::command]
pub fn hide_chat_window(app: AppHandle, return_to_bubble: Option<bool>) -> Result<(), String> {
    if return_to_bubble == Some(true) && app.get_webview_window("bubble").is_some() {
        chat::show(&app, json!({"mode":"return-input","at":chat::now()}), true)?;
    }
    write(&app);
    if let Some(w) = app.get_webview_window(LABEL) {
        w.hide().map_err(|e| e.to_string())?;
        crate::window_memory::hidden(&w);
        hidden(&app);
    }
    Ok(())
}
#[tauri::command]
pub fn pin_chat_window(app: AppHandle, on: bool) -> Result<(), String> {
    app.state::<ChatWindow>()
        .pinned
        .store(on, Ordering::SeqCst);
    app.get_webview_window(LABEL)
        .ok_or(t("host.panelClosed"))?
        .set_always_on_top(on)
        .map_err(|e| e.to_string())
}

// ---------- topics, shared with the chat page ----------
fn dir(app: &AppHandle) -> std::path::PathBuf {
    app.state::<Companion>().dir.clone()
}
#[tauri::command]
pub fn chat_topics(app: AppHandle, query: String) -> Result<Vec<topics::Topic>, String> {
    topics::list(&dir(&app), &query).map_err(|_| t("host.topicsRead").into())
}
#[tauri::command]
pub fn chat_topic_turns(app: AppHandle, id: i64) -> Result<Vec<history::Turn>, String> {
    topics::turns(&dir(&app), id).map_err(|_| t("host.topicsRead").into())
}
/// The topic the next message continues, with its turns; empty when a new one would start.
#[tauri::command]
pub fn current_chat_topic(app: AppHandle) -> Result<Value, String> {
    let pet = chat::pet(&app)?.0;
    let d = dir(&app);
    match topics::current(&d, &pet, chat::now()).map_err(|_| t("host.topicsRead"))? {
        Some(id) => {
            Ok(json!({"id":id,"turns":topics::turns(&d, id).map_err(|_| t("host.topicsRead"))?}))
        }
        None => Ok(json!({"id":null,"turns":[]})),
    }
}
#[tauri::command]
pub fn linked_topic_tasks(app: AppHandle, id: i64) -> Result<Vec<topics::LinkedTask>, String> {
    topics::linked_tasks(&dir(&app), id)
}
#[tauri::command]
pub fn delete_chat_topic(
    app: AppHandle,
    id: i64,
    remove_tasks: bool,
    expected: Vec<i64>,
) -> Result<(), String> {
    if chat::busy(&app) {
        return Err(t("host.finishReply").into());
    }
    topics::delete_with_tasks(&dir(&app), id, remove_tasks, &expected)?;
    if remove_tasks {
        app.state::<Companion>().host.alarm.changed();
        let _ = app.emit("reminders-changed", ());
    }
    let _ = app.emit("chat-updated", ());
    Ok(())
}
#[tauri::command]
pub fn reopen_chat_topic(app: AppHandle, id: i64) -> Result<(), String> {
    if chat::busy(&app) {
        return Err(t("chat.stopFirst").into());
    }
    let pet = chat::pet(&app)?.0;
    topics::reopen(&dir(&app), id, &pet, chat::now()).map_err(|_| t("host.topicDeleted"))?;
    let _ = app.emit("chat-updated", ());
    Ok(())
}

/// Turn an image the user attached into the brain's image part, at most 1568 px on the long edge.
pub fn attached_picture(data: &str) -> Result<crate::chat_images::Picture, String> {
    if data.len() > MAX_IMAGE.div_ceil(3) * 4 {
        return Err(t("host.imageTooBig").into());
    }
    let bytes = STANDARD.decode(data).map_err(|_| t("host.imageBad"))?;
    // The window converts every picture to PNG first, so no extra decoders are needed here.
    let img = image::load_from_memory(&bytes).map_err(|_| t("host.imageBad"))?;
    let png = crate::capture_image::png(img.to_rgba8())?;
    crate::chat_images::Picture::new(png)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn docks_tall_on_the_right_until_moved() {
        assert_eq!(docked(400, 8, (0, 25, 1440, 875)), (1032, 33, 400, 859));
        // A screen with a negative origin, and a width larger than the screen.
        assert_eq!(docked(900, 8, (-800, 0, 800, 600)), (-792, 8, 784, 584));
        let screens = [(0, 0, 1440, 900), (-1920, 0, 1920, 1080)];
        assert!(visible_on((1000, 100), 80, &screens));
        assert!(visible_on((-1500, 200), 80, &screens));
        // A spot left on a screen that is no longer attached: dock again.
        assert!(!visible_on((3000, 100), 80, &screens));
    }
    #[test]
    fn attached_images_are_checked_and_shrunk() {
        let mut big = Vec::new();
        image::DynamicImage::new_rgba8(3000, 1000)
            .write_to(&mut std::io::Cursor::new(&mut big), image::ImageFormat::Png)
            .unwrap();
        let png = attached_picture(&STANDARD.encode(&big)).unwrap().png;
        let img = image::load_from_memory(&png).unwrap();
        assert_eq!((img.width(), img.height()), (1568, 522));
        assert!(attached_picture(&STANDARD.encode(b"not an image")).is_err());
    }
}
