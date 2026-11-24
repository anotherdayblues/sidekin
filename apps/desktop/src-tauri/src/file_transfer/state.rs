use super::layout::Rect;
use serde_json::{json, Value};
use std::{
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, AtomicU32, Ordering},
        Mutex,
    },
};
pub struct Lab {
    pub root: PathBuf,
    pub view: Mutex<Value>,
    pub regions: Mutex<Vec<Rect>>,
    pub outgoing: AtomicBool,
    pub pet_pressed: AtomicBool,
    pub valid_drag: AtomicBool,
    pub size: AtomicU32,
    pub shape: Mutex<Rect>,
    pub hits: Mutex<Vec<Rect>>,
    pub anchor: Mutex<Option<(f64, f64)>>,
    pub overlays: Mutex<Vec<Rect>>,
    /// The pet page says whether the cursor is near it; far away, the
    /// tracker sends the cursor less often.
    pub cursor_near: AtomicBool,
    /// The file panel is open (piles.ts): a click anywhere else closes it,
    /// so the pointer is read quickly then.
    pub panel_open: AtomicBool,
}
impl Lab {
    pub fn open(root: PathBuf) -> Self {
        let _ = std::fs::create_dir_all(&root);
        let mut view: Value = std::fs::read(root.join("files.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| json!({"state":{"items":[],"lastRemoved":[]},"positions":{}}));
        if view["layoutVersion"].as_u64().unwrap_or(1) < 2 {
            let backup = root.join("files.layout-v1.backup.json");
            if !backup.exists() && root.join("files.json").exists() {
                let _ = std::fs::copy(root.join("files.json"), backup);
            }
            if let Some(positions) = view["positions"].as_object_mut() {
                for p in positions.values_mut() {
                    let x = p["x"].as_f64().unwrap_or(380.) - super::layout::OFFSET_X;
                    let y = p["y"].as_f64().unwrap_or(90.) - super::layout::OFFSET_Y;
                    *p = json!({"x":x,"y":y});
                }
            }
            view["layoutVersion"] = json!(2);
            if let Ok(bytes) = serde_json::to_vec(&view) {
                let _ = std::fs::write(root.join("files.json"), bytes);
            }
        }
        let body = serde_json::from_value::<Rect>(view["petBody"].clone())
            .ok()
            .filter(|r| {
                r.width > 0.
                    && r.height > 0.
                    && r.x >= 0.
                    && r.y >= 0.
                    && r.x + r.width <= 1.01
                    && r.y + r.height <= 1.01
            })
            .unwrap_or(Rect {
                x: 0.,
                y: 0.,
                width: 1.,
                height: 1.,
            });
        Self {
            root,
            view: Mutex::new(view),
            regions: Mutex::new(vec![]),
            outgoing: AtomicBool::new(false),
            pet_pressed: AtomicBool::new(false),
            valid_drag: AtomicBool::new(false),
            size: AtomicU32::new(192),
            shape: Mutex::new(body),
            hits: Mutex::new(vec![]),
            anchor: Mutex::new(None),
            overlays: Mutex::new(vec![]),
            cursor_near: AtomicBool::new(true),
            panel_open: AtomicBool::new(false),
        }
    }
    pub fn count(&self) -> usize {
        self.view.lock().unwrap()["state"]["items"]
            .as_array()
            .map_or(0, |v| v.len())
    }
    pub fn save(&self, mut view: Value) -> Result<(), String> {
        view["positions"] = super::layout::attachments(
            &view,
            self.size.load(Ordering::Relaxed) as f64,
            *self.shape.lock().unwrap(),
        );
        view["layoutVersion"] = json!(4);
        view["petBody"] = json!(*self.shape.lock().unwrap());
        let bytes = serde_json::to_vec(&view).map_err(|e| e.to_string())?;
        // Write aside, then swap in, so a crash mid-write cannot leave a
        // half-written list. rename replaces the target on Windows too.
        let tmp = self.root.join("files.next.json");
        std::fs::write(&tmp, bytes).map_err(|e| e.to_string())?;
        std::fs::rename(&tmp, self.root.join("files.json")).map_err(|e| e.to_string())?;
        *self.view.lock().unwrap() = view;
        Ok(())
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn clearing_persisted_references_preserves_original_files() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../runs")
            .join(format!("state-test-{stamp}"));
        std::fs::create_dir_all(&root).unwrap();
        let original = root.join("original.txt");
        std::fs::write(&original, b"test file stays unchanged").unwrap();
        let lab = Lab::open(root.clone());
        lab.save(json!({"state":{"items":[{"id":"a","paths":[original]}]},"positions":{}}))
            .unwrap();
        assert_eq!(Lab::open(root.clone()).count(), 1);
        assert!(
            !root.join("files.next.json").exists(),
            "the temporary list is swapped in, not left behind"
        );
        lab.save(json!({"state":{"items":[]},"positions":{}}))
            .unwrap();
        assert_eq!(Lab::open(root).count(), 0);
        assert_eq!(
            std::fs::read(original).unwrap(),
            b"test file stays unchanged"
        );
    }
    #[test]
    fn legacy_positions_are_migrated_once_with_metadata_backup() {
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../runs")
            .join(format!("migration-test-{stamp}"));
        std::fs::create_dir_all(&root).unwrap();
        let legacy = json!({"state":{"items":[{"id":"a","paths":["fixture.txt"]}]},"positions":{"a":{"x":380,"y":90}}});
        std::fs::write(
            root.join("files.json"),
            serde_json::to_vec(&legacy).unwrap(),
        )
        .unwrap();
        let lab = Lab::open(root.clone());
        assert_eq!(
            lab.view.lock().unwrap()["positions"]["a"],
            json!({"x":204.,"y":-20.})
        );
        assert_eq!(
            Lab::open(root.clone()).view.lock().unwrap()["positions"]["a"],
            json!({"x":204.,"y":-20.})
        );
        let backup: Value = serde_json::from_slice(
            &std::fs::read(root.join("files.layout-v1.backup.json")).unwrap(),
        )
        .unwrap();
        assert_eq!(backup, legacy);
    }
}
