use super::*;
use serde_json::json;
fn setup() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    library::import(
        root.path(),
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/lizi"),
    )
    .unwrap();
    root
}
fn strip(frames: usize, color: u8) -> Vec<u8> {
    let mut im = image::RgbaImage::new(192 * frames as u32, 208);
    for n in 0..frames {
        for x in 70..105 {
            for y in 85..175 {
                im.put_pixel(n as u32 * 192 + x, y, image::Rgba([color, 120, 60, 255]));
            }
        }
    }
    let mut out = std::io::Cursor::new(Vec::new());
    im.write_to(&mut out, image::ImageFormat::Png).unwrap();
    out.into_inner()
}
fn pending(root: &Path, names: &[&str]) -> String {
    let dir = root.join("delivery");
    fs::create_dir_all(dir.join("actions")).unwrap();
    let mut actions = serde_json::Map::new();
    for (i, n) in names.iter().enumerate() {
        fs::write(dir.join(format!("actions/{n}.png")), strip(3, 80 + i as u8)).unwrap();
        actions.insert(
            (*n).into(),
            json!({"label":n,"image":format!("actions/{n}.png"),"durations":[120,120,220]}),
        );
    }
    library::write_json(&dir.join("teaching.json"),&json!({"kind":"pet-teaching","schemaVersion":1,"petId":"lizi","summary":"未接受的动作","actions":actions})).unwrap();
    intake(root, &dir).unwrap().id
}
#[test]
fn pending_and_dismissed_actions_remain_available_and_selection_only_changes_one_action() {
    let root = setup();
    let id = pending(root.path(), &["dance"]);
    let before = list(root.path(), "lizi").unwrap();
    let dance = before.iter().find(|a| a.name == "dance").unwrap().clone();
    assert!(!dance.used && !dance.current);
    assert!(layer(root.path(), "lizi").unwrap().actions.is_empty());
    discard(root.path(), &id).unwrap();
    assert!(drafts(root.path()).is_empty());
    select(root.path(), "lizi", &dance.id).unwrap();
    assert!(layer(root.path(), "lizi")
        .unwrap()
        .actions
        .contains_key("dance"));
    assert_eq!(list(root.path(), "lizi").unwrap().len(), before.len());
    assert!(delete(root.path(), "lizi", &dance.id).is_err());
}
#[test]
fn legacy_actions_migrate_and_hundreds_of_switches_create_no_snapshots_or_duplicate_images() {
    let root = setup();
    let dir = custom_dir(root.path(), "lizi");
    fs::create_dir_all(dir.join("assets")).unwrap();
    fs::create_dir_all(dir.join("versions")).unwrap();
    fs::write(dir.join("assets/wave.png"), strip(4, 100)).unwrap();
    let a = CustomAction {
        label: "旧挥手".into(),
        image: "assets/wave.png".into(),
        durations: vec![140, 140, 140, 280],
        loop_frames: None,
    };
    let mut old = Layer::default();
    old.actions.insert("waving".into(), a);
    old.rules.push(serde_json::from_value(json!({"id":"hello","label":"点一下挥手","when":{"type":"event","event":"click"},"do":[{"play":"waving"}]})).unwrap());
    library::write_json(&dir.join("versions/1.json"), &old).unwrap();
    library::write_json(
        &dir.join("history.json"),
        &History {
            current: 1,
            versions: vec![Version {
                version: 1,
                summary: "旧挥手".into(),
                accepted_at: 42,
            }],
        },
    )
    .unwrap();
    let backup = fs::read(dir.join("versions/1.json")).unwrap();
    let items = list(root.path(), "lizi").unwrap();
    let original = items
        .iter()
        .find(|a| a.name == "waving" && a.original)
        .unwrap()
        .id
        .clone();
    let changed = items
        .iter()
        .find(|a| a.name == "waving" && !a.original)
        .unwrap()
        .id
        .clone();
    let count = fs::read_dir(dir.join("assets")).unwrap().count();
    for _ in 0..200 {
        select(root.path(), "lizi", &original).unwrap();
        select(root.path(), "lizi", &changed).unwrap();
    }
    assert_eq!(list(root.path(), "lizi").unwrap().len(), items.len());
    assert_eq!(fs::read_dir(dir.join("versions")).unwrap().count(), 1);
    assert_eq!(fs::read_dir(dir.join("assets")).unwrap().count(), count);
    assert_eq!(fs::read(dir.join("versions/1.json")).unwrap(), backup);
    assert_eq!(layer(root.path(), "lizi").unwrap().rules.len(), 1);
    select(root.path(), "lizi", &original).unwrap();
    delete(root.path(), "lizi", &changed).unwrap();
    assert!(!list(root.path(), "lizi")
        .unwrap()
        .iter()
        .any(|i| i.id == changed));
}
#[test]
fn deleting_a_pending_candidate_keeps_other_candidates_and_the_active_action() {
    let root = setup();
    let _ = pending(root.path(), &["dance", "stretch"]);
    let items = list(root.path(), "lizi").unwrap();
    let dance = items.iter().find(|i| i.name == "dance").unwrap();
    let stretch = items.iter().find(|i| i.name == "stretch").unwrap();
    let file = image(root.path(), "lizi", &dance.id).unwrap();
    delete(root.path(), "lizi", &dance.id).unwrap();
    assert!(!file.exists());
    assert!(drafts(root.path()).is_empty());
    let next = list(root.path(), "lizi").unwrap();
    assert!(next.iter().any(|i| i.id == stretch.id));
    assert!(!next.iter().any(|i| i.id == dance.id));
    assert!(layer(root.path(), "lizi").unwrap().actions.is_empty());
}
#[test]
fn corrupt_legacy_or_collection_data_stops_without_overwriting_it() {
    let root = setup();
    let dir = custom_dir(root.path(), "lizi");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("history.json"), b"broken").unwrap();
    assert!(list(root.path(), "lizi").is_err());
    assert!(!path(root.path(), "lizi").exists());
    assert_eq!(fs::read(dir.join("history.json")).unwrap(), b"broken");
}

#[test]
fn deleting_one_saved_entry_does_not_remove_an_image_shared_by_another_entry() {
    let root = setup();
    pending(root.path(), &["dance"]);
    let item = list(root.path(), "lizi")
        .unwrap()
        .into_iter()
        .find(|i| i.name == "dance")
        .unwrap();
    let file = image(root.path(), "lizi", &item.id).unwrap();
    let mut c = load(root.path(), "lizi").unwrap();
    remember(
        root.path(),
        "lizi",
        &mut c,
        "other-dance",
        &item.action,
        &custom_dir(root.path(), "lizi"),
        "另一份",
        false,
        now(),
        false,
    )
    .unwrap();
    write(root.path(), "lizi", &c).unwrap();
    delete(root.path(), "lizi", &item.id).unwrap();
    assert!(file.exists());
    let other = list(root.path(), "lizi")
        .unwrap()
        .into_iter()
        .find(|i| i.name == "other-dance")
        .unwrap();
    delete(root.path(), "lizi", &other.id).unwrap();
    assert!(!file.exists());
}
