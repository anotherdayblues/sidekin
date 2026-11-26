//! A pet's name (plan/29): renamed by the user, 1–40 characters.
use super::*;

fn mika() -> std::path::PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/mika")
}

#[test]
fn names_are_trimmed_and_at_most_name_max_characters() {
    let root = tempfile::tempdir().unwrap();
    let p = import(root.path(), &mika()).unwrap().pet;
    assert_eq!(
        rename(root.path(), &p.id, " 栗子 ").unwrap().display_name,
        "栗子"
    );
    assert_eq!(pet(root.path(), &p.id).unwrap().display_name, "栗子");
    assert!(rename(root.path(), &p.id, "   ").is_err());
    assert!(rename(root.path(), &p.id, &"字".repeat(NAME_MAX + 1)).is_err());
    assert!(rename(root.path(), &p.id, &"字".repeat(NAME_MAX)).is_ok());
    assert!(rename(root.path(), "../x", "栗子").is_err());
}

#[test]
fn a_long_name_from_a_maker_is_cut_not_refused() {
    let p = parse(format!(r#"{{"id":"x","displayName":"{}"}}"#, "长".repeat(60)).as_bytes())
        .unwrap();
    assert_eq!(p.display_name.chars().count(), NAME_MAX);
}
