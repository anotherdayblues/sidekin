use crate::chat;
use crate::locale::t;
use image::{imageops, RgbaImage};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::sync::Mutex;
use tauri::{
    AppHandle, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize, Position,
    Size, WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};
use xcap::Monitor;

#[derive(Default)]
pub struct Snips(Mutex<Session>);
#[derive(Default)]
struct Session {
    generation: u64,
    selecting: bool,
    windows: Vec<String>,
    displays: std::collections::HashMap<u32, Display>,
    /// Each display as it looked when selection began (freeze first, as
    /// TRex, PowerToys and Text-Grab do): the overlay can never end up in
    /// the picture, and the crop is exactly what the user framed.
    frozen: std::collections::HashMap<u32, RgbaImage>,
}
#[derive(Clone, Copy, PartialEq)]
struct Display {
    x: i32,
    y: i32,
    w: u32,
    h: u32,
    scale: f64,
}
impl Display {
    fn read(m: &Monitor) -> Result<Self, String> {
        let unavailable = |_| t("host.displayDown").to_owned();
        Ok(Self {
            x: m.x().map_err(unavailable)?,
            y: m.y().map_err(unavailable)?,
            w: m.width().map_err(unavailable)?,
            h: m.height().map_err(unavailable)?,
            scale: f64::from(m.scale_factor().map_err(unavailable)?),
        })
    }
    /// The overlay's frame. On a Mac the display reports points, which are
    /// passed as they are: converting to pixels first would be divided back
    /// by whatever scale the window happens to be on, wrong on mixed-DPI
    /// setups. Windows reports physical pixels.
    fn frame(self) -> (Position, Size) {
        if cfg!(target_os = "macos") {
            (
                Position::Logical(LogicalPosition::new(self.x.into(), self.y.into())),
                Size::Logical(LogicalSize::new(self.w.into(), self.h.into())),
            )
        } else {
            (
                Position::Physical(PhysicalPosition::new(self.x, self.y)),
                Size::Physical(PhysicalSize::new(self.w, self.h)),
            )
        }
    }
}
/// Puts a window exactly over a display. The size must come first: on a Mac
/// `setContentSize` keeps the bottom-left corner fixed and grows upward, so
/// resizing after placing the top-left corner pushed the overlay up off the
/// screen (only the upper part could be selected, and crops were offset).
fn cover(window: &WebviewWindow, (position, size): (Position, Size)) -> tauri::Result<()> {
    window.set_size(size)?;
    window.set_position(position)
}
#[derive(Clone, Copy, Deserialize, Serialize)]
pub struct Region {
    left: f64,
    top: f64,
    right: f64,
    bottom: f64,
}
impl Region {
    fn pixels(self, width: u32, height: u32) -> Result<(u32, u32, u32, u32), String> {
        if ![self.left, self.top, self.right, self.bottom]
            .iter()
            .all(|v| v.is_finite() && (0.0..=1.).contains(v))
            || self.left >= self.right
            || self.top >= self.bottom
        {
            return Err(t("host.areaBad").into());
        }
        // Round inward. Pixels outside the user's selection must never be sampled.
        let x = (self.left * f64::from(width)).ceil() as u32;
        let y = (self.top * f64::from(height)).ceil() as u32;
        let w = ((self.right * f64::from(width)).floor() as u32).saturating_sub(x);
        let h = ((self.bottom * f64::from(height)).floor() as u32).saturating_sub(y);
        if w == 0 || h == 0 {
            return Err(t("host.areaSmall").into());
        }
        Ok((x, y, w, h))
    }
}
fn close(app: &AppHandle, windows: Vec<String>) {
    for label in windows {
        if let Some(w) = app.get_webview_window(&label) {
            let _ = w.destroy();
        }
    }
}
pub fn clear(app: &AppHandle) {
    let state = app.state::<Snips>();
    let mut s = state.0.lock().unwrap();
    s.generation = s.generation.wrapping_add(1);
    s.selecting = false;
    s.displays.clear();
    s.frozen.clear();
    let windows = std::mem::take(&mut s.windows);
    drop(s);
    close(app, windows);
    crate::snip_card::glasses(app, false);
}
#[tauri::command]
pub fn screen_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn CGPreflightScreenCaptureAccess() -> bool;
        }
        unsafe { CGPreflightScreenCaptureAccess() }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
