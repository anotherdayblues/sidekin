mod coordinates;
pub mod layout;
pub mod outgoing;
mod pointer;
mod scene;
pub mod staging;
mod state;
pub mod tracker;
use layout::Rect;
pub use scene::{physical_pet, place as place_pet, resize};
use serde_json::{json, Value};
use state::Lab;
use std::sync::atomic::Ordering;
use tauri::{Emitter, Manager};
pub fn visible_bounds(app: &tauri::AppHandle, size: u32) -> Option<Rect> {
    app.try_state::<Lab>()
        .map(|s| scene::bounds(&s, size as f64))
}

/// Every file on the pet now, in order: only these can be sent to the phone.
pub fn staged_paths(app: &tauri::AppHandle) -> Vec<String> {
    let Some(lab) = app.try_state::<Lab>() else {
        return vec![];
    };
    let view = lab.view.lock().unwrap();
    view["state"]["items"]
        .as_array()
        .into_iter()
        .flatten()
        .flat_map(|i| i["paths"].as_array().cloned().unwrap_or_default())
        .filter_map(|p| p.as_str().map(String::from))
        .collect()
}

#[tauri::command]
pub fn lab_load(state: tauri::State<Lab>) -> Value {
    state.view.lock().unwrap().clone()
}
#[tauri::command]
pub fn lab_geometry(app: tauri::AppHandle) -> Option<Value> {
    scene::geometry(&app)
}
#[tauri::command]
pub fn lab_save(
    app: tauri::AppHandle,
    state: tauri::State<Lab>,
    view: Value,
) -> Result<(), String> {
    state.save(view)?;
    sync(&app);
    // A stack that appears or grows can push past the screen edge.
    scene::fit_idle(&app);
    Ok(())
}
#[tauri::command]
pub fn lab_regions(
    app: tauri::AppHandle,
    state: tauri::State<Lab>,
    regions: Vec<Rect>,
    origin: Option<serde_json::Value>,
    open: Option<bool>,
) {
    state
        .panel_open
        .store(open.unwrap_or(false), std::sync::atomic::Ordering::Relaxed);
    let x = origin.as_ref().and_then(|o| o["x"].as_f64()).unwrap_or(0.);
    let y = origin.as_ref().and_then(|o| o["y"].as_f64()).unwrap_or(0.);
    let relative: Vec<_> = regions
        .iter()
        .map(|r| Rect {
            x: r.x - x,
            y: r.y - y,
            ..*r
        })
        .collect();
    if !same_regions(&state.overlays.lock().unwrap(), &relative) {
        *state.overlays.lock().unwrap() = relative.clone();
        *state.regions.lock().unwrap() = relative;
        sync(&app);
    }
}
fn same_regions(a: &[Rect], b: &[Rect]) -> bool {
    a.len() == b.len()
        && a.iter().zip(b).all(|(a, b)| {
            (a.x - b.x).abs() < 0.25
                && (a.y - b.y).abs() < 0.25
                && (a.width - b.width).abs() < 0.25
                && (a.height - b.height).abs() < 0.25
        })
}
#[tauri::command]
pub fn lab_pet_shape(
    app: tauri::AppHandle,
    state: tauri::State<Lab>,
    bounds: Rect,
    regions: Option<Vec<Rect>>,
) {
    if bounds.width > 0.
        && bounds.height > 0.
        && bounds.x >= 0.
        && bounds.y >= 0.
        && bounds.x + bounds.width <= 1.01
        && bounds.y + bounds.height <= 1.01
    {
        *state.shape.lock().unwrap() = bounds;
        *state.hits.lock().unwrap() = regions
            .unwrap_or_default()
            .into_iter()
            .filter(|r| {
                r.width > 0.
                    && r.height > 0.
                    && r.x >= 0.
                    && r.y >= 0.
                    && r.x + r.width <= 1.01
                    && r.y + r.height <= 1.01
            })
            .take(4096)
            .collect();
        let view = state.view.lock().unwrap().clone();
        let _ = state.save(view);
        sync(&app);
    }
}
#[tauri::command]
pub fn lab_expand(app: tauri::AppHandle) {
    let _ = app.emit_to("pet", "lab-expand", true);
}
#[tauri::command]
pub fn lab_discard_staged(app: tauri::AppHandle, paths: Vec<String>) {
    if let Some(lab) = app.try_state::<Lab>() {
        staging::discard_staged(&lab.staged_root, &paths);
    }
}
fn referenced_paths(view: &Value) -> Vec<String> {
    ["items", "lastRemoved"]
        .into_iter()
        .flat_map(|key| {
            view["state"][key]
                .as_array()
                .into_iter()
                .flatten()
                .flat_map(|i| i["paths"].as_array().cloned().unwrap_or_default())
                .filter_map(|p| p.as_str().map(String::from))
        })
        .collect()
}
#[tauri::command]
pub fn lab_existing(paths: Vec<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|p| {
            let p = std::path::Path::new(p);
            p.is_absolute() && p.exists()
        })
        .collect()
}
#[tauri::command]
pub fn lab_describe(paths: Vec<String>) -> Vec<Value> {
    paths
        .into_iter()
        .map(|p| {
            let meta = std::path::Path::new(&p).metadata().ok();
            let dir = meta.as_ref().is_some_and(|m| m.is_dir());
            // Folders have no single size; the list shows a dash for them.
            let size = meta.as_ref().filter(|_| !dir).map(|m| m.len());
            json!({"path": p, "isDirectory": dir, "exists": meta.is_some(), "size": size})
        })
        .collect()
}
#[tauri::command]
pub fn lab_preview(state: tauri::State<Lab>, bytes: Vec<u8>) -> Result<String, String> {
    if bytes.len() < 24 || bytes.len() > 65536 || &bytes[..8] != b"\x89PNG\r\n\x1a\n" {
        return Err("invalid preview".into());
    }
    let w = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let h = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if w > 64 || h > 64 || w == 0 || h == 0 {
        return Err("preview too large".into());
    }
    let path = state.root.join("drag-preview.png");
    std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
    Ok(path.to_string_lossy().into())
}
pub fn setup(app: &mut tauri::App) -> Result<(), Box<dyn std::error::Error>> {
    if app.config().identifier != crate::profile::FILE_LAB_ID {
        return Err("集成小样需要独立身份".into());
    }
    let root = app.state::<crate::State>().root.join("file-transfer");
    std::fs::create_dir_all(&root)?;
    let staged_root = app
        .path()
        .app_cache_dir()
        .map(|d| d.join("file-transfer-staged"))
        .unwrap_or_else(|_| root.join("staged"));
    let lab = Lab::open(root).with_staged_root(staged_root);
    lab.size.store(
        app.state::<crate::State>().settings.lock().unwrap().size,
        Ordering::Relaxed,
    );
    let view = lab.view.lock().unwrap().clone();
    staging::cleanup_orphans(&lab.staged_root, &referenced_paths(&view));
    lab.save(view)?;
    app.manage(lab);
    tracker::spawn(app.handle().clone());
    Ok(())
}
pub fn sync(app: &tauri::AppHandle) {
    scene::sync(app);
}
pub fn constrain(
    app: &tauri::AppHandle,
    p: (i32, i32),
    work: (i32, i32, u32, u32),
    units: f64,
    size: u32,
    release: bool,
) -> (i32, i32) {
    let Some(s) = app.try_state::<Lab>() else {
        return p;
    };
    s.pet_pressed.store(!release, Ordering::Relaxed);
    let group = layout::group_bounds(
        &s.view.lock().unwrap(),
        size as f64,
        *s.shape.lock().unwrap(),
    );
    layout::fit_drag(p, units, work, group, release)
}
fn drop_target(window: &tauri::Window, s: &Lab, x: f64, y: f64, scale: f64) -> bool {
    let Some(pet) = window.app_handle().get_webview_window("pet") else {
        return false;
    };
    let Some(frame) = coordinates::WindowSpace::read(&pet) else {
        return false;
    };
    let Some(anchor) = *s.anchor.lock().unwrap() else {
        return false;
    };
    let x = x / scale - (anchor.0 - frame.x) / frame.units;
    let y = y / scale - (anchor.1 - frame.y) / frame.units;
    let size = s.size.load(Ordering::Relaxed) as f64;
    let body = *s.shape.lock().unwrap();
    let h = layout::height(size);
    (x >= body.x * size - 16.
        && x <= (body.x + body.width) * size + 16.
        && y >= body.y * h - 16.
        && y <= (body.y + body.height) * h + 16.)
        || s.regions.lock().unwrap().iter().any(|r| r.contains(x, y))
}
pub fn handle(window: &tauri::Window, event: &tauri::WindowEvent) {
    if window.label() == "pet"
        && matches!(
            event,
            tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. }
        )
    {
        sync(window.app_handle());
    }
    if window.label() != "pet" {
        return;
    }
    let Some(s) = window.app_handle().try_state::<Lab>() else {
        return;
    };
    if let tauri::WindowEvent::DragDrop(d) = event {
        if s.outgoing.load(Ordering::SeqCst) {
            return;
        }
        let scale = window.scale_factor().unwrap_or(1.);
        match d {
            tauri::DragDropEvent::Enter { paths, position } => {
                s.valid_drag.store(!paths.is_empty(), Ordering::Relaxed);
                let _=window.emit("lab-hover",json!({"active":!paths.is_empty()&&drop_target(window,&s,position.x,position.y,scale),"x":position.x/scale,"y":position.y/scale}));
            }
            tauri::DragDropEvent::Over { position } => {
                let _=window.emit("lab-hover",json!({"active":s.valid_drag.load(Ordering::Relaxed)&&drop_target(window,&s,position.x,position.y,scale),"x":position.x/scale,"y":position.y/scale}));
            }
            tauri::DragDropEvent::Drop { paths, position } => {
                s.valid_drag.store(false, Ordering::Relaxed);
                if drop_target(window, &s, position.x, position.y, scale) {
                    let allow_app_data =
                        crate::permissions::is_enabled(window.app_handle(), "appData");
                    let prepared =
                        staging::prepare_drop_with_policy(&s.staged_root, paths, allow_app_data);
                    let total_blocked = prepared.blocked + prepared.blocked_off;
                    let blocked_reason = if prepared.blocked_off > 0 && prepared.blocked == 0 {
                        Some("appDataOff")
                    } else if total_blocked > 0 {
                        Some("appDataDenied")
                    } else {
                        None
                    };
                    let _ = window.emit(
                        "lab-drop",
                        json!({
                            "paths": prepared.accepted,
                            "blocked": total_blocked,
                            "blockedReason": blocked_reason,
                            "x": position.x / scale,
                            "y": position.y / scale
                        }),
                    );
                }
                let _ = window.emit("lab-hover", json!({"active":false,"x":0,"y":0}));
            }
            tauri::DragDropEvent::Leave => {
                s.valid_drag.store(false, Ordering::Relaxed);
                let _ = window.emit("lab-hover", json!({"active":false,"x":0,"y":0}));
            }
            _ => {}
        }
    }
}

#[cfg(test)]
mod metadata_tests {
    use super::*;
    #[test]
    fn folder_with_pdf_suffix_is_still_a_directory() {
        let d = tempfile::tempdir().unwrap();
        let folder = d.path().join("folder.pdf");
        std::fs::create_dir(&folder).unwrap();
        let info = lab_describe(vec![folder.to_string_lossy().into()]);
        assert_eq!(info[0]["isDirectory"], true);
        assert_eq!(info[0]["exists"], true);
        assert_eq!(info[0]["size"], Value::Null);
    }
    #[test]
    fn files_report_their_size_and_missing_ones_none() {
        let d = tempfile::tempdir().unwrap();
        let file = d.path().join("note.txt");
        std::fs::write(&file, b"12345").unwrap();
        let gone = d.path().join("gone.txt");
        let info = lab_describe(vec![
            file.to_string_lossy().into(),
            gone.to_string_lossy().into(),
        ]);
        assert_eq!(info[0]["size"], 5);
        assert_eq!(info[1]["exists"], false);
        assert_eq!(info[1]["size"], Value::Null);
    }
}
