use super::{
    coordinates::{self, WindowSpace},
    layout::{self, Rect},
    state::Lab,
};
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager, WebviewWindow};
fn anchor(s: &Lab, win: &WebviewWindow) -> Option<(f64, f64)> {
    if let Some(p) = *s.anchor.lock().unwrap() {
        return Some(p);
    }
    let frame = WindowSpace::read(win)?;
    Some((frame.x, frame.y))
}
pub fn work_areas(win: &WebviewWindow, p: (f64, f64)) -> Option<(Rect, Rect)> {
    let areas: Vec<_> = win
        .available_monitors()
        .ok()?
        .iter()
        .map(coordinates::work)
        .collect();
    let first = *areas.first()?;
    let current = areas
        .iter()
        .find(|r| r.contains(p.0, p.1))
        .copied()
        .unwrap_or_else(|| {
            *areas
                .iter()
                .min_by(|a, b| {
                    let distance = |r: &Rect| {
                        (p.0 - p.0.clamp(r.x, r.x + r.width)).powi(2)
                            + (p.1 - p.1.clamp(r.y, r.y + r.height)).powi(2)
                    };
                    distance(a).total_cmp(&distance(b))
                })
                .unwrap()
        });
    Some((current, areas.into_iter().fold(first, Rect::union)))
}
pub fn bounds(s: &Lab, size: f64) -> Rect {
    layout::group_bounds(&s.view.lock().unwrap(), size, *s.shape.lock().unwrap())
}
pub fn geometry(app: &tauri::AppHandle) -> Option<Value> {
    let win = app.get_webview_window("pet")?;
    geometry_in(app, WindowSpace::read(&win)?)
}
fn geometry_in(app: &tauri::AppHandle, frame: WindowSpace) -> Option<Value> {
    let s = app.try_state::<Lab>()?;
    let win = app.get_webview_window("pet")?;
    let p = anchor(&s, &win)?;
    let size = s.size.load(Ordering::Relaxed) as f64;
    let body = *s.shape.lock().unwrap();
    let center = (
        p.0 + (body.x + body.width / 2.) * size * frame.units,
        p.1 + (body.y + body.height / 2.) * layout::height(size) * frame.units,
    );
    let (work, _) = work_areas(&win, center)?;
    let origin = frame.local(p.0, p.1);
    let view = s.view.lock().unwrap().clone();
    Some(
        json!({"origin":{"x":origin.0,"y":origin.1},"pet":{"width":size,"height":layout::height(size),"body":body},"positions":layout::attachments(&view,size,body),"work":{"x":(work.x-frame.x)/frame.units,"y":(work.y-frame.y)/frame.units,"width":work.width/frame.units,"height":work.height/frame.units}}),
    )
}
pub fn sync(app: &tauri::AppHandle) {
    let Some(s) = app.try_state::<Lab>() else {
        return;
    };
    let Some(win) = app.get_webview_window("pet") else {
        return;
    };
    let Some(frame) = WindowSpace::read(&win) else {
        return;
    };
    let Some(p) = anchor(&s, &win) else { return };
    let size = s.size.load(Ordering::Relaxed) as f64;
    let body = *s.shape.lock().unwrap();
    let Some((_, desktop)) = work_areas(
        &win,
        (
            p.0 + (body.x + body.width / 2.) * size * frame.units,
            p.1 + (body.y + body.height / 2.) * layout::height(size) * frame.units,
        ),
    ) else {
        return;
    };
    let overlays = s.overlays.lock().unwrap().clone();
    let target = layout::viewport(p, frame.units, size, &overlays, desktop);
    let scale = win.scale_factor().unwrap_or(1.);
    let physical = win.inner_size().ok();
    let factor = scale / frame.units;
    let w = (target.width * factor).ceil() as u32;
    let h = (target.height * factor).ceil() as u32;
    let needs_resize = physical.is_none_or(|actual| actual.width != w || actual.height != h);
    let settled = settled(frame, target);
    let needs_move = settled.x != frame.x || settled.y != frame.y;
    if needs_resize && needs_move && move_before_resize(frame, target, physical, w, h) {
        coordinates::place(&win, target.x, target.y);
        let _ = win.set_size(tauri::PhysicalSize::new(w, h));
    } else {
        if needs_resize {
            let _ = win.set_size(tauri::PhysicalSize::new(w, h));
        }
        if needs_move {
            coordinates::place(&win, target.x, target.y);
        }
    }
    if let Some(g) = geometry_in(app, settled) {
        let _ = app.emit_to("pet", "lab-layout", g);
    }
}
// When growing leftward/upward near a screen edge, move the origin first so
// the expanded size never momentarily pokes past the right/bottom monitor edge
// (where macOS can constrain or squish the window). When shrinking or moving
// right/down, resize first so the old wider frame doesn't poke past the edge.
fn move_before_resize(
    frame: WindowSpace,
    target: Rect,
    actual: Option<tauri::PhysicalSize<u32>>,
    w: u32,
    h: u32,
) -> bool {
    let growing = actual.is_none_or(|a| w > a.width || h > a.height);
    let moving_left_or_up = target.x < frame.x || target.y < frame.y;
    growing && moving_left_or_up
}
// A Mac moves the window later, so reading it back right after a move still
// gives the old place. Draw for where the window is going, or a pet bounced
// back from the screen edge stays drawn shifted and half cut off.
fn settled(frame: WindowSpace, target: Rect) -> WindowSpace {
    if (target.x - frame.x).abs() > 0.75 || (target.y - frame.y).abs() > 0.75 {
        WindowSpace {
            x: target.x,
            y: target.y,
            ..frame
        }
    } else {
        frame
    }
}
pub fn place(win: &WebviewWindow, p: (i32, i32)) -> bool {
    let Some(s) = win.app_handle().try_state::<Lab>() else {
        return false;
    };
    *s.anchor.lock().unwrap() = Some((p.0 as f64, p.1 as f64));
    sync(win.app_handle());
    true
}
pub fn resize(app: &tauri::AppHandle, size: u32) -> bool {
    let Some(s) = app.try_state::<Lab>() else {
        return false;
    };
    if s.size.swap(size, Ordering::Relaxed) != size {
        s.overlays.lock().unwrap().clear();
        s.regions.lock().unwrap().clear();
        let view = s.view.lock().unwrap().clone();
        let _ = s.save(view);
    }
    sync(app);
    fit_idle(app);
    true
}
pub fn fit_idle(app: &tauri::AppHandle) {
    let Some(s) = app.try_state::<Lab>() else {
        return;
    };
    let Some(win) = app.get_webview_window("pet") else {
        return;
    };
    let Some(frame) = WindowSpace::read(&win) else {
        return;
    };
    let Some(p) = anchor(&s, &win) else { return };
    let size = s.size.load(Ordering::Relaxed) as f64;
    let body = *s.shape.lock().unwrap();
    let Some((work, _)) = work_areas(
        &win,
        (
            p.0 + (body.x + body.width / 2.) * size * frame.units,
            p.1 + (body.y + body.height / 2.) * layout::height(size) * frame.units,
        ),
    ) else {
        return;
    };
    let next = layout::fit_group(
        (p.0.round() as i32, p.1.round() as i32),
        frame.units,
        (
            work.x as i32,
            work.y as i32,
            work.width as u32,
            work.height as u32,
        ),
        bounds(&s, size),
    );
    if (p.0 - next.0 as f64).abs() > 0.75 || (p.1 - next.1 as f64).abs() > 0.75 {
        *s.anchor.lock().unwrap() = Some((next.0 as f64, next.1 as f64));
        sync(app);
        let factor = if cfg!(target_os = "macos") {
            win.scale_factor().unwrap_or(1.)
        } else {
            1.
        };
        let _ = app.state::<crate::State>().update_settings(|settings| {
            settings.position = Some((
                (next.0 as f64 * factor).round() as i32,
                (next.1 as f64 * factor).round() as i32,
            ));
            settings.position_scale = Some(win.scale_factor().unwrap_or(1.));
        });
    }
}
pub fn physical_pet(
    app: &tauri::AppHandle,
) -> Option<(tauri::PhysicalPosition<i32>, tauri::PhysicalSize<u32>)> {
    let s = app.try_state::<Lab>()?;
    let win = app.get_webview_window("pet")?;
    let p = anchor(&s, &win)?;
    let frame = WindowSpace::read(&win)?;
    let scale = win.scale_factor().ok()?;
    let d = scale / frame.units;
    let size = s.size.load(Ordering::Relaxed) as f64;
    Some((
        tauri::PhysicalPosition::new((p.0 * d).round() as i32, (p.1 * d).round() as i32),
        tauri::PhysicalSize::new(
            (size * scale).round() as u32,
            (layout::height(size) * scale).round() as u32,
        ),
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounce_back_draws_for_the_new_window_place_not_the_stale_one() {
        // Released 40 points past the right edge, then bounced back to 1162.
        let stale = WindowSpace { x: 1202., y: 53., units: 1. };
        let anchor = (1162., 53.);
        let desktop = Rect { x: -1280., y: 0., width: 2560., height: 690. };
        let target = layout::viewport(anchor, 1., 140., &[], desktop);
        let now = settled(stale, target);
        assert_eq!(now.local(anchor.0, anchor.1), (0., 0.));
        // Nothing moved: keep the window's own place.
        let still = WindowSpace { x: 1162., y: 53., units: 1. };
        assert_eq!(settled(still, target).x, 1162.);
    }
    #[test]
    fn move_before_resize_orders_edge_expansion_and_collapse_safely() {
        let right_edge = WindowSpace { x: 1300., y: 500., units: 1. };
        let compact = Some(tauri::PhysicalSize::new(154, 152));
        // Expanding leftward: move first, then grow.
        assert!(move_before_resize(
            right_edge,
            Rect { x: 900., y: 500., width: 554., height: 220. },
            compact,
            554,
            220,
        ));
        // Expanding upward: move first, then grow.
        assert!(move_before_resize(
            right_edge,
            Rect { x: 1300., y: 260., width: 154., height: 392. },
            compact,
            154,
            392,
        ));
        // Collapsing rightward back to compact: shrink first, then move.
        let expanded_frame = WindowSpace { x: 900., y: 500., units: 1. };
        let expanded_size = Some(tauri::PhysicalSize::new(554, 220));
        assert!(!move_before_resize(
            expanded_frame,
            Rect { x: 1300., y: 500., width: 154., height: 152. },
            expanded_size,
            154,
            152,
        ));
        // Growing rightward: resize first is already safe.
        assert!(!move_before_resize(
            WindowSpace { x: 100., y: 100., units: 1. },
            Rect { x: 100., y: 100., width: 554., height: 220. },
            compact,
            554,
            220,
        ));
    }
}