#[tauri::command]
pub fn screen_preferences() -> Result<(), String> {
    // Ask macOS first: this puts 随伴 in the Screen Recording list (and shows
    // the system prompt), so the user only has to switch it on.
    #[cfg(target_os = "macos")]
    {
        unsafe extern "C" {
            fn CGRequestScreenCaptureAccess() -> bool;
        }
        if unsafe { CGRequestScreenCaptureAccess() } {
            return Ok(());
        }
    }
    #[cfg(target_os = "macos")]
    std::process::Command::new("/usr/bin/open")
        .arg("x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture")
        .spawn()
        .map_err(|_| t("host.noSystemSettings"))?;
    Ok(())
}
pub fn start(app: AppHandle) {
    crate::tips::used(&app, "snip");
    std::thread::spawn(move || {
        clear(&app);
        // Ready the result card while the user selects; an old card is
        // hidden first so it is not frozen into the new picture.
        if crate::snip_card::prepare(&app) {
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
        let generation = {
            let state = app.state::<Snips>();
            let mut s = state.0.lock().unwrap();
            s.selecting = true;
            s.generation
        };
        if let Err(reason) = open(&app, generation) {
            if app.state::<Snips>().0.lock().unwrap().generation == generation {
                clear(&app);
                let _ = chat::show(
                    &app,
                    json!({"mode":"error","reason":reason,"at":chat::now()}),
                    false,
                );
            }
        }
    });
}
#[tauri::command]
pub fn start_snip(app: AppHandle) {
    start(app);
}
fn open(app: &AppHandle, g: u64) -> Result<(), String> {
    if !screen_access() {
        #[cfg(all(target_os = "macos", not(feature = "acceptance")))]
        {
            unsafe extern "C" {
                fn CGRequestScreenCaptureAccess() -> bool;
            }
            if !unsafe { CGRequestScreenCaptureAccess() } {
                return Err("screenPermission".into());
            }
        }
        #[cfg(not(all(target_os = "macos", not(feature = "acceptance"))))]
        return Err("screenPermission".into());
    }
    let monitors = Monitor::all().map_err(|_| t("host.noDisplays"))?;
    if monitors.is_empty() {
        return Err(t("host.noDisplay").into());
    }
    // Freeze every display BEFORE any of our windows appear.
    #[cfg(not(feature = "acceptance"))]
    {
        let mut frozen = std::collections::HashMap::new();
        for m in &monitors {
            let id = m.id().map_err(|_| t("host.displayDown"))?;
            if let Ok(image) = m.capture_image() {
                frozen.insert(id, image);
            }
        }
        if frozen.is_empty() {
            return Err("screenPermission".into());
        }
        let state = app.state::<Snips>();
        let mut s = state.0.lock().unwrap();
        if s.generation != g || !s.selecting {
            return Ok(());
        }
        s.frozen = frozen;
    }
    crate::snip_card::glasses(app, true);
    for m in monitors {
        let id = m.id().map_err(|_| t("host.displayDown"))?;
        let display = Display::read(&m)?;
        let label = format!("snip-{g}-{id}");
        let window = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App(format!("index.html?snip={g}").into()),
        )
        .incognito(cfg!(any(feature = "acceptance", feature = "trial")))
        .title(t("host.titleSnip"))
        .visible(false)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .build()
        .map_err(|_| t("host.snipWindow"))?;
        {
            let state = app.state::<Snips>();
            let mut s = state.0.lock().unwrap();
            if s.generation != g || !s.selecting {
                drop(s);
                let _ = window.destroy();
                return Ok(());
            }
            s.windows.push(label);
            s.displays.insert(id, display);
        }
        cover(&window, display.frame()).map_err(|_| t("host.snipShow"))?;
        raise(app, &window);
        window.show().map_err(|_| t("host.snipShow"))?;
        let _ = window.set_focus();
    }
    Ok(())
}
/// Lifts the overlay above the menu bar, Dock and full-screen apps.
fn raise(app: &AppHandle, window: &WebviewWindow) {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn companion_overlay_window(ns_window: *mut std::ffi::c_void);
        }
        let (tx, rx) = std::sync::mpsc::channel();
        let w = window.clone();
        if app
            .run_on_main_thread(move || {
                if let Ok(p) = w.ns_window() {
                    unsafe { companion_overlay_window(p) };
                }
                let _ = tx.send(());
            })
            .is_ok()
        {
            let _ = rx.recv_timeout(std::time::Duration::from_secs(1));
        }
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, window);
}
fn owner(window: &WebviewWindow, g: u64) -> Result<u32, String> {
    window
        .label()
        .strip_prefix(&format!("snip-{g}-"))
        .and_then(|id| id.parse().ok())
        .ok_or(t("host.snipClosed").into())
}
#[tauri::command]
pub fn cancel_snip(app: AppHandle, generation: u64) {
    if app.state::<Snips>().0.lock().unwrap().generation == generation {
        clear(&app);
    }
}
#[tauri::command]
pub async fn finish_snip(
    app: AppHandle,
    window: WebviewWindow,
    generation: u64,
    region: Region,
) -> Result<(), String> {
    let id = owner(&window, generation)?;
    let result = tauri::async_runtime::spawn_blocking({
        let app = app.clone();
        move || {
            let (windows, frozen) = {
                let state = app.state::<Snips>();
                let mut s = state.0.lock().unwrap();
                if s.generation != generation || s.windows.is_empty() {
                    return Ok(());
                }
                s.selecting = false;
                let frozen = s.frozen.remove(&id);
                s.frozen.clear();
                (std::mem::take(&mut s.windows), frozen)
            };
            close(&app, windows);
            let image = if let Some(full) = frozen {
                let (x, y, w, h) = region.pixels(full.width(), full.height())?;
                imageops::crop_imm(&full, x, y, w, h).to_image()
            } else {
                // Acceptance runs read a fixture window instead of a frozen screen.
                std::thread::sleep(std::time::Duration::from_millis(45));
                if !screen_access() {
                    return Err("screenPermission".into());
                }
                let m = Monitor::all()
                    .map_err(|_| t("host.displayDown"))?
                    .into_iter()
                    .find(|m| m.id().ok() == Some(id))
                    .ok_or(t("host.displayGone"))?;
                if app.state::<Snips>().0.lock().unwrap().displays.get(&id)
                    != Some(&Display::read(&m)?)
                {
                    return Err(t("host.layoutChanged").to_owned());
                }
                let bounds = region.pixels(
                    m.width().map_err(|_| t("host.displayDown"))?,
                    m.height().map_err(|_| t("host.displayDown"))?,
                )?;
                capture(&app, &m, bounds)?
            };
            // In the display's own units (points on a Mac), like the overlay.
            let (selection, screen, units_per_css) = {
                let state = app.state::<Snips>();
                let s = state.0.lock().unwrap();
                if s.generation != generation {
                    return Ok(());
                }
                let d = s.displays.get(&id).copied().ok_or(t("host.displayGone"))?;
                let (x, y, w, h) = (
                    f64::from(d.x),
                    f64::from(d.y),
                    f64::from(d.w),
                    f64::from(d.h),
                );
                (
                    (
                        x + region.left * w,
                        y + region.top * h,
                        (region.right - region.left) * w,
                        (region.bottom - region.top) * h,
                    ),
                    (x, y, w, h),
                    if cfg!(windows) { d.scale } else { 1. },
                )
            };
            crate::snip_card::present(
                &app,
                generation,
                image,
                crate::snip_card::Anchor {
                    selection,
                    screen,
                    units_per_css,
                },
            )?;
            Ok(())
        }
    })
    .await
    .map_err(|e| e.to_string())?;
    if let Err(ref reason) = result {
        if app.state::<Snips>().0.lock().unwrap().generation == generation {
            clear(&app);
            let _ = chat::show(
                &app,
                json!({"mode":"error","reason":reason,"at":chat::now()}),
                false,
            );
        }
    }
    result
}
fn capture(
    _app: &AppHandle,
    m: &Monitor,
    (x, y, w, h): (u32, u32, u32, u32),
) -> Result<RgbaImage, String> {
    #[cfg(feature = "acceptance")]
    return crate::acceptance::capture_fixture(_app, m, (x, y, w, h));
    #[cfg(not(feature = "acceptance"))]
    m.capture_region(x, y, w, h)
        .map_err(|_| t("host.areaRead").into())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn display_relative_selection_rounds_inward() {
        let r = Region {
            left: 0.1,
            top: 0.2,
            right: 0.5,
            bottom: 0.8,
        };
        assert_eq!(r.pixels(1920, 1080).unwrap(), (192, 216, 768, 648));
        assert_eq!(r.pixels(1000, 500).unwrap(), (100, 100, 400, 300));
        assert!(Region { left: -0.01, ..r }.pixels(900, 400).is_err());
    }
    #[test]
    fn overlay_frame_uses_display_points_whatever_the_scale() {
        // The user's built-in screen, left of the main one (negative x).
        let left = Display {
            x: -1280,
            y: 0,
            w: 1280,
            h: 832,
            scale: 2.,
        };
        let (pos, size) = left.frame();
        if cfg!(target_os = "macos") {
            // Points straight through; the window must not rescale them.
            assert_eq!(pos, Position::Logical(LogicalPosition::new(-1280., 0.)));
            assert_eq!(size, Size::Logical(LogicalSize::new(1280., 832.)));
            // A 1x screen gets the very same frame for the same points.
            assert_eq!(Display { scale: 1., ..left }.frame().1, size);
        } else {
            assert_eq!(pos, Position::Physical(PhysicalPosition::new(-1280, 0)));
            assert_eq!(size, Size::Physical(PhysicalSize::new(1280, 832)));
        }
    }
}
