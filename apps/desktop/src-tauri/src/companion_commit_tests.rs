use super::*;
use std::cell::Cell;

#[test]
fn disk_is_updated_before_runtime_is_applied() {
    let dir = tempfile::tempdir().unwrap();
    let old = Settings::default();
    library::write_json(&dir.path().join("settings.json"), &old).unwrap();
    let next = Settings {
        model: "candidate".into(),
        ..old
    };
    commit_configuration(
        dir.path(),
        &next,
        || {
            let value: Value =
                serde_json::from_slice(&fs::read(dir.path().join("settings.json")).unwrap())
                    .unwrap();
            assert_eq!(value["model"], "candidate");
            Ok(())
        },
        || Ok(()),
    )
    .unwrap();
}

#[test]
fn failed_disk_write_does_not_touch_the_runtime() {
    let dir = tempfile::tempdir().unwrap();
    fs::create_dir(dir.path().join("settings.json")).unwrap();
    let touched = Cell::new(false);
    assert!(commit_configuration(
        dir.path(),
        &Settings::default(),
        || {
            touched.set(true);
            Ok(())
        },
        || Ok(())
    )
    .is_err());
    assert!(!touched.get());
}

#[test]
fn rejected_runtime_change_restores_the_previous_disk_config() {
    let dir = tempfile::tempdir().unwrap();
    let old = Settings::default();
    library::write_json(&dir.path().join("settings.json"), &old).unwrap();
    let next = Settings {
        model: "candidate".into(),
        ..old.clone()
    };
    assert!(commit_configuration(
        dir.path(),
        &next,
        || Err("fixture apply failure".into()),
        || Ok(())
    )
    .is_err());
    let value: Value =
        serde_json::from_slice(&fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(value["model"], old.model);
}
