use super::*;

#[test]
fn failed_save_keeps_the_previous_in_memory_settings() {
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir(dir.path().join("settings.json")).unwrap();
    let state = State {
        root: dir.path().into(),
        settings: Mutex::new(Settings::default()),
    };
    assert!(state
        .update_settings(|s| {
            s.size = 240;
            s.visible = true;
        })
        .is_err());
    let current = state.settings.lock().unwrap();
    assert_eq!(current.size, 160);
    assert!(!current.visible);
}

#[test]
fn successful_save_updates_disk_and_memory_together() {
    let dir = tempfile::tempdir().unwrap();
    let state = State {
        root: dir.path().into(),
        settings: Mutex::new(Settings::default()),
    };
    state.update_settings(|s| s.size = 240).unwrap();
    let disk: Settings =
        serde_json::from_slice(&std::fs::read(dir.path().join("settings.json")).unwrap()).unwrap();
    assert_eq!(disk.size, 240);
    assert_eq!(state.settings.lock().unwrap().size, disk.size);
}

#[test]
fn the_two_skins_are_kept_and_retired_or_unknown_ones_fall_back_to_native() {
    assert_eq!(known_skin("native"), "native");
    assert_eq!(known_skin("studio"), "studio");
    assert_eq!(known_skin("game"), "native");
    assert_eq!(known_skin("room"), "native");
    assert_eq!(known_skin("aqua"), "native");
}

#[test]
fn home_cards_keep_known_ones_once_in_order() {
    let card = |id: &str| HomeCard { id: id.into() };
    let given = vec![
        card("memory"),
        card("today"),
        card("weather"),
        card("memory"),
        card("chats"),
    ];
    assert_eq!(
        known_cards(given),
        [card("memory"), card("today"), card("chats")]
    );
    assert!(known_cards(vec![]).is_empty());
}

#[test]
fn settings_without_home_cards_read_as_never_changed() {
    let old: Settings = serde_json::from_str(r#"{"size":160,"skin":"studio"}"#).unwrap();
    assert!(old.home_cards.is_none());
    // Cards saved with a size by an earlier build still read, in order.
    let saved: Settings = serde_json::from_str(
        r#"{"homeCards":[{"id":"chats","size":"big"},{"id":"today","size":"small"}]}"#,
    )
    .unwrap();
    assert_eq!(
        saved.home_cards.unwrap(),
        [HomeCard { id: "chats".into() }, HomeCard { id: "today".into() }]
    );
}
