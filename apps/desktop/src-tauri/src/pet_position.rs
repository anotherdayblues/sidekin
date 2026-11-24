// macOS places windows in global points; Windows uses physical desktop pixels.
// Each monitor's work area may have a negative origin and a different scale.
use crate::locale::t;
use crate::{Settings, State};
use tauri::{AppHandle, Manager, Monitor, WebviewWindow};

type Point = (i32, i32);
type R<T> = Result<T, String>;
#[derive(Clone, Debug, PartialEq)]
struct Screen {
    bounds: [f64; 4],
    work: [f64; 4],
    scale: f64,
    units: f64,
}

fn divisor(scale: f64) -> f64 {
    if cfg!(target_os = "macos") {
        scale
    } else {
        1.0
    }
}

impl Screen {
    fn from(m: &Monitor) -> Self {
        let a = m.work_area();
        let scale = m.scale_factor();
        let d = divisor(scale);
        let rect = |x: i32, y: i32, w: u32, h: u32| {
            [x as f64 / d, y as f64 / d, w as f64 / d, h as f64 / d]
        };
        Self {
            bounds: rect(
                m.position().x,
                m.position().y,
                m.size().width,
                m.size().height,
            ),
            work: rect(a.position.x, a.position.y, a.size.width, a.size.height),
            scale,
            units: scale / d,
        }
    }
    fn fit(&self, p: Point, size: u32) -> Point {
        let [x, y, w, h] = self.work;
        let width = (size as f64 * self.units).ceil();
        let height = (size as f64 * 208. / 192. * self.units).ceil();
        (
            (p.0 as f64).clamp(x, (x + w - width).max(x)).round() as i32,
            (p.1 as f64).clamp(y, (y + h - height).max(y)).round() as i32,
        )
    }
    fn corner(&self, size: u32) -> Point {
        let edge = self.fit((i32::MAX, i32::MAX), size);
        let gap = (32. * self.units).round() as i32;
        self.fit(
            (edge.0.saturating_sub(gap), edge.1.saturating_sub(gap)),
            size,
        )
    }
    fn overlap(&self, p: Point, size: u32) -> f64 {
        let [x, y, w, h] = self.work;
        let width = size as f64 * self.units;
        let (px, py) = (p.0 as f64, p.1 as f64);
        ((px + width).min(x + w) - px.max(x)).max(0.)
            * ((py + width * 208. / 192.).min(y + h) - py.max(y)).max(0.)
    }
    fn cursor_distance(&self, p: (f64, f64)) -> f64 {
        let [x, y, w, h] = self.bounds;
        (p.0 - p.0.clamp(x, x + w)).powi(2) + (p.1 - p.1.clamp(y, y + h)).powi(2)
    }
}

// Put the primary first, including when the operating system lists it elsewhere.
fn layout(win: &WebviewWindow) -> R<Vec<Screen>> {
    let mut monitors = win.available_monitors().map_err(|e| e.to_string())?;
    if let Some(primary) = win.primary_monitor().map_err(|e| e.to_string())? {
        if let Some(i) = monitors
            .iter()
            .position(|m| m.position() == primary.position() && m.size() == primary.size())
        {
            monitors.swap(0, i);
        }
    }
    Ok(monitors.iter().map(Screen::from).collect())
}

fn restored(
    screens: &[Screen],
    raw: Option<Point>,
    saved_scale: Option<f64>,
    size: u32,
) -> Option<(Point, &Screen)> {
    restored_bounds(screens, raw, saved_scale, size, None)
}
fn restored_bounds(
    screens: &[Screen],
    raw: Option<Point>,
    saved_scale: Option<f64>,
    size: u32,
    bounds: Option<crate::file_transfer::layout::Rect>,
) -> Option<(Point, &Screen)> {
    let primary = screens.first()?;
    if let Some((x, y)) = raw {
        // Legacy Mac records used pixels of the window's monitor, without recording its scale.
        let mut best = None;
        let mut most = 0.;
        for screen in screens {
            let d = divisor(
                saved_scale
                    .filter(|s| s.is_finite() && *s > 0.)
                    .unwrap_or(screen.scale),
            );
            let p = ((x as f64 / d).round() as i32, (y as f64 / d).round() as i32);
            let area = screen.overlap(p, size);
            if area > most {
                most = area;
                let fitted = if let Some(group) = bounds {
                    let a = screen.work;
                    crate::file_transfer::layout::fit_group(
                        p,
                        screen.units,
                        (a[0] as i32, a[1] as i32, a[2] as u32, a[3] as u32),
                        group,
                    )
                } else {
                    screen.fit(p, size)
                };
                best = Some((fitted, screen));
            }
        }
        if best.is_some() {
            return best;
        }
    }
    Some((primary.corner(size), primary))
}

