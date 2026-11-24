use super::*;
fn fixture() -> tempfile::TempDir {
    let root = tempfile::tempdir().unwrap();
    library::import(
        root.path(),
        &Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/mika"),
    )
    .unwrap();
    let mut pet = library::pet(root.path(), "mika").unwrap();
    pet.id = "fixture".into();
    library::write_json(&root.path().join("pets/mika/pet.json"), &pet).unwrap();
    fs::rename(
        root.path().join("pets/mika"),
        root.path().join("pets/fixture"),
    )
    .unwrap();
    root
}

#[test]
fn directory_metadata_alone_does_not_count_as_an_existing_version() {
    let root = fixture();
    let dir = custom_dir(root.path(), "fixture");
    fs::create_dir_all(dir.join("versions")).unwrap();
    fs::write(dir.join("versions/.DS_Store"), b"fixture-metadata").unwrap();
    assert_eq!(
        save_version(root.path(), "fixture", &Layer::default(), "new".into())
            .unwrap()
            .version,
        0
    );
}

#[test]
fn library_snapshot_reports_corrupt_history_instead_of_hiding_it() {
    let root = fixture();
    let dir = custom_dir(root.path(), "fixture");
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("history.json"), b"{broken").unwrap();
    let pet: library::Pet = serde_json::from_value(serde_json::json!({"id":"fixture","displayName":"fixture","spriteVersionNumber":2,"spritesheetPath":"unused.png"})).unwrap();
    assert!(crate::custom_layers(root.path(), &[pet]).is_err());
}

#[test]
fn corrupt_history_stops_without_replacing_an_existing_version() {
    let root = fixture();
    let dir = custom_dir(root.path(), "fixture");
    fs::create_dir_all(dir.join("versions")).unwrap();
    fs::write(dir.join("history.json"), b"{broken").unwrap();
    fs::write(dir.join("versions/1.json"), b"original-version").unwrap();
    assert!(save_version(root.path(), "fixture", &Layer::default(), "new".into()).is_err());
    assert_eq!(fs::read(dir.join("history.json")).unwrap(), b"{broken");
    assert_eq!(
        fs::read(dir.join("versions/1.json")).unwrap(),
        b"original-version"
    );
}

#[test]
fn missing_history_is_only_a_new_pet_when_no_versions_exist() {
    let root = fixture();
    let dir = custom_dir(root.path(), "fixture");
    fs::create_dir_all(dir.join("versions")).unwrap();
    fs::write(dir.join("versions/1.json"), b"original-version").unwrap();
    assert!(save_version(root.path(), "fixture", &Layer::default(), "new".into()).is_err());
    assert!(!dir.join("history.json").exists());
    assert_eq!(
        fs::read(dir.join("versions/1.json")).unwrap(),
        b"original-version"
    );
    assert_eq!(legacy_history(root.path(), "fresh").unwrap().current, 0);
}

#[test]
fn version_number_collision_never_overwrites_a_saved_version() {
    let root = fixture();
    let dir = custom_dir(root.path(), "fixture");
    fs::create_dir_all(dir.join("versions")).unwrap();
    library::write_json(&dir.join("history.json"), &History::default()).unwrap();
    fs::write(dir.join("versions/1.json"), b"original-version").unwrap();
    assert!(save_version(root.path(), "fixture", &Layer::default(), "new".into()).is_err());
    assert_eq!(
        fs::read(dir.join("versions/1.json")).unwrap(),
        b"original-version"
    );
}

#[test]
fn unreadable_history_is_not_an_empty_history() {
    let root = fixture();
    let dir = custom_dir(root.path(), "fixture");
    fs::create_dir_all(dir.join("history.json")).unwrap();
    assert!(save_version(root.path(), "fixture", &Layer::default(), "new".into()).is_err());
    assert!(!dir.join("versions/1.json").exists());
}
