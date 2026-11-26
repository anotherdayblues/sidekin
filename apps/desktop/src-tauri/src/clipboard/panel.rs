use super::{failed, payload, store::ClipPayload, touch_entry, Clipboard};
use crate::selection;
use serde::Serialize;
use std::{
    ffi::{c_char, CString},
    sync::atomic::{AtomicU64, Ordering},
};
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, Monitor, PhysicalPosition,
    PhysicalSize, Position, WebviewWindow,
};

const PANEL_WIDTH: f64 = 448.;
const PANEL_HEIGHT: f64 = 340.;

#[derive(Clone, Copy)]
pub(super) struct Session {
    id: u64,
    target: isize,
    other_seq: isize,
    visible: bool,
    focusable: bool,
    size: PhysicalSize<u32>,
    /// True only when the pet itself is hidden and the panel falls back to screen center.
    center: bool,
    local: Option<&'static str>,
}
#[derive(Clone, Copy, Serialize)]
pub struct View {
    id: u64,
}
static NEXT: AtomicU64 = AtomicU64::new(1);
extern "C" {
    fn companion_clip_target(allow_self: i32) -> isize;
    fn companion_other_sequence() -> isize;
    fn companion_history_copy(text: *const c_char) -> i32;
    fn companion_history_paste(target: isize, text: *const c_char) -> i32;
    #[cfg(target_os = "macos")]
    fn companion_history_copy_image(bytes: *const u8, len: usize) -> i32;
    #[cfg(target_os = "macos")]
    fn companion_history_paste_image(target: isize, bytes: *const u8, len: usize) -> i32;
    #[cfg(windows)]
    fn companion_history_copy_image(
        png: *const u8,
        png_len: usize,
        rgba: *const u8,
        width: u32,
        height: u32,
    ) -> i32;
    #[cfg(windows)]
    fn companion_history_paste_image(
        target: isize,
        png: *const u8,
        png_len: usize,
        rgba: *const u8,
        width: u32,
        height: u32,
    ) -> i32;
}

fn copy_image_native(png: &[u8]) -> i32 {
    #[cfg(target_os = "macos")]
    {
        unsafe { companion_history_copy_image(png.as_ptr(), png.len()) }
    }
    #[cfg(windows)]
    {
        let Some((rgba, w, h)) = super::media::decode_png_rgba(png) else {
            return 0;
        };
        unsafe { companion_history_copy_image(png.as_ptr(), png.len(), rgba.as_ptr(), w, h) }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = png;
        0
    }
}

