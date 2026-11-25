//! Translate freshly copied text after two quick copies of the same selection.
//!
//! - On macOS, uses a zero-permission clipboard state machine with 5 false-positive
//!   guardrails (same foreground app, 65–750ms gap, identical non-empty text,
//!   concealed/password-manager/own-write exclusions, and 900ms cooldown) so Suiby
//!   never needs Input Monitoring or triggers macOS's persistent "Accessing all apps"
//!   indicator.
//! - On Windows, uses the native copy-key monitor (`copy-keys.cpp`).
use crate::{chat, companion::Companion, selection};
use serde_json::json;
#[cfg(any(windows, feature = "acceptance"))]
use std::sync::{mpsc, OnceLock};
use std::{
    ffi::{c_char, CStr},
    sync::atomic::{AtomicIsize, Ordering},
    time::Duration,
};
#[cfg(target_os = "macos")]
use std::time::Instant;
#[cfg(any(windows, target_os = "macos"))]
use tauri::Listener;
use tauri::{AppHandle, Manager};

/// Maximum gap (ms) between two Windows key presses to count as one double copy.
#[cfg(any(windows, test))]
const WINDOW_MS: u64 = 800;

/// macOS zero-permission detector timing guardrails.
#[cfg(any(target_os = "macos", test))]
const MAC_POLL_ON: Duration = Duration::from_millis(50);
#[cfg(target_os = "macos")]
const MAC_POLL_OFF: Duration = Duration::from_millis(500);
#[cfg(any(target_os = "macos", test))]
const MAC_MIN_GAP_MS: u64 = 65;
#[cfg(any(target_os = "macos", test))]
const MAC_MAX_GAP_MS: u64 = 750;
#[cfg(any(target_os = "macos", test))]
const MAC_COOLDOWN_MS: u64 = 900;

/// The counter right after 随伴 itself wrote the clipboard (复制 a translation).
pub static OWN_WRITE: AtomicIsize = AtomicIsize::new(-1);

#[cfg(any(windows, target_os = "macos"))]
extern "C" {
    fn companion_clipboard_count() -> isize;
    #[cfg(windows)]
    fn companion_clipboard_text() -> *mut c_char;
    fn companion_free(text: *mut c_char);
    fn companion_target() -> isize;
}
#[cfg(target_os = "macos")]
extern "C" {
    fn companion_temporary_sequence() -> isize;
    fn clip_source(allow_image: i32) -> *mut c_char;
    fn clip_plain() -> *mut c_char;
}
#[cfg(windows)]
extern "C" {
    fn companion_copy_monitor(enabled: i32);
}

pub fn count() -> isize {
    #[cfg(any(windows, target_os = "macos"))]
    return unsafe { companion_clipboard_count() };
    #[cfg(not(any(windows, target_os = "macos")))]
    0
}

#[cfg(windows)]
fn text() -> String {
    unsafe {
        let p = companion_clipboard_text();
        if p.is_null() {
            return String::new();
        }
        let s = CStr::from_ptr(p).to_string_lossy().into_owned();
        companion_free(p);
        s
    }
}

