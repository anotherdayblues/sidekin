//! 主窗口 (the studio): closing it only hides it, so it is there at once
//! next time. After it has been hidden for a while its page is let go, for
//! the memory (plan/22 M1), unless the page says it holds something not
//! saved yet; opening it again builds it anew. What was sent to it while it
//! was being built waits until the page says it is ready.
use crate::idle_release::{self, IdleRelease};
use serde_json::Value;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Listener, Manager, PhysicalPosition, PhysicalSize};

const LABEL: &str = "studio";
/// A rebuilt studio shows when its page is ready, or after this at most.
const SHOW_ANYWAY: Duration = Duration::from_secs(3);
/// Valid studio top-level blocks remembered across window release/rebuild.
const BLOCKS: [&str; 5] = ["pet", "memory", "reminders", "focus", "settings"];
/// Explicit routing events that should win over restoring the previous block.
const NAV_EVENTS: [&str; 6] = [
    "studio-block",
    "companion-open",
    "guide-open",
    "settings-section",
    "pet-arrived",
    "draft-arrived",
];
/// Sent by other windows' pages, right after asking for the studio, to
/// open it somewhere (the pet's menu, the bubble's tips); kept while the
/// studio is being built.
const FROM_PAGES: [&str; 4] = [
    "companion-open",
    "studio-block",
    "skill-book-open",
    "guide-open",
];

#[derive(Default)]
pub struct Studio {
    release: IdleRelease,
    building: AtomicBool,
    /// From building until the page says it is ready.
    loading: AtomicBool,
    /// Initial hidden studio window created at boot before its first studio_ready.
    not_ready: AtomicBool,
    pending: Mutex<Vec<(String, Value)>>,
    /// Where it was when let go, so it comes back in the same place.
    frame: Mutex<Option<(PhysicalPosition<i32>, PhysicalSize<u32>)>>,
    /// Last active block within this app session so rebuilding lands on it.
    last_block: Mutex<Option<String>>,
}

/// Keeps `event` for the page if it is still being built or booting. Returns
/// whether it was kept.
fn keep(s: &Studio, event: &str, payload: Value) -> bool {
    if !s.loading.load(Ordering::SeqCst) && !s.not_ready.load(Ordering::SeqCst) {
        return false;
    }
    s.pending.lock().unwrap().push((event.into(), payload));
    true
}

/// A page's event for the studio. It is sent right after the page asks for
/// the studio, and may arrive before that request has started the build:
/// with no studio yet it is kept as well.
fn keep_from_page(s: &Studio, exists: bool, event: &str, payload: Value) {
    if !exists && !s.loading.load(Ordering::SeqCst) {
        s.pending.lock().unwrap().push((event.into(), payload));
    } else {
        keep(s, event, payload);
    }
}

/// Sends `event` to the studio, or keeps it until the page is ready.
pub fn emit(app: &AppHandle, event: &str, payload: impl serde::Serialize) {
    let payload = serde_json::to_value(payload).unwrap_or(Value::Null);
    if !keep(&app.state::<Studio>(), event, payload.clone()) {
        let _ = app.emit_to(LABEL, event, payload);
    }
}

/// Like `emit`, for an event every window hears.
pub fn emit_all(app: &AppHandle, event: &str, payload: impl serde::Serialize) {
    let payload = serde_json::to_value(payload).unwrap_or(Value::Null);
    if !keep(&app.state::<Studio>(), event, payload.clone()) {
        let _ = app.emit(event, payload);
    }
}

/// Shows the studio, building it first if it was let go.
pub fn open(app: &AppHandle) -> Result<(), String> {
    let s = app.state::<Studio>();
    s.release.cancel();
    if let Some(w) = app.get_webview_window(LABEL) {
        if s.loading.load(Ordering::SeqCst) {
            return Ok(());
        }
        w.show().map_err(|e| e.to_string())?;
        crate::window_memory::shown(&w);
        return w.set_focus().map_err(|e| e.to_string());
    }
    s.loading.store(true, Ordering::SeqCst);
    if s.building.swap(true, Ordering::SeqCst) {
        return Ok(());
    }
    // Building a window inside a command can hang on Windows.
    let app = app.clone();
    std::thread::spawn(move || {
        if let Err(e) = build(&app) {
            eprintln!("studio: {e}");
            app.state::<Studio>().loading.store(false, Ordering::SeqCst);
        }
        app.state::<Studio>()
            .building
            .store(false, Ordering::SeqCst);
    });
    Ok(())
}

fn build(app: &AppHandle) -> Result<(), String> {
    let mut config = app
        .config()
        .app
        .windows
        .iter()
        .find(|w| w.label == LABEL)
        .cloned()
        .ok_or("no studio window in the config")?;
    config.visible = false;
    config.title = crate::locale::t("host.studioTitle");
    let w = tauri::WebviewWindowBuilder::from_config(app, &config)
        .map_err(|e| e.to_string())?
        .build()
        .map_err(|e| e.to_string())?;
    if let Some((pos, size)) = *app.state::<Studio>().frame.lock().unwrap() {
        let _ = w.set_size(size);
        let _ = w.set_position(pos);
    }
    // It shows when the page is ready (studio_ready): the window is
    // transparent, so before that it would be an empty frame. In case the
    // page never says so, it shows anyway after a moment.
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(SHOW_ANYWAY);
        if app.state::<Studio>().loading.load(Ordering::SeqCst) {
            studio_ready(app);
        }
    });
    Ok(())
}

