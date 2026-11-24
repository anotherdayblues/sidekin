// The 番茄钟 clock's own small window (plan/19 §9.3): above the pet's head
// when there is room, below its feet when the pet sits at the top of the
// screen, beside it when neither fits. Never over the pet. A window of its
// own can wear the system's material (Liquid Glass, Acrylic) and be clicked
// without touching the pet's click-through. The page is `index.html?clock`.
// It rests as a thin bar and opens into the clock while the pointer is on
// the pet or on it (clockWindow.ts asks, `focus_clock_peek`): the window
// itself changes size about the clock's centre, so the glass changes with it.
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Mutex,
};
use tauri::{
    AppHandle, Emitter, LogicalSize, Manager, PhysicalPosition, PhysicalSize, WebviewUrl,
    WebviewWindow, WebviewWindowBuilder,
};

const LABEL: &str = "clock";

/// Where the pet's head is in its cell, as shares: its visible top and the
/// middle of the head. The pet window measures it (focusClock.ts `headOf`).
#[derive(Default)]
pub struct Head(Mutex<Option<(f64, f64)>>);

/// Whether the clock is open; resting it is the bar.
#[derive(Default)]
pub struct Peek(AtomicBool);

/// How long opening and closing take: the Mac's springy glass, Windows'
/// quicker Fluent motion (focus-clock.css times the page's part the same).
const OPEN_SECS: f64 = if cfg!(windows) { 0.26 } else { 0.52 };
const CLOSE_SECS: f64 = if cfg!(windows) { 0.2 } else { 0.32 };

/// The resting bar for a clock of this size, in logical pixels.
pub fn bar(clock: (f64, f64)) -> (f64, f64) {
    let h = clock.1;
    ((h * 1.7).round(), (h * 0.29).round().max(8.))
}

/// Where a rect of `inner` size sits centred on `outer` (x, y, w, h).
pub fn centred(outer: (i32, i32, u32, u32), inner: (u32, u32)) -> (i32, i32) {
    (
        outer.0 + (outer.2 as i32 - inner.0 as i32) / 2,
        outer.1 + (outer.3 as i32 - inner.1 as i32) / 2,
    )
}

/// The clock's size in logical pixels for a pet this wide: a little under
/// a fifth of the pet's width tall, readable at the smallest pet and no
/// bigger than this at the largest.
pub fn size(pet_width: f64) -> (f64, f64) {
    let h = (pet_width * 0.2).clamp(30., 46.).round();
    ((h * 3.4).round(), h)
}

/// Lays out in one monitor's physical pixels. `head` is (top, middle) as
/// shares of the pet's cell; `area` the monitor's work area (x, y, w, h).
pub fn anchor(
    pet: (i32, i32),
    pet_size: (u32, u32),
    head: (f64, f64),
    clock: (u32, u32),
    gap: i32,
    area: (i32, i32, u32, u32),
) -> (i32, i32) {
    let (left, top, width, height) = area;
    let (right, bottom) = (left + width as i32, top + height as i32);
    let (cw, ch) = (clock.0 as i32, clock.1 as i32);
    let (pw, ph) = (pet_size.0 as i32, pet_size.1 as i32);
    let head_y = pet.1 + (head.0 * ph as f64).round() as i32;
    let middle = pet.0 + (head.1 * pw as f64).round() as i32;
    let fit_x = |x: i32| x.clamp(left, (right - cw).max(left));
    let above = head_y - gap - ch;
    if above >= top {
        return (fit_x(middle - cw / 2), above);
    }
    let below = pet.1 + ph + gap;
    if below + ch <= bottom {
        return (fit_x(middle - cw / 2), below);
    }
    // Beside the head: the right if it fits, else the left.
    let y = head_y.clamp(top, (bottom - ch).max(top));
    let x = if pet.0 + pw + gap + cw <= right {
        pet.0 + pw + gap
    } else {
        pet.0 - gap - cw
    };
    (fit_x(x), y)
}

/// The pet's own cell on screen, without the file pile beside it.
pub fn pet_rect(app: &AppHandle) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    if let Some(bounds) = crate::file_transfer::physical_pet(app) {
        return Some(bounds);
    }
    let pet = app.get_webview_window("pet")?;
    Some((pet.outer_position().ok()?, pet.outer_size().ok()?))
}

