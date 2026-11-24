//! Fixed edit scope, original timing and optimistic version checks for replacement drafts.
use super::*;

pub(super) fn replaceable_base(name: &str) -> bool {
    let c: serde_json::Value = serde_json::from_str(CONTRACT).expect("teaching contract");
    c["replaceableBaseActions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n.as_str() == Some(name))
}
/// Base actions open to a redraw now (none for now, plan/29). Those that
/// once were may still be in a layer from an earlier redraw.
fn redrawable_base(name: &str) -> bool {
    let c: serde_json::Value = serde_json::from_str(CONTRACT).expect("teaching contract");
    c["redrawableBaseActions"]
        .as_array()
        .unwrap()
        .iter()
        .any(|n| n.as_str() == Some(name))
}
/// The timing a redraw must keep: the frame lengths and, for an ongoing
/// action, its loop. Base actions only when the contract opens them; sleep
/// stays as it is.
fn original_timing(name: &str, base: &Layer) -> Option<(Vec<u32>, Option<[usize; 2]>)> {
    if name == "sleep" {
        return None;
    }
    if !ACTIONS.contains(&name) {
        return base
            .actions
            .get(name)
            .map(|a| (a.durations.clone(), a.loop_frames));
    }
    if !redrawable_base(name) {
        return None;
    }
    if let Some(a) = base.actions.get(name) {
        return Some((a.durations.clone(), None));
    }
    let c: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../skills/make-desktop-pet/references/runtime-contract.json"
    ))
    .unwrap();
    Some((
        c["animations"][name]["durations"]
            .as_array()?
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect(),
        None,
    ))
}
pub(super) fn check_replacements(base: &Layer, t: &Teaching) -> Result<(), String> {
    for (name, a) in &t.actions {
        if ACTIONS.contains(&name.as_str()) && !t.replace_actions.contains(name) {
            return Err(crate::locale::t("host.replaceExplicit"));
        }
        if let Some(old) = base.actions.get(name) {
            let redraw = t.replace_actions.contains(name);
            if (name == "sleep" || (old.loop_frames.is_some() && !redraw)) && old != a {
                return Err(crate::locale::t("host.replaceProtected"));
            }
        }
    }
    if t.replace_actions.is_empty() {
        return Ok(());
    }
    if t.base_version.is_none()
        || !t.rules.is_empty()
        || !t.remove.actions.is_empty()
        || !t.remove.rules.is_empty()
        || t.replace_actions.len() != t.actions.len()
    {
        return Err(crate::locale::t("host.replaceOnly"));
    }
    let mut seen = std::collections::BTreeSet::new();
    for name in &t.replace_actions {
        if !seen.insert(name) {
            return Err(crate::locale::t("host.replaceOnly"));
        }
        let (durations, loop_frames) =
            original_timing(name, base).ok_or_else(|| crate::locale::t("host.replaceProtected"))?;
        let a = t
            .actions
            .get(name)
            .ok_or_else(|| crate::locale::t("host.replaceOnly"))?;
        if a.loop_frames != loop_frames || a.durations != durations {
            return Err(crate::locale::t("host.replaceTiming"));
        }
    }
    Ok(())
}
pub(super) fn check_source_version(root: &Path, t: &Teaching) -> Result<(), String> {
    if !t.replace_actions.is_empty() && t.base_version != Some(history(root, &t.pet_id)?.current) {
        return Err(crate::locale::t("host.replaceStale"));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn strip(path: &Path, frames: usize, shade: u8) {
        let mut img = image::RgbaImage::new(192 * frames as u32, 208);
        for i in 0..frames {
            img.put_pixel(i as u32 * 192 + 80, 120, image::Rgba([220, shade, 30, 255]));
        }
        img.save(path).unwrap();
    }
    /// mika, having learned 转圈 (once) and 看书 (ongoing), and a folder
    /// redrawing `name` with its original timing.
    fn fixture(name: &str) -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        library::import(
            root.path(),
            &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/mika"),
        )
        .unwrap();
        let learn = root.path().join("learn");
        fs::create_dir_all(learn.join("actions")).unwrap();
        strip(&learn.join("actions/spin.png"), 4, 80);
        strip(&learn.join("actions/read.png"), 6, 80);
        library::write_json(&learn.join("teaching.json"), &json!({"kind":"pet-teaching","schemaVersion":1,"petId":"mika","summary":"学转圈和看书",
            "actions":{"spin":{"label":"转圈","image":"actions/spin.png","durations":[100,100,100,200]},
                       "read":{"label":"看书","image":"actions/read.png","durations":[100,100,100,100,100,100],"loopFrames":[2,5]}},
            "rules":[{"id":"spin-random","label":"转圈","when":{"type":"random","weight":1},"do":[{"play":"spin"}]}]})).unwrap();
        let d = intake(root.path(), &learn).unwrap();
        accept(root.path(), &d.id).unwrap();
        let current = layer(root.path(), "mika").unwrap();
        let (durations, loop_frames) =
            original_timing(name, &current).unwrap_or((vec![100, 100, 100, 200], None));
        let dir = root.path().join("edit");
        fs::create_dir_all(dir.join("actions")).unwrap();
        strip(&dir.join("actions/edit.png"), durations.len(), 200);
        let mut action = json!({"label":"重画","image":"actions/edit.png","durations":durations});
        if let Some(l) = loop_frames {
            action["loopFrames"] = json!(l);
        }
        library::write_json(&dir.join("teaching.json"), &json!({"kind":"pet-teaching","schemaVersion":1,"petId":"mika","summary":"重画","baseVersion":1,"replaceActions":[name],"actions":{name:action}})).unwrap();
        (root, dir)
    }
    #[test]
    fn a_redraw_is_a_draft_until_accepted_and_the_old_one_is_kept() {
        let (root, dir) = fixture("spin");
        let sprite = root
            .path()
            .join("pets/mika")
            .join(library::pet(root.path(), "mika").unwrap().spritesheet_path);
        let before = fs::read(&sprite).unwrap();
        let old = layer(root.path(), "mika").unwrap().actions["spin"].clone();
        let d = intake(root.path(), &dir).unwrap();
        assert_eq!(layer(root.path(), "mika").unwrap().actions["spin"], old);
        accept(root.path(), &d.id).unwrap();
        let now = layer(root.path(), "mika").unwrap();
        assert_ne!(now.actions["spin"].image, old.image);
        // The schedule stays with the action.
        assert_eq!(now.rules.len(), 1);
        assert_eq!(fs::read(&sprite).unwrap(), before);
        let saved = archive::list(root.path(), "mika")
            .unwrap()
            .into_iter()
            .find(|i| i.name == "spin" && i.action.image == old.image);
        assert!(saved.is_some(), "the earlier drawing is kept");
    }
    #[test]
    fn an_ongoing_learned_action_can_be_redrawn_keeping_its_loop() {
        let (root, dir) = fixture("read");
        let d = intake(root.path(), &dir).unwrap();
        accept(root.path(), &d.id).unwrap();
        assert_eq!(
            layer(root.path(), "mika").unwrap().actions["read"].loop_frames,
            Some([2, 5])
        );
        let (root, dir) = fixture("read");
        let file = dir.join("teaching.json");
        let mut t: serde_json::Value = read_json(&file).unwrap();
        t["actions"]["read"]["loopFrames"] = json!([2, 4]);
        library::write_json(&file, &t).unwrap();
        assert!(intake(root.path(), &dir).is_err(), "the loop stays");
    }
    #[test]
    fn base_actions_sleep_and_timing_changes_are_rejected() {
        for name in [
            "idle",
            "running-left",
            "running-right",
            "running",
            "waving",
            "sleep",
            "look-up",
        ] {
            let (root, dir) = fixture(name);
            assert!(intake(root.path(), &dir).is_err(), "{name}");
        }
        let (root, dir) = fixture("spin");
        let file = dir.join("teaching.json");
        let mut t: serde_json::Value = read_json(&file).unwrap();
        t["actions"]["spin"]["durations"][0] = json!(500);
        library::write_json(&file, &t).unwrap();
        assert!(intake(root.path(), &dir).is_err());
        // A base action is never overridden by a plain teaching either.
        t["actions"] = json!({"running": t["actions"]["spin"].clone()});
        t["replaceActions"] = json!([]);
        library::write_json(&file, &t).unwrap();
        assert!(intake(root.path(), &dir).is_err());
    }
    #[test]
    fn a_stale_redraw_cannot_overwrite_a_newer_version() {
        let (root, dir) = fixture("spin");
        let d = intake(root.path(), &dir).unwrap();
        let mut newer = layer(root.path(), "mika").unwrap();
        newer.rules.clear();
        save_version(root.path(), "mika", &newer, "去掉随机".into()).unwrap();
        assert!(accept(root.path(), &d.id).is_err());
        let mut t: serde_json::Value = read_json(&dir.join("teaching.json")).unwrap();
        t["baseVersion"] = json!(2);
        library::write_json(&dir.join("teaching.json"), &t).unwrap();
        let d = intake(root.path(), &dir).unwrap();
        accept(root.path(), &d.id).unwrap();
        assert!(layer(root.path(), "mika").unwrap().rules.is_empty());
    }
}