fn place(win: &WebviewWindow, p: Point) -> R<()> {
    if crate::file_transfer::place_pet(win, p) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    let target = tauri::Position::Logical(tauri::LogicalPosition::new(p.0 as f64, p.1 as f64));
    #[cfg(not(target_os = "macos"))]
    let target = tauri::Position::Physical(tauri::PhysicalPosition::new(p.0, p.1));
    win.set_position(target).map_err(|e| e.to_string())
}

fn persist(app: &AppHandle, win: &WebviewWindow, p: Point, screen: &Screen) -> R<()> {
    place(win, p)?;
    let d = divisor(screen.scale);
    let raw = Some((
        (p.0 as f64 * d).round() as i32,
        (p.1 as f64 * d).round() as i32,
    ));
    let state = app.state::<State>();
    {
        let s = state.settings.lock().map_err(|e| e.to_string())?;
        if s.position == raw && s.position_scale == Some(screen.scale) {
            return Ok(());
        }
    }
    state.update_settings(|s| {
        s.position = raw;
        s.position_scale = Some(screen.scale);
    })
}

pub fn restore(app: &AppHandle, win: &WebviewWindow, settings: &Settings) -> R<()> {
    let screens = layout(win)?;
    if let Some((p, screen)) = restored_bounds(
        &screens,
        settings.position,
        settings.position_scale,
        settings.size,
        crate::file_transfer::visible_bounds(app, settings.size),
    ) {
        persist(app, win, p, screen)?;
    }
    Ok(())
}

fn cursor_screen<'a>(win: &WebviewWindow, screens: &'a [Screen]) -> R<((f64, f64), &'a Screen)> {
    let pos = win.cursor_position().map_err(|e| e.to_string())?;
    let primary = screens.first().ok_or(t("host.noScreen"))?;
    let d = divisor(primary.scale);
    let cursor = (pos.x / d, pos.y / d);
    Ok((cursor, screen_at(screens, cursor).unwrap()))
}

fn screen_at(screens: &[Screen], cursor: (f64, f64)) -> Option<&Screen> {
    screens
        .iter()
        .find(|s| {
            let [x, y, w, h] = s.bounds;
            cursor.0 >= x && cursor.0 < x + w && cursor.1 >= y && cursor.1 < y + h
        })
        .or_else(|| {
            screens.iter().min_by(|a, b| {
                a.cursor_distance(cursor)
                    .total_cmp(&b.cursor_distance(cursor))
            })
        })
}

fn drag_target(
    screen: &Screen,
    cursor: (f64, f64),
    grab: (f64, f64),
    size: u32,
    release: bool,
) -> Point {
    let p = (
        (cursor.0 - grab.0 * screen.units).round() as i32,
        (cursor.1 - grab.1 * screen.units).round() as i32,
    );
    if release {
        screen.fit(p, size)
    } else {
        p
    }
}

// The grab offset stays in logical units even when the cursor changes monitors.
#[tauri::command]
pub fn drag_pet(app: AppHandle, grab_x: f64, grab_y: f64, release: bool) -> R<()> {
    let win = app.get_webview_window("pet").ok_or(t("host.petClosed"))?;
    let screens = layout(&win)?;
    let (cursor, screen) = cursor_screen(&win, &screens)?;
    let size = app.state::<State>().settings.lock().unwrap().size;
    let p = drag_target(screen, cursor, (grab_x, grab_y), size, false);
    let a = screen.work;
    let p = crate::file_transfer::constrain(
        &app,
        p,
        (a[0] as i32, a[1] as i32, a[2] as u32, a[3] as u32),
        screen.units,
        size,
        release,
    );
    if release {
        persist(&app, &win, p, screen)
    } else {
        place(&win, p)
    }
}