/// The clock on screen while it shows, for the bubble to keep clear of: the
/// open clock's place, so opening it never runs into the bubble.
pub fn shown_rect(app: &AppHandle) -> Option<(PhysicalPosition<i32>, PhysicalSize<u32>)> {
    let w = app.get_webview_window(LABEL)?;
    if !w.is_visible().unwrap_or(false) {
        return None;
    }
    let (pos, size) = (w.outer_position().ok()?, w.outer_size().ok()?);
    let full = *app.state::<Full>().0.lock().unwrap();
    let Some(full) = full else {
        return Some((pos, size));
    };
    let (x, y) = centred((pos.x, pos.y, size.width, size.height), full);
    Some((
        PhysicalPosition::new(x, y),
        PhysicalSize::new(full.0, full.1),
    ))
}

/// The open clock's size in physical pixels, as last placed.
#[derive(Default)]
pub struct Full(Mutex<Option<(u32, u32)>>);

/// Bumped by each change of size, so an older one still stepping stops.
static MOTION: AtomicU64 = AtomicU64::new(0);

/// Changes the window to `size` (logical) about its centre, over `secs`.
/// On a Mac the window's frame steps each frame on the main thread, the
/// glass kept a capsule (native/clock-window.m); on Windows the host steps
/// it; elsewhere it changes at once.
fn resize(app: &AppHandle, clock: &WebviewWindow, size: (f64, f64), secs: f64, opening: bool) {
    let motion = MOTION.fetch_add(1, Ordering::SeqCst) + 1;
    #[cfg(target_os = "macos")]
    {
        let _ = motion;
        extern "C" {
            fn companion_clock_resize(
                ns_window: *mut std::ffi::c_void,
                width: f64,
                height: f64,
                seconds: f64,
                spring: i32,
            );
        }
        let w = clock.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(p) = w.ns_window() {
                unsafe { companion_clock_resize(p, size.0, size.1, secs, opening as i32) };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = app;
        let (Ok(pos), Ok(from), Ok(scale)) = (
            clock.outer_position(),
            clock.outer_size(),
            clock.scale_factor(),
        ) else {
            return;
        };
        let to = LogicalSize::new(size.0, size.1).to_physical::<u32>(scale);
        let mid = (
            pos.x as f64 + from.width as f64 / 2.,
            pos.y as f64 + from.height as f64 / 2.,
        );
        let clock = clock.clone();
        let steps = if cfg!(windows) {
            (secs * 60.).round().max(1.) as u32
        } else {
            1
        };
        std::thread::spawn(move || {
            for i in 1..=steps {
                if MOTION.load(Ordering::SeqCst) != motion {
                    return;
                }
                let t = i as f64 / steps as f64;
                // Fluent's decelerate: quick out, soft landing.
                let e = 1. - (1. - t).powi(3);
                let w = from.width as f64 + (to.width as f64 - from.width as f64) * e;
                let h = from.height as f64 + (to.height as f64 - from.height as f64) * e;
                let _ = clock.set_position(PhysicalPosition::new(
                    (mid.0 - w / 2.).round() as i32,
                    (mid.1 - h / 2.).round() as i32,
                ));
                let _ = clock.set_size(PhysicalSize::new(w.round() as u32, h.round() as u32));
                if i < steps {
                    std::thread::sleep(std::time::Duration::from_secs_f64(secs / steps as f64));
                }
            }
        });
        let _ = opening;
    }
}

/// After the host itself moved or resized the window: stops a change under
/// way and keeps the glass a capsule.
fn settle(app: &AppHandle, clock: &WebviewWindow) {
    MOTION.fetch_add(1, Ordering::SeqCst);
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn companion_clock_settle(ns_window: *mut std::ffi::c_void);
        }
        let w = clock.clone();
        let _ = app.run_on_main_thread(move || {
            if let Ok(p) = w.ns_window() {
                unsafe { companion_clock_settle(p) };
            }
        });
    }
    #[cfg(not(target_os = "macos"))]
    let _ = (app, clock);
}

