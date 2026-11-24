//! Shared idle-release primitive for low-frequency heavy windows (`studio`,
//! `chat`). Closing hides the window for instant reopen; after staying hidden
//! for `RELEASE_AFTER`, the host asks the page whether anything unsaved would
//! be lost, and destroys the WebView only if that same hide turn is still live.
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};

/// Hidden and idle this long, the WebView is released to reclaim memory.
pub const RELEASE_AFTER: Duration = Duration::from_secs(60);

#[derive(Default)]
pub struct IdleRelease {
    /// Increments on every show and hide so stale timers cancel automatically.
    turn: AtomicU64,
    /// The hide turn for which the latest release-check event was emitted.
    asked_turn: AtomicU64,
}

impl IdleRelease {
    /// Cancels any scheduled release (call when showing/opening the window).
    pub fn cancel(&self) {
        self.turn.fetch_add(1, Ordering::SeqCst);
    }

    /// Starts a new hide cycle and returns its turn token.
    pub fn begin_hide(&self) -> u64 {
        self.turn.fetch_add(1, Ordering::SeqCst) + 1
    }

    /// Records that `turn` is due to ask the page, if nothing superseded it.
    pub fn mark_asked(&self, turn: u64, exists: bool, visible: bool, busy: bool) -> bool {
        let now = self.turn.load(Ordering::SeqCst);
        if !due(turn, now, exists, visible, busy) {
            return false;
        }
        self.asked_turn.store(turn, Ordering::SeqCst);
        true
    }

    /// Confirms a page's release reply still belongs to the latest hidden turn.
    pub fn confirm(&self, visible: bool, busy: bool) -> bool {
        !visible
            && !busy
            && self.turn.load(Ordering::SeqCst) == self.asked_turn.load(Ordering::SeqCst)
    }
}

pub fn due(turn_then: u64, turn_now: u64, exists: bool, visible: bool, busy: bool) -> bool {
    turn_then == turn_now && exists && !visible && !busy
}

/// Schedules a release check for `label` after `RELEASE_AFTER`.
pub fn schedule<S, F>(
    app: &AppHandle,
    label: &'static str,
    check_event: &'static str,
    get: fn(&S) -> &IdleRelease,
    busy: F,
) where
    S: Send + Sync + 'static,
    F: Fn(&AppHandle) -> bool + Send + 'static,
{
    let turn = get(&app.state::<S>()).begin_hide();
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(RELEASE_AFTER);
        let w = app.get_webview_window(label);
        let visible = w.as_ref().is_some_and(|w| w.is_visible().unwrap_or(true));
        if get(&app.state::<S>()).mark_asked(turn, w.is_some(), visible, busy(&app)) {
            let _ = app.emit_to(label, check_event, ());
        }
    });
}

/// Destroys a WebView window on a worker thread (destroying inside a command
/// handler can deadlock on Windows).
pub fn destroy_later(w: WebviewWindow) {
    std::thread::spawn(move || {
        let _ = w.destroy();
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn releases_only_when_same_hide_turn_stays_hidden_and_idle() {
        assert_eq!(RELEASE_AFTER, Duration::from_secs(60));
        assert!(due(3, 3, true, false, false));
        assert!(!due(3, 4, true, false, false));
        assert!(!due(3, 3, true, true, false));
        assert!(!due(3, 3, false, false, false));
        assert!(!due(3, 3, true, false, true));

        let gate = IdleRelease::default();
        let turn = gate.begin_hide();
        assert!(gate.mark_asked(turn, true, false, false));
        assert!(gate.confirm(false, false));
        assert!(!gate.confirm(true, false));
        assert!(!gate.confirm(false, true));

        // Reopening cancels any in-flight release reply.
        gate.cancel();
        assert!(!gate.confirm(false, false));
    }
}
