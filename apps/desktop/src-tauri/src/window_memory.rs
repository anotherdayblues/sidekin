//! Windows: a window that stays hidden tells WebView2 it may give memory
//! back (MemoryUsageTargetLevel, plan/22 M4); shown again, it goes back to
//! normal. Only after a while hidden, because the bubble comes and goes
//! often and a trimmed page is a little slower to show. Best effort: the
//! system decides how much it gives back. macOS has no such switch.
use tauri::WebviewWindow;

/// Call right after hiding `win`.
#[cfg(windows)]
pub fn hidden(win: &WebviewWindow) {
    let win = win.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(30));
        if !win.is_visible().unwrap_or(true) {
            set_low(&win, true);
        }
    });
}

#[cfg(not(windows))]
pub fn hidden(_: &WebviewWindow) {}

/// Call right after showing `win`.
pub fn shown(win: &WebviewWindow) {
    set_low(win, false);
}

#[cfg(windows)]
fn set_low(win: &WebviewWindow, low: bool) {
    use webview2_com::Microsoft::Web::WebView2::Win32::{
        ICoreWebView2_19, COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW,
        COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL,
    };
    use windows::core::Interface;
    let _ = win.with_webview(move |view| unsafe {
        let Ok(core) = view.controller().CoreWebView2() else {
            return;
        };
        // Older WebView2 runtimes lack it: nothing happens then.
        if let Ok(core) = core.cast::<ICoreWebView2_19>() {
            let _ = core.SetMemoryUsageTargetLevel(if low {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_LOW
            } else {
                COREWEBVIEW2_MEMORY_USAGE_TARGET_LEVEL_NORMAL
            });
        }
    });
}

#[cfg(not(windows))]
fn set_low(_: &WebviewWindow, _: bool) {}