/// Being built on its own thread (see `sync`).
static BUILDING: AtomicBool = AtomicBool::new(false);

/// Made the first time a timer runs, not at start: until then it would only
/// hold memory. Built off the caller's thread, since building a window
/// inside a command can hang on Windows; once built it stays, hidden, so
/// later timers show it at once.
fn ensure(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window(LABEL).is_some() {
        return Ok(());
    }
    let (w, h) = bar(size(192.));
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?clock".into()))
        .incognito(cfg!(any(feature = "acceptance", feature = "trial")))
        .title("")
        .accept_first_mouse(true)
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .visible(false)
        .focused(false)
        .focusable(false)
        .inner_size(w, h)
        .build()
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Moves the clock next to the pet, at the size for the pet's size: open or
/// as the bar, centred where the open clock goes.
pub fn place(app: &AppHandle) -> Result<(), String> {
    let (Some(clock), Some(pet)) = (app.get_webview_window(LABEL), app.get_webview_window("pet"))
    else {
        return Ok(());
    };
    let Some((pos, pet_size)) = pet_rect(app) else {
        return Ok(());
    };
    let Some(mon) = pet.current_monitor().map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let scale = mon.scale_factor();
    let (w, h) = size(f64::from(pet_size.width) / scale);
    let full = LogicalSize::new(w, h).to_physical::<u32>(scale);
    *app.state::<Full>().0.lock().unwrap() = Some((full.width, full.height));
    // The page sizes everything from the open clock's height.
    let _ = clock.emit("focus-clock-size", h);
    let open = app.state::<Peek>().0.load(Ordering::SeqCst);
    let (lw, lh) = if open { (w, h) } else { bar((w, h)) };
    let want = LogicalSize::new(lw, lh).to_physical::<u32>(scale);
    let resized = clock.inner_size().map_err(|e| e.to_string())? != want;
    if resized {
        clock
            .set_size(LogicalSize::new(lw, lh))
            .map_err(|e| e.to_string())?;
    }
    let head = app.state::<Head>().0.lock().unwrap().unwrap_or((0.3, 0.5));
    let area = mon.work_area();
    let (x, y) = anchor(
        (pos.x, pos.y),
        (pet_size.width, pet_size.height),
        head,
        (full.width, full.height),
        (4. * scale).round() as i32,
        (
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
        ),
    );
    let (x, y) = centred((x, y, full.width, full.height), (want.width, want.height));
    clock
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    if resized {
        settle(app, &clock);
    }
    Ok(())
}

/// Shows the clock while a timer is `on` and the pet is out; hides it
/// otherwise. The caller re-places the bubble, which keeps clear of it.
pub fn sync(app: &AppHandle, on: bool) {
    let pet_out = app
        .get_webview_window("pet")
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    let show = pet_out && on;
    let clock = app.get_webview_window(LABEL);
    if build_first(clock.is_some(), show) {
        if !BUILDING.swap(true, Ordering::SeqCst) {
            let app = app.clone();
            std::thread::spawn(move || {
                let built = ensure(&app);
                BUILDING.store(false, Ordering::SeqCst);
                match built {
                    // The timer may have stopped meanwhile: ask again.
                    Ok(()) => sync(&app, crate::focus::on(&app)),
                    Err(e) => eprintln!("focus clock: {e}"),
                }
            });
        }
        return;
    }
    let Some(clock) = clock else {
        return;
    };
    if show == clock.is_visible().unwrap_or(false) {
        return;
    }
    if show {
        // A clock that shows again starts as the bar.
        app.state::<Peek>().0.store(false, Ordering::SeqCst);
        let _ = place(app);
        let _ = clock.show();
        crate::window_memory::shown(&clock);
    } else {
        let _ = clock.hide();
        crate::window_memory::hidden(&clock);
    }
}

/// Whether the window has to be built before it can show.
fn build_first(exists: bool, show: bool) -> bool {
    show && !exists
}

/// The clock window opens into the clock or rests as the bar.
#[tauri::command]
pub fn focus_clock_peek(app: AppHandle, open: bool) {
    if app.state::<Peek>().0.swap(open, Ordering::SeqCst) == open {
        return;
    }
    let (Some(clock), Some((_, pet_size)), Some(pet)) = (
        app.get_webview_window(LABEL),
        pet_rect(&app),
        app.get_webview_window("pet"),
    ) else {
        return;
    };
    let scale = pet.scale_factor().unwrap_or(1.);
    let full = size(f64::from(pet_size.width) / scale);
    let target = if open { full } else { bar(full) };
    resize(
        &app,
        &clock,
        target,
        if open { OPEN_SECS } else { CLOSE_SECS },
        open,
    );
}

/// The open clock's height in logical pixels, for the page to size from.
#[tauri::command]
pub fn focus_clock_full(app: AppHandle) -> f64 {
    let scale = app
        .get_webview_window("pet")
        .and_then(|w| w.scale_factor().ok())
        .unwrap_or(1.);
    pet_rect(&app)
        .map(|(_, s)| size(f64::from(s.width) / scale).1)
        .unwrap_or(size(192.).1)
}

/// The pet window tells where this pet's head is.
#[tauri::command]
pub fn focus_clock_head(app: AppHandle, top: f64, middle: f64) {
    *app.state::<Head>().0.lock().unwrap() = Some((top.clamp(0., 1.), middle.clamp(0., 1.)));
    let _ = place(&app);
}

#[cfg(test)]
mod tests {
    use super::*;
    const AREA: (i32, i32, u32, u32) = (0, 25, 1440, 875);

    #[test]
    fn the_window_is_built_only_when_a_timer_first_shows_it() {
        // At start with no timer: nothing is built.
        assert!(!build_first(false, false));
        // The first timer: built, then shown.
        assert!(build_first(false, true));
        // Afterwards the hidden window is reused.
        assert!(!build_first(true, true));
        assert!(!build_first(true, false));
    }
    #[test]
    fn the_bar_is_a_thin_capsule_of_the_clock() {
        assert_eq!(bar((129., 38.)), (65., 11.));
        assert_eq!(bar((102., 30.)), (51., 9.));
        assert_eq!(bar((156., 46.)), (78., 13.));
        // The bar sits on the open clock's centre.
        assert_eq!(centred((100, 200, 130, 38), (66, 12)), (132, 213));
    }
    #[test]
    fn the_clock_grows_with_the_pet_within_limits() {
        assert_eq!(size(80.), (102., 30.));
        assert_eq!(size(192.), (129., 38.));
        assert_eq!(size(600.), (156., 46.));
    }
    #[test]
    fn above_the_head_when_there_is_room() {
        // Head top at 30% of a 208-tall cell: 62 px down.
        let (x, y) = anchor((600, 400), (192, 208), (0.3, 0.5), (130, 38), 4, AREA);
        assert_eq!((x, y), (600 + 96 - 65, 400 + 62 - 4 - 38));
    }
    #[test]
    fn below_the_feet_when_the_pet_sits_at_the_top() {
        let (_, y) = anchor((600, 25), (192, 208), (0.1, 0.5), (130, 38), 4, AREA);
        assert_eq!(y, 25 + 208 + 4);
    }
    #[test]
    fn beside_when_neither_fits_and_never_off_screen() {
        // A screen just taller than the pet.
        let area = (0, 0, 1000, 220);
        let (x, y) = anchor((100, 0), (192, 208), (0.1, 0.5), (130, 38), 4, area);
        assert_eq!((x, y), (100 + 192 + 4, 21));
        // At the right edge it goes to the left.
        let (x, _) = anchor((1000 - 192, 0), (192, 208), (0.1, 0.5), (130, 38), 4, area);
        assert_eq!(x, 1000 - 192 - 4 - 130);
        // Near the left edge, centred over the head but kept on screen.
        let (x, _) = anchor((-50, 400), (192, 208), (0.3, 0.5), (130, 38), 4, AREA);
        assert_eq!(x, 0);
    }
    #[test]
    fn a_negative_origin_monitor_works_the_same() {
        let area = (-1920, -200, 1920, 1080);
        let (x, y) = anchor((-1000, -100), (192, 208), (0.3, 0.5), (130, 38), 4, area);
        assert_eq!((x, y), (-969, -80));
    }
}
