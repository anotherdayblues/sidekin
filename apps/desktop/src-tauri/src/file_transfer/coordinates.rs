use super::layout::Rect;
use tauri::{Monitor, WebviewWindow};
// Points on macOS; physical desktop pixels on Windows. CSS hit coordinates
// are converted with the single window's current scale.
#[derive(Clone, Copy, Debug)]
pub struct WindowSpace {
    pub x: f64,
    pub y: f64,
    pub units: f64,
}
impl WindowSpace {
    fn from_raw(x: f64, y: f64, scale: f64, mac: bool) -> Self {
        let d = if mac { scale } else { 1. };
        Self {
            x: x / d,
            y: y / d,
            units: scale / d,
        }
    }
    pub fn read(win: &WebviewWindow) -> Option<Self> {
        let p = win.outer_position().ok()?;
        Some(Self::from_raw(
            p.x as f64,
            p.y as f64,
            win.scale_factor().ok()?,
            cfg!(target_os = "macos"),
        ))
    }
    pub fn local(self, x: f64, y: f64) -> (f64, f64) {
        ((x - self.x) / self.units, (y - self.y) / self.units)
    }
}
pub fn place(win: &WebviewWindow, x: f64, y: f64) {
    #[cfg(target_os = "macos")]
    let p = tauri::Position::Logical(tauri::LogicalPosition::new(x, y));
    #[cfg(not(target_os = "macos"))]
    let p = tauri::Position::Physical(tauri::PhysicalPosition::new(
        x.round() as i32,
        y.round() as i32,
    ));
    let _ = win.set_position(p);
}
pub fn work(mon: &Monitor) -> Rect {
    let a = mon.work_area();
    let d = if cfg!(target_os = "macos") {
        mon.scale_factor()
    } else {
        1.
    };
    Rect {
        x: a.position.x as f64 / d,
        y: a.position.y as f64 / d,
        width: a.size.width as f64 / d,
        height: a.size.height as f64 / d,
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn mac_cursor_and_window_share_global_points() {
        for scale in [1., 2.] {
            let w = WindowSpace::from_raw(-900. * scale, 90. * scale, scale, true);
            assert_eq!(w.local(-740., 180.), (160., 90.));
        }
    }
    #[test]
    fn windows_local_pixels_follow_window_dpi() {
        let w = WindowSpace::from_raw(-1500., 200., 1.5, false);
        assert_eq!(w.local(-1029., 477.5), (314., 185.));
    }
}
