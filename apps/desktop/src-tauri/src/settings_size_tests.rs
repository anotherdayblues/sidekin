use super::*;

#[test]
fn legacy_sizes_above_the_ui_limit_are_read_as_280() {
    for size in [281, 300, 320, u32::MAX] {
        let settings: Settings = serde_json::from_value(serde_json::json!({"size": size})).unwrap();
        assert_eq!(settings.size, 280);
        assert_eq!(serde_json::to_value(&settings).unwrap()["size"], 280);
    }
}

#[test]
fn supported_sizes_and_missing_size_keep_their_values() {
    for size in [80, 160, 280] {
        let settings: Settings = serde_json::from_value(serde_json::json!({"size": size})).unwrap();
        assert_eq!(settings.size, size);
    }
    assert_eq!(serde_json::from_str::<Settings>("{}").unwrap().size, 160);
}
