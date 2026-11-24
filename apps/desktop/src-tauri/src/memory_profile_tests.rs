use super::*;
use serde_json::{json, Value};

fn legacy(dir: &Path) {
    fs::create_dir_all(dir.join("memory")).unwrap();
    fs::write(
        dir.join("memory/notebooks.json"),
        json!({
            "user": ["喜欢茶", "我在上海", "喜欢散步", "我叫测试甲"],
            "notes": ["项目用 Rust"], "authored": ["我叫测试甲", "我在上海"]
        })
        .to_string(),
    )
    .unwrap();
}
fn ops(value: Value) -> Vec<Operation> {
    serde_json::from_value(value).unwrap()
}

#[test]
fn legacy_authored_entries_move_in_original_order_once() {
    let d = tempfile::tempdir().unwrap();
    legacy(d.path());
    let b = read(d.path(), "cat").unwrap();
    assert_eq!(view(&b)["profile"]["text"], "我在上海\n我叫测试甲");
    assert_eq!(b.user, ["喜欢茶", "喜欢散步"]);
    assert!(b.authored.is_empty());
    assert_eq!(read(d.path(), "dog").unwrap(), b);
    assert_eq!(b.notes, ["项目用 Rust"]);
}

#[test]
fn full_notebook_error_contains_all_current_entries_and_keeps_batch_atomic() {
    let d = tempfile::tempdir().unwrap();
    let entries = vec!["当前第一条".to_string(), "新".repeat(1992)];
    let before = apply(
        d.path(),
        "cat",
        &ops(json!([
            {"book":"user", "action":"add", "content":entries[0]},
            {"book":"user", "action":"add", "content":entries[1]}
        ])),
    )
    .unwrap();
    let error = apply(
        d.path(),
        "dog",
        &ops(json!([
            {"book":"notes", "action":"add", "content":"整批必须回滚"},
            {"book":"user", "action":"add", "content":"被拒绝的新条目"}
        ])),
    )
    .unwrap_err();
    for entry in &entries {
        assert!(
            error.contains(entry),
            "must include the complete live inventory"
        );
    }
    assert!(!error.contains("被拒绝的新条目"));
    assert_eq!(read(d.path(), "cat").unwrap(), before);
}

#[test]
fn migration_undo_survives_reload_and_keeps_later_pet_writes() {
    let d = tempfile::tempdir().unwrap();
    legacy(d.path());
    read(d.path(), "cat").unwrap();
    apply(
        d.path(),
        "dog",
        &ops(json!([
            {"book":"user","action":"add","content":"后来喜欢咖啡"},
            {"book":"notes","action":"add","content":"后来记下的经验"}
        ])),
    )
    .unwrap();
    let restored = profile_migration(d.path(), "dog", true).unwrap();
    assert_eq!(restored.profile, "");
    assert_eq!(
        restored.user,
        [
            "喜欢茶",
            "我在上海",
            "喜欢散步",
            "我叫测试甲",
            "后来喜欢咖啡"
        ]
    );
    assert_eq!(
        read(d.path(), "cat").unwrap(),
        restored,
        "undo must not automatically re-migrate"
    );
    assert_eq!(
        view(&restored)["user"]["entries"],
        json!(["喜欢茶", "喜欢散步", "后来喜欢咖啡"])
    );
    let migrated = profile_migration(d.path(), "cat", false).unwrap();
    assert_eq!(migrated.profile, "我在上海\n我叫测试甲");
    assert_eq!(migrated.notes, ["项目用 Rust", "后来记下的经验"]);
}

#[test]
fn profile_is_shared_bounded_and_not_a_memory_tool_target() {
    let d = tempfile::tempdir().unwrap();
    let text = "猫".repeat(2000);
    save_profile(d.path(), "cat", text.clone()).unwrap();
    assert_eq!(read(d.path(), "dog").unwrap().profile, text);
    assert!(save_profile(d.path(), "dog", "猫".repeat(2001)).is_err());
    assert!(serde_json::from_value::<Vec<Operation>>(
        json!([{"book":"profile","action":"add","content":"篡改"}])
    )
    .is_err());
    for action in ["patch", "remove"] {
        assert!(apply(
            d.path(),
            "dog",
            &ops(json!([{"book":"user","action":action,"old_text":text,"content":"篡改"}]))
        )
        .is_err());
    }
    let b = apply(
        d.path(),
        "dog",
        &ops(json!([{"book":"user","action":"add","content":"宠物记下的"}])),
    )
    .unwrap();
    assert_eq!(b.profile, text);
    let b = apply_as(d.path(), "cat", &ops(json!([{"book":"user","action":"patch","old_text":"宠物记下的","content":"用户修正条目"}])), true).unwrap();
    assert!(
        b.authored.is_empty(),
        "manual correction keeps the remembered entry's ownership"
    );
    assert_eq!(b.profile, text);
}

#[test]
fn changed_profile_blocks_destructive_undo_but_keeps_migration_backup() {
    let d = tempfile::tempdir().unwrap();
    legacy(d.path());
    save_profile(d.path(), "cat", "用户新写的资料".into()).unwrap();
    assert!(profile_migration(d.path(), "cat", true).is_err());
    let b = read(d.path(), "dog").unwrap();
    assert_eq!(b.profile, "用户新写的资料");
    assert_eq!(b.profile_migration.unwrap().entries.len(), 2);
}

#[test]
fn migration_at_old_limit_keeps_every_character_and_bad_files_stay_untouched() {
    let d = tempfile::tempdir().unwrap();
    let path = d.path().join("memory");
    fs::create_dir_all(&path).unwrap();
    let text = "🐈".repeat(2000);
    fs::write(
        path.join("notebooks.json"),
        json!({"user":[text],"authored":[text],"notes":[]}).to_string(),
    )
    .unwrap();
    assert_eq!(read(d.path(), "cat").unwrap().profile, text);
    fs::write(path.join("notebooks.json"), b"{broken").unwrap();
    assert!(read(d.path(), "cat").is_err());
    assert_eq!(fs::read(path.join("notebooks.json")).unwrap(), b"{broken");
}
