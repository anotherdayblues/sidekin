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
        card("usage"),
    ];
    assert_eq!(
        known_cards(given),
        [card("memory"), card("today"), card("chats"), card("usage")]
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

#[test]
fn wardrobe_flip_and_activity_preferences_round_trip_and_omit_when_empty() {
    // Empty defaults omit new keys for clean v1.1.1 rollback compatibility
    let empty_json = serde_json::to_value(Settings::default()).unwrap();
    assert!(empty_json.get("petWardrobePreferences").is_none());
    assert!(empty_json.get("petHorizontalFlip").is_none());
    assert!(empty_json.get("petActivityPreferences").is_none());

    // Old v1.1.1 settings.json without the new fields deserializes cleanly
    let legacy: Settings = serde_json::from_str(r#"{"activeId":"lizi","size":160}"#).unwrap();
    assert!(legacy.pet_wardrobe_preferences.is_empty());
    assert!(legacy.pet_horizontal_flip.is_empty());
    assert!(legacy.pet_activity_preferences.is_empty());

    // Full round-trip persistence via State::update_settings
    let dir = tempfile::tempdir().unwrap();
    let state = State {
        root: dir.path().into(),
        settings: Mutex::new(Settings::default()),
    };
    state
        .update_settings(|s| {
            s.pet_wardrobe_preferences.insert(
                "hoodie-cat".into(),
                wardrobe::PetWardrobePreference {
                    outfit: Some("pajamas".into()),
                    schedule: None,
                },
            );
            s.pet_horizontal_flip.insert("hoodie-cat".into(), true);
            s.pet_activity_preferences
                .insert("hoodie-cat".into(), vec!["stretch".into()]);
        })
        .unwrap();

    let raw = std::fs::read(dir.path().join("settings.json")).unwrap();
    let disk: Settings = serde_json::from_slice(&raw).unwrap();
    assert_eq!(
        disk.pet_wardrobe_preferences
            .get("hoodie-cat")
            .and_then(|p| p.outfit.as_deref()),
        Some("pajamas")
    );
    assert_eq!(disk.pet_horizontal_flip.get("hoodie-cat"), Some(&true));
    assert_eq!(
        disk.pet_activity_preferences.get("hoodie-cat"),
        Some(&vec!["stretch".to_owned()])
    );
}