#[cfg(target_os = "macos")]
fn mac_safe_text() -> Option<String> {
    let _guard = selection::CLIPBOARD.try_lock().ok()?;
    let src_ptr = unsafe { clip_source(0) };
    if src_ptr.is_null() {
        return None;
    }
    let src = unsafe { CStr::from_ptr(src_ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { companion_free(src_ptr) };
    if crate::clipboard::is_password_manager(&src) {
        return None;
    }
    let txt_ptr = unsafe { clip_plain() };
    if txt_ptr.is_null() {
        return None;
    }
    let txt = unsafe { CStr::from_ptr(txt_ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { companion_free(txt_ptr) };
    Some(txt)
}

#[cfg(any(windows, feature = "acceptance", test))]
#[derive(Clone, Copy)]
struct Press {
    ms: u64,
    owner: isize,
    before: isize,
}
#[cfg(any(windows, feature = "acceptance"))]
enum Event {
    Press(Press),
    Reset,
}
#[cfg(any(windows, feature = "acceptance"))]
static EVENTS: OnceLock<mpsc::Sender<Event>> = OnceLock::new();

#[cfg(any(windows, feature = "acceptance"))]
#[no_mangle]
pub(crate) extern "C" fn companion_copy_press(ms: u64, owner: isize, before: isize) {
    if let Some(tx) = EVENTS.get() {
        let _ = tx.send(Event::Press(Press { ms, owner, before }));
    }
}

#[cfg(any(windows, test))]
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
#[cfg(any(windows, test))]
fn same_copy(prior: Option<&(isize, String)>, before: isize, text: &str) -> bool {
    prior.is_some_and(|(seq, first)| *seq == before && first == text)
}

/// Zero-permission macOS double-copy recognizer with 5 false-positive guardrails.
#[cfg(any(target_os = "macos", test))]
#[derive(Default)]
struct MacDoubleCopy {
    armed: Option<Armed>,
    last_trigger_ms: Option<u64>,
}
#[cfg(any(target_os = "macos", test))]
struct Armed {
    seq: isize,
    ms: u64,
    owner: isize,
    text: String,
}
#[cfg(any(target_os = "macos", test))]
impl MacDoubleCopy {
    fn reset(&mut self) {
        self.armed = None;
    }

    /// Observe a fresh clipboard write. Returns `Some(first_seq)` when a valid
    /// double copy completes.
    fn observe(&mut self, seq: isize, ms: u64, owner: isize, text: &str) -> Option<isize> {
        if owner <= 0 || text.trim().is_empty() {
            self.armed = None;
            return None;
        }
        if self
            .last_trigger_ms
            .is_some_and(|at| ms.saturating_sub(at) < MAC_COOLDOWN_MS)
        {
            self.armed = None;
            return None;
        }
        if let Some(prev) = self.armed.as_mut() {
            if prev.owner == owner && prev.text == text {
                let dt = ms.saturating_sub(prev.ms);
                if dt < MAC_MIN_GAP_MS {
                    // Single copy writing multiple formats (e.g. text + RTF) across adjacent ticks:
                    // keep armed with the latest seq/time, never trigger.
                    prev.seq = seq;
                    prev.ms = ms;
                    return None;
                }
                if dt <= MAC_MAX_GAP_MS {
                    let first_seq = prev.seq;
                    self.armed = None;
                    self.last_trigger_ms = Some(ms);
                    return Some(first_seq);
                }
            }
        }
        self.armed = Some(Armed {
            seq,
            ms,
            owner,
            text: text.to_owned(),
        });
        None
    }
}

fn on(app: &AppHandle) -> bool {
    let state = app.state::<Companion>();
    let s = state.settings.lock().unwrap();
    s.enabled && s.translation && s.copy_twice
}

#[tauri::command]
pub fn copy_key_access() -> bool {
    // macOS uses the zero-permission clipboard recognizer; no Input Monitoring needed.
    true
}

#[tauri::command]
pub fn copy_key_preferences(_app: AppHandle) {}

pub fn refresh(app: &AppHandle) {
    if cfg!(feature = "acceptance") {
        return;
    }
    #[cfg(windows)]
    if EVENTS.get().is_some() {
        let app = app.clone();
        let handle = app.clone();
        let _ =
            handle.run_on_main_thread(move || unsafe { companion_copy_monitor(on(&app) as i32) });
    }
    #[cfg(not(windows))]
    let _ = app;
}

#[cfg(target_os = "macos")]
pub fn watch(app: AppHandle) {
    use std::sync::atomic::AtomicBool;
    static STARTED: AtomicBool = AtomicBool::new(false);
    if STARTED.swap(true, Ordering::SeqCst) {
        return;
    }
    static RESET_FLAG: AtomicBool = AtomicBool::new(false);
    app.listen("companion-settings", |_| {
        RESET_FLAG.store(true, Ordering::SeqCst);
    });
    std::thread::Builder::new()
        .name("copy-twice-mac".into())
        .spawn(move || {
            let started = Instant::now();
            let mut detector = MacDoubleCopy::default();
            let mut prev_seq = count();
            loop {
                if !on(&app) {
                    detector.reset();
                    prev_seq = count();
                    std::thread::sleep(MAC_POLL_OFF);
                    continue;
                }
                std::thread::sleep(MAC_POLL_ON);
                if RESET_FLAG.swap(false, Ordering::SeqCst) {
                    detector.reset();
                    prev_seq = count();
                    continue;
                }
                if !on(&app) {
                    detector.reset();
                    prev_seq = count();
                    continue;
                }
                let seq = count();
                if seq == prev_seq {
                    continue;
                }
                if selection::clipboard_busy() {
                    detector.reset();
                    prev_seq = seq;
                    continue;
                }
                if seq == OWN_WRITE.load(Ordering::SeqCst)
                    || seq == unsafe { companion_temporary_sequence() }
                {
                    detector.reset();
                    prev_seq = seq;
                    continue;
                }
                let now = started.elapsed().as_millis() as u64;
                let owner = unsafe { companion_target() };
                let recording = crate::clipboard::enabled(&app);
                let sample = if recording {
                    crate::clipboard::key_sample(&app, seq)
                } else {
                    mac_safe_text()
                };
                // If another clipboard write landed while reading, leave prev_seq at seq
                // so the newer write is picked up cleanly on the very next poll.
                prev_seq = seq;
                if count() != seq {
                    continue;
                }
                let Some(copied) = sample.filter(|s| !s.trim().is_empty()) else {
                    detector.reset();
                    continue;
                };
                if let Some(first_seq) = detector.observe(seq, now, owner, &copied) {
                    crate::clipboard::translated(&app, first_seq, seq);
                    let ts = chat::now();
                    let _ = chat::show(
                        &app,
                        json!({
                            "mode": "translate",
                            "source": copied,
                            "at": ts,
                            "generation": ts,
                            "source_kind": "copy",
                            "target": owner
                        }),
                        false,
                    );
                    crate::tips::used(&app, "copy-translate");
                }
            }
        })
        .expect("spawn copy-twice-mac");
}

#[cfg(windows)]
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

#[cfg(not(any(windows, target_os = "macos")))]
pub fn watch(_app: AppHandle) {}

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

    #[test]
    fn mac_double_copy_triggers_on_same_app_same_text_in_window() {
        let mut d = MacDoubleCopy::default();
        assert_eq!(d.observe(30, 1000, 42, "hello world"), None);
        assert_eq!(d.observe(31, 1200, 42, "hello world"), Some(30));
    }

    #[test]
    fn mac_double_copy_blocks_single_copy_multi_format_writes() {
        let mut d = MacDoubleCopy::default();
        assert_eq!(d.observe(10, 1000, 42, "rich text"), None);
        // App writes RTF 50ms later on adjacent poll tick: must NOT trigger.
        assert_eq!(d.observe(11, 1050, 42, "rich text"), None);
        // Real second Cmd+C 180ms later: triggers cleanly using updated seq.
        assert_eq!(d.observe(12, 1230, 42, "rich text"), Some(11));
    }

    #[test]
    fn mac_double_copy_blocks_different_text_and_different_app() {
        let mut d = MacDoubleCopy::default();
        assert_eq!(d.observe(10, 1000, 42, "姓名"), None);
        // Different text 200ms later: ignored, arms the new text instead.
        assert_eq!(d.observe(11, 1200, 42, "地址"), None);
        // Different app with same text 200ms later: ignored, arms the new app.
        assert_eq!(d.observe(12, 1400, 99, "地址"), None);
        // Second press in that new app 180ms later: triggers cleanly.
        assert_eq!(d.observe(13, 1580, 99, "地址"), Some(12));
    }

    #[test]
    fn mac_double_copy_blocks_slow_recopy_and_triple_press_cooldown() {
        let mut d = MacDoubleCopy::default();
        assert_eq!(d.observe(33, 1000, 42, "same text"), None);
        // 3.4s later (> 750ms): ignored, re-armed.
        assert_eq!(d.observe(34, 4404, 42, "same text"), None);
        // 218ms later: triggers.
        assert_eq!(d.observe(35, 4622, 42, "same text"), Some(34));
        // 3rd press 226ms later (within 900ms cooldown): blocked.
        assert_eq!(d.observe(36, 4848, 42, "same text"), None);
        // After cooldown expires, a fresh double-copy works again.
        assert_eq!(d.observe(37, 5600, 42, "same text"), None);
        assert_eq!(d.observe(38, 5780, 42, "same text"), Some(37));
    }

    #[test]
    fn mac_double_copy_reset_clears_armed_state() {
        let mut d = MacDoubleCopy::default();
        assert_eq!(d.observe(10, 1000, 42, "secret"), None);
        d.reset();
        assert_eq!(d.observe(11, 1200, 42, "secret"), None);
    }

    #[test]
    fn mac_poll_interval_stays_below_min_gap_guard() {
        assert!((MAC_POLL_ON.as_millis() as u64) < MAC_MIN_GAP_MS);
        assert!(MAC_MIN_GAP_MS < MAC_MAX_GAP_MS);
    }
}
