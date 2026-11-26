// Uses the same drag-rs options as Holdem commands/drag_ops.rs (MIT):
// native copy, with cancellation return animation disabled.
use super::{coordinates::WindowSpace, layout::Rect, pointer, state::Lab};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{channel, Sender},
        Arc, Mutex,
    },
};
use tauri::{AppHandle, Manager, Window};
type Completion = Arc<Mutex<Option<Sender<Result<String, String>>>>>;
fn claim(active: &AtomicBool, held: bool) -> Result<(), String> {
    if !held {
        return Err("drag gesture released".into());
    }
    active
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .map(|_| ())
        .map_err(|_| "drag already active".into())
}
// The pet window captures the mouse for the whole outgoing gesture, so a
// release anywhere inside it lands on our own webview. The OS reports that as
// a drop; it means the files never left — unless a visible internal drop
// target (`chat` or `studio`) contains the release point.
fn landed_on_self(point: (f64, f64), window: Rect) -> bool {
    window.contains(point.0, point.1)
}
fn landed_on_pet_only(point: (f64, f64), pet: Option<Rect>, targets: &[Rect]) -> bool {
    if targets.iter().any(|r| r.contains(point.0, point.1)) {
        return false;
    }
    pet.is_some_and(|w| landed_on_self(point, w))
}
fn frame_of(win: &tauri::WebviewWindow) -> Option<Rect> {
    let frame = WindowSpace::read(win)?;
    let size = win.outer_size().ok()?;
    let per_unit = win.scale_factor().ok()? / frame.units;
    Some(Rect {
        x: frame.x,
        y: frame.y,
        width: size.width as f64 / per_unit,
        height: size.height as f64 / per_unit,
    })
}
fn pet_frame(app: &AppHandle) -> Option<Rect> {
    frame_of(&app.get_webview_window("pet")?)
}
fn internal_drop_targets(app: &AppHandle) -> Vec<Rect> {
    ["chat", "studio"]
        .into_iter()
        .filter_map(|label| {
            let win = app.get_webview_window(label)?;
            win.is_visible().unwrap_or(false).then(|| frame_of(&win))?
        })
        .collect()
}
fn outcome(app: &AppHandle, result: drag::DragResult) -> &'static str {
    let p = pointer::read();
    let pet = pet_frame(app);
    let targets = internal_drop_targets(app);
    match result {
        drag::DragResult::Dropped if !landed_on_pet_only((p.x, p.y), pet, &targets) => "Dropped",
        _ => "Cancel",
    }
}
fn complete(app: &AppHandle, end: &Completion, result: Result<String, String>) {
    if let Some(tx) = end.lock().unwrap().take() {
        if let Some(s) = app.try_state::<Lab>() {
            s.outgoing.store(false, Ordering::SeqCst);
        }
        let _ = tx.send(result);
    }
}
#[tauri::command]
pub async fn lab_drag(
    app: AppHandle,
    window: Window,
    paths: Vec<PathBuf>,
    icon: PathBuf,
) -> Result<String, String> {
    if window.label() != "pet" {
        return Err("file window required".into());
    }
    let root = app.state::<Lab>().root.clone();
    if icon != root.join("drag-preview.png") || !icon.is_file() {
        return Err("invalid preview".into());
    }
    if paths.is_empty() {
        return Err("file missing".into());
    }
    for p in &paths {
        if !p.is_absolute() || !p.exists() {
            return Err("file missing".into());
        }
        // Only open/probe volatile or cross-app sandbox paths; normal user paths
        // (Desktop/Documents/Downloads) rely on `exists()` so we never trigger
        // extra macOS folder TCC prompts when starting a drag.
        if super::staging::needs_staging(p) {
            match super::staging::is_readable(p) {
                Ok(()) => {}
                Err(true) => return Err("file_unreadable".into()),
                Err(false) => return Err("file missing".into()),
            }
        }
    }
    let (tx, rx) = channel();
    let end = Arc::new(Mutex::new(Some(tx)));
    let handle = app.clone();
    app.run_on_main_thread(move || {
        let state = handle.state::<Lab>();
        // Check the real mouse button after all asynchronous preparation has ended.
        if let Err(error) = claim(&state.outgoing, pointer::read().left) {
            if let Some(tx) = end.lock().unwrap().take() {
                let _ = tx.send(Err(error));
            }
            return;
        }
        let callback_app = handle.clone();
        let callback_end = end.clone();
        // drag-rs takes the GTK window on Linux; this lets the crate build
        // and test in Linux cloud sessions.
        #[cfg(target_os = "linux")]
        let Ok(window) = window.gtk_window() else {
            complete(&handle, &end, Err("no native window".into()));
            return;
        };
        let result = drag::start_drag(
            &window,
            drag::DragItem::Files(paths),
            drag::Image::File(icon),
            move |result, _| {
                let result = outcome(&callback_app, result);
                complete(&callback_app, &callback_end, Ok(result.into()))
            },
            drag::Options {
                skip_animatation_on_cancel_or_failure: true,
                mode: drag::DragMode::Copy,
            },
        );
        if let Err(error) = result {
            complete(&handle, &end, Err(error.to_string()));
        }
    })
    .map_err(|e| e.to_string())?;
    // Resolve on the native end callback, rather than on session creation.
    // Wait on the blocking pool so the drag does not hold an async worker.
    tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|e| e.to_string())?
        .map_err(|e| e.to_string())?
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn released_or_overlapping_gestures_cannot_start_a_session() {
        let active = AtomicBool::new(false);
        assert!(claim(&active, false).is_err());
        assert!(!active.load(Ordering::SeqCst));
        assert!(claim(&active, true).is_ok());
        assert!(claim(&active, true).is_err());
        active.store(false, Ordering::SeqCst);
        assert!(claim(&active, true).is_ok());
    }
    #[test]
    fn releasing_over_the_pet_window_is_not_a_delivery() {
        let window = Rect {
            x: 100.,
            y: 50.,
            width: 300.,
            height: 260.,
        };
        assert!(landed_on_self((120., 300.), window));
        assert!(landed_on_self((400., 50.), window));
        assert!(!landed_on_self((401., 200.), window));
        assert!(!landed_on_self((250., 20.), window));
    }
    #[test]
    fn dropping_onto_visible_chat_or_studio_overlapping_pet_is_a_delivery() {
        let pet = Rect {
            x: 800.,
            y: 200.,
            width: 280.,
            height: 260.,
        };
        let chat = Rect {
            x: 1000.,
            y: 30.,
            width: 400.,
            height: 840.,
        };
        let studio = Rect {
            x: 100.,
            y: 100.,
            width: 900.,
            height: 600.,
        };
        // Overlap between pet [800..1080] and chat [1000..1400]: drop at x=1040 lands on chat!
        assert!(!landed_on_pet_only((1040., 300.), Some(pet), &[chat]));
        // Inside chat only: delivered.
        assert!(!landed_on_pet_only((1200., 300.), Some(pet), &[chat]));
        // Inside pet only (x=900, outside chat): still on pet -> Cancel.
        assert!(landed_on_pet_only((900., 300.), Some(pet), &[chat]));
        // When chat is hidden (not in targets), overlap point counts as pet -> Cancel.
        assert!(landed_on_pet_only((1040., 300.), Some(pet), &[]));
        // Overlapping visible studio window also counts as delivered.
        assert!(!landed_on_pet_only((850., 300.), Some(pet), &[studio]));
        // Outside both pet and targets (e.g. Finder/Desktop): delivered.
        assert!(!landed_on_pet_only((50., 50.), Some(pet), &[chat]));
    }
}