/// The window was hidden: plan to let it go if it stays hidden.
pub fn hidden(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        crate::window_memory::hidden(&w);
    }
    idle_release::schedule::<Studio, _>(
        app,
        LABEL,
        "studio-release-check",
        |s| &s.release,
        |_| false,
    );
}

/// The page has nothing unsaved: let it go.
#[tauri::command]
pub fn studio_release(app: AppHandle) {
    let Some(w) = app.get_webview_window(LABEL) else {
        return;
    };
    let s = app.state::<Studio>();
    if !s.release.confirm(w.is_visible().unwrap_or(true), false) {
        return;
    }
    if let (Ok(pos), Ok(size)) = (w.outer_position(), w.inner_size()) {
        *s.frame.lock().unwrap() = Some((pos, size));
    }
    idle_release::destroy_later(w);
}

/// Remembers the current studio block so reopening after auto-release lands on it.
#[tauri::command]
pub fn studio_remember_block(app: AppHandle, block: String) {
    if BLOCKS.contains(&block.as_str()) {
        *app.state::<Studio>().last_block.lock().unwrap() = Some(block);
    }
}

fn restorable_block(s: &Studio) -> Option<String> {
    let has_nav = s
        .pending
        .lock()
        .unwrap()
        .iter()
        .any(|(event, _)| NAV_EVENTS.contains(&event.as_str()));
    if has_nav {
        return None;
    }
    s.last_block.lock().unwrap().clone()
}

/// Block to restore when rebuilding a released studio window.
#[tauri::command]
pub fn studio_last_block(app: AppHandle) -> Option<String> {
    restorable_block(&app.state::<Studio>())
}

/// The page is listening: hand it what came while it was being built.
#[tauri::command]
pub fn studio_ready(app: AppHandle) {
    let s = app.state::<Studio>();
    s.not_ready.store(false, Ordering::SeqCst);
    if s.loading.swap(false, Ordering::SeqCst) {
        if let Some(w) = app.get_webview_window(LABEL) {
            let _ = w.show();
            let _ = w.set_focus();
        }
    }
    let pending = std::mem::take(&mut *s.pending.lock().unwrap());
    for (event, payload) in pending {
        let _ = app.emit_to(LABEL, &event, payload);
    }
}

/// At start: other windows' pages may ask for the studio while it is
/// being built; and a studio that starts hidden is let go the same way.
pub fn setup(app: &AppHandle) {
    for event in FROM_PAGES {
        let handle = app.clone();
        app.listen_any(event, move |e| {
            let payload = serde_json::from_str(e.payload()).unwrap_or(Value::Null);
            let exists = handle.get_webview_window(LABEL).is_some();
            keep_from_page(&handle.state::<Studio>(), exists, event, payload);
        });
    }
    if app
        .get_webview_window(LABEL)
        .is_some_and(|w| !w.is_visible().unwrap_or(true))
    {
        app.state::<Studio>().not_ready.store(true, Ordering::SeqCst);
        hidden(app);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn restores_last_block_unless_explicit_navigation_is_pending() {
        let s = Studio::default();
        *s.last_block.lock().unwrap() = Some("focus".into());
        assert_eq!(restorable_block(&s).as_deref(), Some("focus"));
        s.pending
            .lock()
            .unwrap()
            .push(("skill-book-open".into(), Value::Null));
        assert_eq!(restorable_block(&s).as_deref(), Some("focus"));
        s.pending
            .lock()
            .unwrap()
            .push(("studio-block".into(), "settings".into()));
        assert_eq!(restorable_block(&s), None);
    }

    #[test]
    fn a_page_event_that_beats_the_open_request_still_waits() {
        let s = Studio::default();
        // The studio is up: the page hears it directly.
        keep_from_page(&s, true, "studio-block", "settings".into());
        assert!(s.pending.lock().unwrap().is_empty());
        // Let go, and the open request not handled yet: kept.
        keep_from_page(&s, false, "studio-block", "settings".into());
        // Being built: kept too.
        s.loading.store(true, Ordering::SeqCst);
        keep_from_page(&s, true, "skill-book-open", "focus".into());
        assert_eq!(s.pending.lock().unwrap().len(), 2);
    }
    #[test]
    fn what_is_sent_while_it_is_built_waits_in_order() {
        let s = Studio::default();
        assert!(!keep(&s, "companion-open", Value::Bool(false)));
        s.loading.store(true, Ordering::SeqCst);
        assert!(keep(&s, "settings-section", "tools".into()));
        assert!(keep(&s, "companion-open", Value::Bool(true)));
        let kept = s.pending.lock().unwrap().clone();
        assert_eq!(
            kept,
            vec![
                ("settings-section".to_string(), Value::from("tools")),
                ("companion-open".to_string(), Value::Bool(true)),
            ]
        );
    }
}