pub fn recall(app: &AppHandle) -> R<()> {
    let state = app.state::<State>();
    let s = state.settings.lock().unwrap().clone();
    if s.active_id.is_none() {
        return crate::open_studio(app.clone());
    }
    let win = app.get_webview_window("pet").ok_or(t("host.petClosed"))?;
    let screens = layout(&win)?;
    let (_, screen) = cursor_screen(&win, &screens)?;
    persist(app, &win, screen.corner(s.size), screen)?;
    state.update_settings(|s| s.visible = true)?;
    crate::refresh(app)
}

// Reuse the host's existing two-second tick. Monitor APIs and recovery run on
// the UI thread, and an unchanged layout never moves the pet or writes to disk.
pub fn watch_layout(app: &AppHandle) -> impl Fn() + Send + 'static {
    use std::sync::{Arc, Mutex};
    let app = app.clone();
    let initial = app
        .get_webview_window("pet")
        .and_then(|w| layout(&w).ok())
        .unwrap_or_default();
    let previous = Arc::new(Mutex::new(initial));
    move || {
        let app_handle = app.clone();
        let previous = previous.clone();
        let _ = app.run_on_main_thread(move || {
            let Some(win) = app_handle.get_webview_window("pet") else {
                return;
            };
            let Ok(next) = layout(&win) else {
                return;
            };
            let mut old = previous.lock().unwrap();
            if next.is_empty() || next == *old {
                return;
            }
            let s = app_handle.state::<State>().settings.lock().unwrap().clone();
            if let Some((p, screen)) = restored_bounds(
                &next,
                s.position,
                s.position_scale,
                s.size,
                crate::file_transfer::visible_bounds(&app_handle, s.size),
            ) {
                if persist(&app_handle, &win, p, screen).is_ok() {
                    *old = next;
                }
            }
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn screen(x: i32, y: i32, units: f64) -> Screen {
        Screen {
            bounds: [x as f64, y as f64, 1200., 900.],
            work: [x as f64, y as f64 + 24., 1200., 836.],
            units,
            scale: 1.,
        }
    }
    #[test]
    fn free_crossing_then_drop_on_pointer_screen() {
        let screens = [screen(0, 0, 1.), screen(1200, 200, 1.5)];
        let mouse = (1200., 208.);
        let target = screen_at(&screens, mouse).unwrap();
        assert_eq!(
            drag_target(target, mouse, (40., 32.), 160, false),
            (1140, 160)
        );
        assert_eq!(
            drag_target(target, mouse, (40., 32.), 160, true),
            (1200, 224)
        );
        let mouse = (2399., 1099.);
        assert_eq!(drag_target(target, mouse, (5., 5.), 160, true), (2160, 800));
    }
    #[test]
    fn visible_top_position_survives_restart_without_reintroducing_padding() {
        let screens = [screen(0, 0, 1.)];
        let bounds = crate::file_transfer::layout::Rect {
            x: 20.,
            y: 60.,
            width: 140.,
            height: 110.,
        };
        assert_eq!(
            restored_bounds(&screens, Some((100, -36)), Some(1.), 160, Some(bounds))
                .unwrap()
                .0,
            (100, -36)
        );
    }
    #[test]
    fn restart_unplug_and_gap() {
        let screens = [screen(0, 0, 1.), screen(-1200, -300, 1.)];
        let restore = |set: &[Screen], p| restored(set, Some(p), Some(1.), 120).unwrap().0;
        assert_eq!(restore(&screens, (-800, -100)), (-800, -100));
        assert_eq!(restore(&screens, (-1215, -300)), (-1200, -276));
        assert_eq!(restore(&screens[..1], (-800, -100)), screens[0].corner(120));
        assert_eq!(restore(&screens, (0, -200)), screens[0].corner(120));
        assert!(restored(&[], Some((1, 2)), None, 80).is_none());
    }
    #[test]
    fn recall_uses_mouse_screen_even_over_taskbar() {
        let screens = [screen(0, 0, 1.), screen(-1200, 0, 1.)];
        assert_eq!(
            screen_at(&screens, (-5., 880.)).unwrap().corner(160),
            (-192, 654)
        );
    }
    #[cfg(target_os = "macos")]
    #[test]
    fn retina_old_and_new_positions_use_points() {
        let mut retina = screen(-1200, 0, 1.);
        retina.scale = 2.;
        for scale in [None, Some(2.)] {
            assert_eq!(
                restored(
                    &[screen(0, 0, 1.), retina.clone()],
                    Some((-1800, 160)),
                    scale,
                    160
                )
                .unwrap()
                .0,
                (-900, 80)
            );
        }
    }
}
