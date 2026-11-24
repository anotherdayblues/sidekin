//! Translate freshly copied text after two distinct system copy key presses.
use crate::{chat, companion::Companion, selection};
use serde_json::json;
use std::sync::{mpsc, OnceLock};
use std::{
    ffi::{c_char, CStr},
    sync::atomic::{AtomicIsize, Ordering},
    time::Duration,
};
use tauri::{AppHandle, Listener, Manager};

/// Two copies at most this far apart count as one double copy.
const WINDOW_MS: u64 = 800;
/// The counter right after 随伴 itself wrote the clipboard (复制 a translation).
pub static OWN_WRITE: AtomicIsize = AtomicIsize::new(-1);

#[cfg(any(windows, target_os = "macos"))]
extern "C" {
    fn companion_clipboard_count() -> isize;
    fn companion_clipboard_text() -> *mut c_char;
    fn companion_free(text: *mut c_char);
}
pub fn count() -> isize {
    #[cfg(any(windows, target_os = "macos"))]
    return unsafe { companion_clipboard_count() };
    #[cfg(not(any(windows, target_os = "macos")))]
    0
}
fn text() -> String {
    #[cfg(any(windows, target_os = "macos"))]
    unsafe {
        let p = companion_clipboard_text();
        if p.is_null() {
            return String::new();
        }
        let s = CStr::from_ptr(p).to_string_lossy().into_owned();
        companion_free(p);
        s
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    String::new()
}

#[derive(Clone, Copy)]
struct Press {
    ms: u64,
    owner: isize,
    before: isize,
}
enum Event {
    Press(Press),
    Reset,
}
static EVENTS: OnceLock<mpsc::Sender<Event>> = OnceLock::new();

#[no_mangle]
pub(crate) extern "C" fn companion_copy_press(ms: u64, owner: isize, before: isize) {
    if let Some(tx) = EVENTS.get() {
        let _ = tx.send(Event::Press(Press { ms, owner, before }));
    }
}

fn paired(first: &mut Option<Press>, next: Press) -> bool {
    if first.take().is_some_and(|p| {
        next.owner != 0
            && next.owner == p.owner
            && next.ms.checked_sub(p.ms).is_some_and(|dt| dt <= WINDOW_MS)
            && p.before != next.before
    }) {
        return true;
    }
    *first = Some(next);
    false
}
fn same_copy(prior: Option<&(isize, String)>, before: isize, text: &str) -> bool {
    prior.is_some_and(|(seq, first)| *seq == before && first == text)
}
fn on(app: &AppHandle) -> bool {
    let state = app.state::<Companion>();
    let s = state.settings.lock().unwrap();
    s.enabled && s.translation && s.copy_twice
}
#[cfg(any(windows, target_os = "macos"))]
extern "C" {
    fn companion_copy_monitor(enabled: i32);
    fn companion_target() -> isize;
}
#[cfg(target_os = "macos")]
extern "C" {
    fn companion_copy_permission() -> i32;
    fn companion_request_copy_permission();
}

#[tauri::command]
pub fn copy_key_access() -> bool {
    #[cfg(target_os = "macos")]
    return unsafe { companion_copy_permission() != 0 };
    #[cfg(not(target_os = "macos"))]
    true
}
#[tauri::command]
pub fn copy_key_preferences(app: AppHandle) {
    #[cfg(target_os = "macos")]
    let _ = app.run_on_main_thread(|| unsafe { companion_request_copy_permission() });
    #[cfg(not(target_os = "macos"))]
    let _ = app;
}
pub fn refresh(app: &AppHandle) {
    if cfg!(feature = "acceptance") {
        return;
    }
    #[cfg(any(windows, target_os = "macos"))]
    if EVENTS.get().is_some() {
        let app = app.clone();
        let handle = app.clone();
        let _ =
            handle.run_on_main_thread(move || unsafe { companion_copy_monitor(on(&app) as i32) });
    }
}
pub fn watch(app: AppHandle) {
    let (tx, rx) = mpsc::channel();
    if EVENTS.set(tx.clone()).is_err() {
        return;
    }
    let settings_app = app.clone();
    app.listen("companion-settings", move |_| {
        let _ = tx.send(Event::Reset);
        refresh(&settings_app);
    });
    refresh(&app);
    std::thread::spawn(move || {
        let mut first = None;
        let mut previous: Option<(isize, String)> = None;
        for event in rx {
            let Event::Press(key) = event else {
                first = None;
                continue;
            };
            if !on(&app) || selection::clipboard_busy() {
                first = None;
                continue;
            }
            let pair = paired(&mut first, key);
            let recording = crate::clipboard::enabled(&app);
            if !pair && !recording {
                previous = None;
                continue;
            }
            let prior = previous.take();
            // While history is on, stage each real copy. The two writes of a
            // translation can then be cancelled without touching older entries.
            for _ in 0..25 {
                std::thread::sleep(Duration::from_millis(10));
                #[cfg(any(windows, target_os = "macos"))]
                if unsafe { companion_target() } != key.owner {
                    break;
                }
                if !on(&app) || selection::clipboard_busy() {
                    break;
                }
                let after = count();
                if after == key.before {
                    continue;
                }
                if after == OWN_WRITE.load(Ordering::SeqCst) {
                    break;
                }
                let copied = if recording {
                    let Some(s) = crate::clipboard::key_sample(&app, after) else {
                        continue;
                    };
                    s
                } else {
                    text()
                };
                if copied.trim().is_empty() || count() != after {
                    continue;
                }
                if !pair || (recording && !same_copy(prior.as_ref(), key.before, &copied)) {
                    first = Some(key);
                    previous = Some((after, copied));
                    break;
                }
                crate::clipboard::translated(&app, key.before, after);
                let now = chat::now();
                let _ = chat::show(
                    &app,
                    json!({"mode":"translate","source":copied,"at":now,"generation":now,"source_kind":"copy","target":key.owner}),
                    false,
                );
                crate::tips::used(&app, "copy-translate");
                break;
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    fn press(ms: u64, owner: isize, before: isize) -> Press {
        Press { ms, owner, before }
    }
    #[test]
    fn different_content_never_counts_as_a_translation_pair() {
        let prior = (22, "姓名".to_string());
        assert!(!same_copy(Some(&prior), 22, "地址"));
        assert!(!same_copy(Some(&prior), 23, "姓名"));
        assert!(same_copy(Some(&prior), 22, "姓名"));
    }
    #[test]
    fn counts_presses_not_clipboard_writes() {
        let mut first = None;
        assert!(!paired(&mut first, press(0, 1, 10)));
        assert!(paired(&mut first, press(800, 1, 13)));
        assert!(!paired(&mut first, press(900, 1, 15)));
        assert!(!paired(&mut first, press(1701, 1, 16)));
        assert!(!paired(&mut first, press(1710, 2, 17)));
        assert!(!paired(&mut first, press(1730, 2, 17)));
        assert!(paired(&mut first, press(1750, 2, 19)));
    }
}