fn paste_image_native(target: isize, png: &[u8]) -> i32 {
    #[cfg(target_os = "macos")]
    {
        unsafe { companion_history_paste_image(target, png.as_ptr(), png.len()) }
    }
    #[cfg(windows)]
    {
        let Some((rgba, w, h)) = super::media::decode_png_rgba(png) else {
            return 0;
        };
        unsafe {
            companion_history_paste_image(target, png.as_ptr(), png.len(), rgba.as_ptr(), w, h)
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = (target, png);
        0
    }
}
fn resolve_paste_target(
    saved_target: isize,
    saved_local: Option<&'static str>,
    saved_other_seq: isize,
    current_other_seq: isize,
    latest_other: isize,
) -> (Option<&'static str>, isize) {
    if (current_other_seq != saved_other_seq || (saved_local.is_none() && saved_target <= 0))
        && latest_other > 0
    {
        return (None, latest_other);
    }
    (saved_local, saved_target)
}
pub fn active(app: &AppHandle) -> bool {
    app.try_state::<Clipboard>()
        .is_some_and(|s| s.panel.lock().unwrap().is_some())
}
pub fn panel_size(app: &AppHandle) -> Option<(f64, f64)> {
    active(app).then_some((PANEL_WIDTH, PANEL_HEIGHT))
}
#[tauri::command]
pub fn clip_session(app: AppHandle) -> Option<View> {
    app.state::<Clipboard>()
        .panel
        .lock()
        .unwrap()
        .map(|s| View { id: s.id })
}
fn monitor_divisor(scale: f64, mac: bool) -> f64 {
    if mac {
        scale
    } else {
        1.
    }
}
fn cursor_in_space(pos: (f64, f64), primary_scale: f64, mac: bool) -> (f64, f64) {
    let d = monitor_divisor(primary_scale, mac);
    (pos.0 / d, pos.1 / d)
}
fn monitor_bounds(mon: &Monitor, mac: bool) -> [f64; 4] {
    let d = monitor_divisor(mon.scale_factor(), mac);
    let p = mon.position();
    let s = mon.size();
    [
        p.x as f64 / d,
        p.y as f64 / d,
        s.width as f64 / d,
        s.height as f64 / d,
    ]
}
fn monitor_work(mon: &Monitor, mac: bool) -> [f64; 4] {
    let d = monitor_divisor(mon.scale_factor(), mac);
    let a = mon.work_area();
    [
        a.position.x as f64 / d,
        a.position.y as f64 / d,
        a.size.width as f64 / d,
        a.size.height as f64 / d,
    ]
}
fn pick_monitor_index(bounds: &[[f64; 4]], cursor: (f64, f64)) -> Option<usize> {
    bounds
        .iter()
        .position(|&[x, y, w, h]| {
            cursor.0 >= x && cursor.0 < x + w && cursor.1 >= y && cursor.1 < y + h
        })
        .or_else(|| (!bounds.is_empty()).then_some(0))
}
fn centered_origin(work: [f64; 4], size: (f64, f64)) -> (f64, f64) {
    let [x, y, w, h] = work;
    (x + (w - size.0).max(0.) / 2., y + (h - size.1).max(0.) / 3.)
}
fn place_centered(app: &AppHandle, w: &WebviewWindow) -> Result<(), String> {
    let mac = cfg!(target_os = "macos");
    let monitors = app.available_monitors().unwrap_or_default();
    let mon = if let Some(primary) = app
        .primary_monitor()
        .ok()
        .flatten()
        .or_else(|| monitors.first().cloned())
    {
        if let Ok(pos) = app.cursor_position() {
            let cursor = cursor_in_space((pos.x, pos.y), primary.scale_factor(), mac);
            let bounds: Vec<_> = monitors.iter().map(|m| monitor_bounds(m, mac)).collect();
            pick_monitor_index(&bounds, cursor)
                .and_then(|i| monitors.get(i).cloned())
                .unwrap_or(primary)
        } else {
            primary
        }
    } else {
        return Ok(());
    };
    let work = monitor_work(&mon, mac);
    let units = if mac { 1. } else { mon.scale_factor() };
    let (x, y) = centered_origin(work, (PANEL_WIDTH * units, PANEL_HEIGHT * units));
    let pos = if mac {
        Position::Logical(LogicalPosition::new(x, y))
    } else {
        Position::Physical(PhysicalPosition::new(x.round() as i32, y.round() as i32))
    };
    w.set_position(pos).map_err(|_| failed())
}
pub fn open(app: &AppHandle, from_shortcut: bool) -> Result<(), String> {
    let w = app.get_webview_window("bubble").ok_or_else(failed)?;
    let state = app.state::<Clipboard>();
    let bubble_editor = app
        .state::<crate::chat::Chat>()
        .intent
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|i| {
            matches!(
                i["mode"].as_str(),
                Some("input" | "translate-input" | "chat" | "translate" | "return-input")
            )
        });
    // Read window properties before locking: host calls can deliver resize events.
    let local = if from_shortcut {
        ["bubble", "chat", "studio"].into_iter().find(|&label| {
            (label != "bubble" || bubble_editor)
                && app
                    .get_webview_window(label)
                    .is_some_and(|win| win.is_focused().unwrap_or(false))
        })
    } else {
        None
    };
    let pet_visible = app
        .get_webview_window("pet")
        .is_some_and(|p| p.is_visible().unwrap_or(false));
    let candidate = Session {
        id: NEXT.fetch_add(1, Ordering::Relaxed),
        target: unsafe { companion_clip_target(local.is_some().into()) },
        other_seq: unsafe { companion_other_sequence() },
        visible: w.is_visible().map_err(|_| failed())?,
        focusable: w.is_focused().unwrap_or(false)
            || app
                .state::<crate::chat::Chat>()
                .intent
                .lock()
                .unwrap()
                .as_ref()
                .is_some_and(|i| matches!(i["mode"].as_str(), Some("input" | "translate-input"))),
        size: w.outer_size().map_err(|_| failed())?,
        local,
        center: !pet_visible,
    };
    let current = *state.panel.lock().unwrap().get_or_insert(candidate);
    let show = || -> Result<(), String> {
        w.set_size(LogicalSize::new(PANEL_WIDTH, PANEL_HEIGHT))
            .map_err(|_| failed())?;
        if current.center {
            place_centered(app, &w)?;
        } else {
            crate::chat::place(app)?;
        }
        w.set_focusable(true).map_err(|_| failed())?;
        w.show().map_err(|_| failed())?;
        crate::window_memory::shown(&w);
        w.set_focus().map_err(|_| failed())?;
        app.emit_to("bubble", "clip-open", View { id: current.id })
            .map_err(|_| failed())
    };
    if let Err(e) = show() {
        let _ = finish(app, current.id);
        return Err(e);
    }
    Ok(())
}
pub fn toggle(app: &AppHandle) -> Result<(), String> {
    let active_id = app
        .state::<Clipboard>()
        .panel
        .lock()
        .unwrap()
        .map(|s| s.id);
    if let Some(id) = active_id {
        finish(app, id)
    } else {
        open(app, true)
    }
}
pub fn keep_underlay(app: &AppHandle, focus: bool) {
    if let Some(v) = app.state::<Clipboard>().panel.lock().unwrap().as_mut() {
        v.visible = true;
        v.focusable = focus;
    }
}
pub fn centered(app: &AppHandle) -> bool {
    app.try_state::<Clipboard>()
        .is_some_and(|s| s.panel.lock().unwrap().is_some_and(|v| v.center))
}
#[tauri::command]
pub fn clip_open(app: AppHandle) -> Result<(), String> {
    open(&app, false)
}
fn finish(app: &AppHandle, id: u64) -> Result<(), String> {
    let state = app.state::<Clipboard>();
    let session = {
        let mut slot = state.panel.lock().unwrap();
        if !slot.is_some_and(|s| s.id == id) {
            return Ok(());
        }
        slot.take().unwrap()
    };
    let w = app.get_webview_window("bubble").ok_or_else(failed)?;
    if !session.visible {
        w.hide().map_err(|_| failed())?;
        crate::window_memory::hidden(&w);
    }
    w.set_size(session.size).map_err(|_| failed())?;
    w.set_focusable(session.focusable).map_err(|_| failed())?;
    crate::chat::place(app)?;
    app.emit_to("bubble", "clip-closed", View { id })
        .map_err(|_| failed())
}
#[tauri::command]
pub fn clip_close(app: AppHandle, session: u64) -> Result<(), String> {
    finish(&app, session)
}
#[tauri::command]
pub async fn clip_copy_text(app: AppHandle, text: String) -> Result<(), String> {
    let c = CString::new(text).map_err(|_| failed())?;
    let _ = app;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = selection::CLIPBOARD.lock().unwrap();
        if unsafe { companion_history_copy(c.as_ptr()) } != 1 {
            return Err(crate::locale::t("host.clipboardBusy").into());
        }
        Ok(())
    })
    .await
    .map_err(|_| failed())?
}

