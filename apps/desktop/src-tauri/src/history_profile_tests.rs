use super::*;
use serde_json::{json, Value};

#[test]
fn next_message_refreshes_manual_profile_and_personality_only() {
    let d = tempfile::tempdir().unwrap();
    let root = d.path();
    let (a, _) = begin(root, "cat", "第一句", 1).unwrap();
    crate::memory::save_profile(root, "cat", "旧资料".into()).unwrap();
    let old = json!({"profile":crate::memory::read(root,"cat").unwrap().profile, "personality":"旧性格", "user":"旧记忆", "notes":"旧笔记"});
    snapshot(root, a, &old.to_string()).unwrap();
    crate::persona::save(root, "cat", Some("新性格".into())).unwrap();
    crate::memory::save_profile(root, "dog", "新资料".into()).unwrap();
    let new = json!({"profile":crate::memory::read(root,"cat").unwrap().profile, "personality":crate::persona::get(root,"cat","").unwrap(), "user":"新记忆", "notes":"新笔记"});
    let (b, _) = begin(root, "cat", "下一句", 2).unwrap();
    let frozen: Value =
        serde_json::from_str(&snapshot(root, b, &new.to_string()).unwrap()).unwrap();
    assert_eq!(frozen["profile"], "新资料");
    assert_eq!(frozen["personality"], "新性格");
    assert_eq!(frozen["user"], "旧记忆");
    assert_eq!(frozen["notes"], "旧笔记");
    close(root, "cat").unwrap();
    let (c, _) = begin(root, "cat", "新话题", 3).unwrap();
    let frozen: Value =
        serde_json::from_str(&snapshot(root, c, &new.to_string()).unwrap()).unwrap();
    assert_eq!(frozen["user"], "新记忆");
}

#[test]
fn old_topic_does_not_keep_a_second_stale_copy_of_migrated_profile() {
    let d = tempfile::tempdir().unwrap();
    let (a, _) = begin(d.path(), "cat", "旧版对话", 1).unwrap();
    snapshot(d.path(), a, &json!({"personality":"旧性格", "user":"- （用户写的）旧称呼\n旧资料第二行\n- （你记的）喜欢茶\n- （用户写的）旧地址", "notes":"旧笔记"}).to_string()).unwrap();
    let (b, _) = begin(d.path(), "cat", "更新后下一句", 2).unwrap();
    let current = json!({"profile":"新称呼\n新地址", "personality":"新性格", "user":"- （你记的）新记忆", "notes":"新笔记"});
    let frozen: Value =
        serde_json::from_str(&snapshot(d.path(), b, &current.to_string()).unwrap()).unwrap();
    assert_eq!(frozen["user"], "- （你记的）喜欢茶");
    assert_eq!(frozen["profile"], "新称呼\n新地址");
    assert_eq!(frozen["notes"], "旧笔记");
}
