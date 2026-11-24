use super::{coordinates::WindowSpace, layout, pointer, scene, state::Lab};
use serde_json::json;
use std::{
    sync::atomic::Ordering,
    time::{Duration, Instant},
};
use tauri::{Emitter, Manager};
// Idle checks keep the pet inside a work area that changed on its own (for
// example the Dock appearing). Every tick that matters already runs one.
const IDLE_LOOK: Duration = Duration::from_secs(5);
/// Reading the pointer this often catches even a short click.
const PACE: Duration = Duration::from_millis(35);
/// When nothing nearby can need a quick read: the pet put away, or the
/// cursor far from it (or resting) with the button up and no file panel
/// open. A press is then seen at most this late; once the button is down,
/// reads are quick again.
const SLOW_PACE: Duration = Duration::from_millis(250);
/// A cursor resting this long counts as resting, even near the pet: the
/// pet window takes its own clicks, and the first move is caught within
/// `SLOW_PACE`.
const RESTING: Duration = Duration::from_secs(2);
/// What a tick has to do. With the button up on both reads, nothing about a
/// press, a drag or the cursor-owner can change, so it only now and then
/// looks at the pet window, to fit it and to notice it was put away. While
/// it is away it looks every tick, to notice it is back.
#[derive(Debug, PartialEq)]
enum Tick {
    Idle { look: bool },
    Track,
}
fn tick(was_down: bool, down: bool, look_due: bool, hidden: bool) -> Tick {
    if was_down || down {
        Tick::Track
    } else {
        Tick::Idle {
            look: hidden || look_due,
        }
    }
}
/// What decides how soon the pointer is read again.
#[derive(Default)]
struct Need {
    hidden: bool,
    /// The button is down now or was on the last read.
    down: bool,
    /// The file panel is open: a click anywhere else closes it.
    panel_open: bool,
    /// Files are being dragged out of the pet.
    outgoing: bool,
    /// The pet page says the cursor is near it (petPointer.ts).
    near: bool,
    /// Since the cursor last moved.
    resting: Duration,
}
fn pace(n: &Need) -> Duration {
    if n.hidden {
        return SLOW_PACE;
    }
    if n.down || n.panel_open || n.outgoing || (n.near && n.resting < RESTING) {
        return PACE;
    }
    SLOW_PACE
}
/// Far from the pet, the cursor is sent at most this often.
const FAR_PUSH: Duration = Duration::from_millis(250);
/// Sends the cursor to the pet page only when it moved, so the page never
/// has to ask. Far away, at most every `FAR_PUSH`; the last position still
/// arrives once that much time has passed.
#[derive(Default)]
struct CursorPush {
    last: Option<(f64, f64)>,
    at: Option<Instant>,
}
impl CursorPush {
    fn due(&mut self, at: (f64, f64), fast: bool, now: Instant) -> bool {
        if self.last == Some(at) {
            return false;
        }
        if !fast && self.at.is_some_and(|t| now.duration_since(t) < FAR_PUSH) {
            return false;
        }
        self.last = Some(at);
        self.at = Some(now);
        true
    }
}
/// The cursor now, in the tracker's units (points on macOS, physical pixels
/// on Windows): where the pet page starts before the first push.
#[tauri::command]
pub fn lab_cursor() -> (f64, f64) {
    let p = pointer::read();
    (p.x, p.y)
}
#[tauri::command]
pub fn lab_cursor_near(state: tauri::State<Lab>, near: bool) {
    state.cursor_near.store(near, Ordering::Relaxed);
}
pub fn spawn(app: tauri::AppHandle) {
    std::thread::spawn(move || {
        let mut last = pointer::read();
        let mut start = (last.x, last.y);
        let mut from_ours = false;
        let mut real_drag = false;
        let mut drag_count = last.count;
        let mut was_dragging = false;
        let mut looked = Instant::now();
        let mut moved_at = Instant::now();
        let mut hidden = false;
        let mut push = CursorPush::default();
        let mut next = PACE;
        loop {
            std::thread::sleep(next);
            let p = pointer::read();
            let now = Instant::now();
            if (p.x, p.y) != (last.x, last.y) {
                moved_at = now;
            }
            let s = app.state::<Lab>();
            let near = s.cursor_near.load(Ordering::Relaxed);
            next = pace(&Need {
                hidden,
                down: p.left || last.left,
                panel_open: s.panel_open.load(Ordering::Relaxed),
                outgoing: s.outgoing.load(Ordering::Relaxed),
                near,
                resting: now.duration_since(moved_at),
            });
            if !hidden && push.due((p.x, p.y), p.left || near, now) {
                let at = json!({"x": p.x, "y": p.y});
                let _ = app.emit_to("pet", "pet-cursor", at.clone());
                // The 番茄钟 clock opens and shows its buttons under the
                // pointer, which a window not in front cannot see itself.
                if crate::focus::on(&app) {
                    let _ = app.emit_to("clock", "pet-cursor", at);
                }
            }
            let look_due = now.duration_since(looked) >= IDLE_LOOK;
            if let Tick::Idle { look } = tick(last.left, p.left, look_due, hidden) {
                last = p;
                if !look {
                    continue;
                }
                looked = now;
                hidden = !app
                    .get_webview_window("pet")
                    .is_some_and(|w| w.is_visible().unwrap_or(false));
                if !hidden && !app.state::<Lab>().outgoing.load(Ordering::Relaxed) {
                    scene::fit_idle(&app);
                }
                continue;
            }
            looked = now;
            let Some(pet) = app.get_webview_window("pet") else {
                break;
            };
            hidden = !pet.is_visible().unwrap_or(false);
            if hidden {
                last = p;
                continue;
            }
            let Some(frame) = WindowSpace::read(&pet) else {
                continue;
            };
            let Some(anchor) = *s.anchor.lock().unwrap() else {
                last = p;
                continue;
            };
            let x = (p.x - anchor.0) / frame.units;
            let y = (p.y - anchor.1) / frame.units;
            let size = s.size.load(Ordering::Relaxed) as f64;
            let height = layout::height(size);
            let body = *s.shape.lock().unwrap();
            let hits = s.hits.lock().unwrap();
            let over_pet = if hits.is_empty() {
                x >= body.x * size
                    && x <= (body.x + body.width) * size
                    && y >= body.y * height
                    && y <= (body.y + body.height) * height
            } else {
                hits.iter().any(|r| r.contains(x / size, y / height))
            };
            drop(hits);
            let over_card = s.regions.lock().unwrap().iter().any(|r| r.contains(x, y));
            if p.left && !last.left {
                start = (p.x, p.y);
                drag_count = last.count;
                real_drag = false;
                from_ours = over_card || over_pet;
                if !over_card {
                    let _ = app.emit_to("pet", "lab-collapse", ());
                }
            }
            if p.left && p.count != drag_count {
                if !real_drag && !from_ours {
                    let _ = app.emit_to("pet", "lab-collapse", ());
                }
                real_drag = true;
            }
            let moved = (p.x - start.0).hypot(p.y - start.1) > 8.;
            let near = x >= body.x * size - 16.
                && x <= (body.x + body.width) * size + 16.
                && y >= body.y * height - 16.
                && y <= (body.y + body.height) * height + 16.;
            let outgoing = s.outgoing.load(Ordering::Relaxed);
            let candidate = p.left
                && moved
                && !from_ours
                && !outgoing
                && !s.pet_pressed.load(Ordering::Relaxed)
                && (!cfg!(target_os = "macos") || real_drag);
            let active = candidate && (near || over_card);
            if active != was_dragging {
                let _ = app.emit_to("pet", "file-transfer-drag", active);
                was_dragging = active;
            }
            if active {
                let scale = pet.scale_factor().unwrap_or(1.);
                let (gx, gy) = if cfg!(target_os = "macos") {
                    (p.x, p.y)
                } else {
                    (p.x / scale, p.y / scale)
                };
                let _ = app.emit_to("pet", "bubble-look", json!({"x":gx,"y":gy,"typing":true}));
            }
            if !p.left {
                s.valid_drag.store(false, Ordering::Relaxed);
                s.pet_pressed.store(false, Ordering::Relaxed);
            }
            // The page only reacts to the button changing.
            if p.left != last.left {
                let local = frame.local(p.x, p.y);
                let _=app.emit_to("pet","lab-pointer",json!({"x":local.0,"y":local.1,"petX":x,"petY":y,"left":p.left,"external":candidate,"near":near}));
            }
            if !p.left && !outgoing {
                scene::fit_idle(&app);
            }
            last = p;
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn an_idle_mouse_skips_tracking_and_looks_only_occasionally() {
        assert_eq!(tick(false, false, false, false), Tick::Idle { look: false });
        assert_eq!(tick(false, false, true, false), Tick::Idle { look: true });
        // Occasionally while idle, whatever the pace (drags check right away).
        assert_eq!(IDLE_LOOK, Duration::from_secs(5));
    }
    #[test]
    fn pressing_holding_and_releasing_are_all_tracked() {
        for hidden in [false, true] {
            assert_eq!(tick(false, true, false, hidden), Tick::Track);
            assert_eq!(tick(true, true, false, hidden), Tick::Track);
            assert_eq!(tick(true, false, false, hidden), Tick::Track);
        }
    }
    #[test]
    fn the_cursor_is_sent_only_when_it_moves_and_less_often_far_away() {
        let t = Instant::now();
        let ms = |n| t + Duration::from_millis(n);
        let mut push = CursorPush::default();
        assert!(push.due((1., 1.), false, t));
        // Still: nothing, however long.
        assert!(!push.due((1., 1.), true, ms(5_000)));
        // Near: every move.
        let mut near = CursorPush::default();
        assert!(near.due((1., 1.), true, t));
        assert!(near.due((2., 1.), true, ms(35)));
        assert!(near.due((3., 1.), true, ms(70)));
        // Far: a quick move waits, and the place it stopped still arrives.
        let mut far = CursorPush::default();
        assert!(far.due((1., 1.), false, t));
        assert!(!far.due((9., 9.), false, ms(100)));
        assert!(!far.due((9., 9.), false, ms(200)));
        assert!(far.due((9., 9.), false, ms(250)));
        assert!(!far.due((9., 9.), false, ms(600)));
        // Coming near (or pressing) sends at once.
        assert!(far.due((5., 5.), true, ms(260)));
    }
    #[test]
    fn a_put_away_pet_is_read_slowly_and_checked_every_tick() {
        assert_eq!(tick(false, false, false, true), Tick::Idle { look: true });
        let hidden = Need {
            hidden: true,
            near: true,
            ..Need::default()
        };
        assert_eq!(pace(&hidden), SLOW_PACE);
        // Once it shows again, tracking is back within a quarter second.
        assert!(SLOW_PACE <= Duration::from_millis(250));
    }
    #[test]
    fn reads_are_quick_wherever_a_short_click_or_a_drag_matters() {
        let quick = |n: Need| pace(&n) == PACE;
        // A short click (about 100 ms) falls on a read at this pace.
        assert!(PACE < Duration::from_millis(50));
        // The cursor moving near the pet.
        assert!(quick(Need {
            near: true,
            ..Need::default()
        }));
        // The button down anywhere: a file dragged in from far away.
        assert!(quick(Need {
            down: true,
            ..Need::default()
        }));
        // The file panel open: a click anywhere else closes it.
        assert!(quick(Need {
            panel_open: true,
            resting: Duration::from_secs(60),
            ..Need::default()
        }));
        // Files being dragged out of the pet.
        assert!(quick(Need {
            outgoing: true,
            ..Need::default()
        }));
    }
    #[test]
    fn far_or_resting_with_nothing_open_is_read_slowly() {
        // Far from the pet, button up, nothing open.
        assert_eq!(pace(&Need::default()), SLOW_PACE);
        // Near, but resting (or the screen locked).
        let resting = Need {
            near: true,
            resting: RESTING,
            ..Need::default()
        };
        assert_eq!(pace(&resting), SLOW_PACE);
        // Moving again: quick at once.
        let moving = Need {
            near: true,
            resting: Duration::from_millis(40),
            ..Need::default()
        };
        assert_eq!(pace(&moving), PACE);
    }
}