fn write_payload_to_clipboard(item: &ClipPayload) -> Result<(), String> {
    let ok = match item {
        ClipPayload::Text(text) => {
            let c = CString::new(text.as_str()).map_err(|_| failed())?;
            unsafe { companion_history_copy(c.as_ptr()) == 1 }
        }
        ClipPayload::Image { png } => copy_image_native(png) == 1,
    };
    if !ok {
        return Err(crate::locale::t("host.clipboardBusy").into());
    }
    Ok(())
}

#[derive(Debug, PartialEq, Eq)]
enum PasteOutcome {
    Done,
    CopiedNeedsPermission,
    Failed(&'static str),
}

fn paste_outcome(paste_rc: i32, fallback_copied: bool) -> PasteOutcome {
    match paste_rc {
        1 => PasteOutcome::Done,
        -1 if fallback_copied => PasteOutcome::CopiedNeedsPermission,
        -1 => PasteOutcome::Failed("clip.permission"),
        _ if fallback_copied => PasteOutcome::Done,
        _ => PasteOutcome::Failed("clip.pasteFailed"),
    }
}

#[tauri::command]
pub async fn clip_copy(
    app: AppHandle,
    window: tauri::WebviewWindow,
    session: Option<u64>,
    id: i64,
) -> Result<(), String> {
    if !matches!(
        (window.label(), session),
        ("studio", None) | ("bubble", Some(_))
    ) {
        return Err(failed());
    }
    let host = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let item = payload(&host, id)?;
        let state = host.state::<Clipboard>();
        let active = state.panel.lock().unwrap();
        if session.is_some_and(|id| !active.is_some_and(|view| view.id == id)) {
            return Err(failed());
        }
        let _guard = selection::CLIPBOARD.lock().unwrap();
        write_payload_to_clipboard(&item)
    })
    .await
    .map_err(|_| failed())??;
    touch_entry(&app, id);
    if let Some(id) = session {
        finish(&app, id)?;
    }
    Ok(())
}
#[tauri::command]
pub async fn clip_paste(app: AppHandle, session: u64, id: i64) -> Result<(), String> {
    let s = app.state::<Clipboard>();
    let destination = s
        .panel
        .lock()
        .unwrap()
        .filter(|s| s.id == session)
        .ok_or_else(failed)?;
    let (local, target) = resolve_paste_target(
        destination.target,
        destination.local,
        destination.other_seq,
        unsafe { companion_other_sequence() },
        unsafe { companion_clip_target(0) },
    );
    let item = payload(&app, id)?;
    if let Some(label) = local {
        if label == "bubble" {
            return match item {
                ClipPayload::Text(text) => {
                    touch_entry(&app, id);
                    // The search field and the original editor live in this same window.
                    app.emit_to(
                        "bubble",
                        "clip-insert",
                        serde_json::json!({"session":session,"id":id,"text":text}),
                    )
                    .map_err(|_| failed())
                }
                ClipPayload::Image { .. } => {
                    // Bubble text inputs cannot receive an image directly: copy it instead.
                    tauri::async_runtime::spawn_blocking(move || {
                        let _guard = selection::CLIPBOARD.lock().unwrap();
                        write_payload_to_clipboard(&item)
                    })
                    .await
                    .map_err(|_| failed())??;
                    touch_entry(&app, id);
                    finish(&app, session)
                }
            };
        }
        app.get_webview_window(label)
            .ok_or_else(failed)?
            .set_focus()
            .map_err(|_| failed())?;
    }
    #[cfg(target_os = "macos")]
    if local.is_none() && !crate::permissions::is_enabled(&app, "accessibility") {
        let copied = tauri::async_runtime::spawn_blocking(move || {
            let _guard = selection::CLIPBOARD.lock().unwrap();
            write_payload_to_clipboard(&item).is_ok()
        })
        .await
        .unwrap_or(false);
        if copied {
            touch_entry(&app, id);
        }
        return Err(crate::locale::t("clip.permissionOff").into());
    }
    #[cfg(feature = "acceptance")]
    {
        return Err(crate::locale::t("clip.pasteFailed").into());
    } // Never send synthetic input to another app during QA.
    if local.is_none() && target <= 0 {
        tauri::async_runtime::spawn_blocking(move || {
            let _guard = selection::CLIPBOARD.lock().unwrap();
            write_payload_to_clipboard(&item)
        })
        .await
        .map_err(|_| failed())??;
        touch_entry(&app, id);
        return finish(&app, session);
    }
    let outcome = tauri::async_runtime::spawn_blocking(move || {
        let _guard = selection::CLIPBOARD.lock().unwrap();
        let rc = match &item {
            ClipPayload::Text(text) => {
                let Ok(c) = CString::new(text.as_str()) else {
                    return PasteOutcome::Failed("clip.pasteFailed");
                };
                unsafe { companion_history_paste(target, c.as_ptr()) }
            }
            ClipPayload::Image { png } => paste_image_native(target, png),
        };
        if rc == 1 {
            return PasteOutcome::Done;
        }
        let copied = write_payload_to_clipboard(&item).is_ok();
        paste_outcome(rc, copied)
    })
    .await
    .map_err(|_| failed())?;
    match outcome {
        PasteOutcome::Done => {
            touch_entry(&app, id);
            finish(&app, session)
        }
        PasteOutcome::CopiedNeedsPermission => {
            touch_entry(&app, id);
            Err(crate::locale::t("clip.permission").into())
        }
        PasteOutcome::Failed(key) => Err(crate::locale::t(key).into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn retina_mac_cursor_matches_primary_monitor_in_every_quadrant() {
        // Primary 1440x900 @2x plus a secondary display on the right.
        let screens = [[0., 0., 1440., 900.], [1440., 0., 1920., 1080.]];
        // Bottom-right of the Retina primary returns (2400, 1500) physical from tao.
        let cursor = cursor_in_space((2400., 1500.), 2., true);
        assert_eq!(cursor, (1200., 750.));
        assert_eq!(pick_monitor_index(&screens, cursor), Some(0));
        // Secondary display at x=1600 logical returns x=3200 physical from tao.
        let second = cursor_in_space((3200., 400.), 2., true);
        assert_eq!(pick_monitor_index(&screens, second), Some(1));
    }

    #[test]
    fn fallback_center_places_panel_in_upper_middle_and_clamps_small_screens() {
        assert_eq!(
            centered_origin([0., 25., 1440., 875.], (448., 340.)),
            (496., 25. + 535. / 3.)
        );
        assert_eq!(centered_origin([-1280., 0., 400., 300.], (448., 340.)), (-1280., 0.));
    }

    #[test]
    fn paste_target_refreshes_when_user_clicks_another_app_while_panel_is_open() {
        // Opened with no prior target (0); user then clicked an external input (seq 0 -> 1, pid 42).
        assert_eq!(resolve_paste_target(0, None, 0, 1, 42), (None, 42));
        // Opened while in local bubble, then user clicked an external app (seq 3 -> 4, pid 88).
        assert_eq!(
            resolve_paste_target(10, Some("bubble"), 3, 4, 88),
            (None, 88)
        );
        // Opened in local bubble and never left: keep local bubble target.
        assert_eq!(
            resolve_paste_target(10, Some("bubble"), 3, 3, 88),
            (Some("bubble"), 10)
        );
        // Opened from Chrome (pid 55), stayed on Chrome: keep Chrome.
        assert_eq!(resolve_paste_target(55, None, 5, 5, 55), (None, 55));
        // Opened from Chrome (pid 55), then clicked Notes (seq 5 -> 6, pid 77): switch to Notes.
        assert_eq!(resolve_paste_target(55, None, 5, 6, 77), (None, 77));
    }

    #[test]
    fn paste_falls_back_to_copy_when_target_unavailable_or_permission_missing() {
        assert_eq!(paste_outcome(1, false), PasteOutcome::Done);
        // No valid target / target app gone: fallback copy succeeds -> finish cleanly.
        assert_eq!(paste_outcome(0, true), PasteOutcome::Done);
        assert_eq!(paste_outcome(0, false), PasteOutcome::Failed("clip.pasteFailed"));
        // Missing OS Accessibility: still copied to clipboard, keep permission prompt visible.
        assert_eq!(paste_outcome(-1, true), PasteOutcome::CopiedNeedsPermission);
        assert_eq!(paste_outcome(-1, false), PasteOutcome::Failed("clip.permission"));
    }
}
