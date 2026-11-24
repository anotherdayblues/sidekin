// The trial is a real desktop app, with its own macOS identity and storage.
#[cfg(all(feature = "trial", feature = "acceptance"))]
compile_error!("试玩版与自动验收版必须分别构建");
#[cfg(all(
    feature = "file-transfer-lab",
    any(feature = "trial", feature = "acceptance")
))]
compile_error!("文件中转集成小样使用独立构建配置");

use std::path::Path;
pub const TRIAL_ID: &str = "app.sidekin.desktop.trial";
pub const FILE_LAB_ID: &str = "app.sidekin.desktop";
pub const MODEL_KEYS: &str = if cfg!(feature = "file-transfer-lab") {
    "app.sidekin.desktop.models"
} else if cfg!(feature = "trial") {
    "app.sidekin.desktop.trial.models"
} else {
    "app.sidekin.desktop.models"
};
pub const PROBE_KEYS: &str = if cfg!(feature = "file-transfer-lab") {
    "app.sidekin.desktop.probe"
} else if cfg!(feature = "trial") {
    "app.sidekin.desktop.trial.probe"
} else {
    "app.sidekin.desktop.probe"
};

#[cfg(all(test, feature = "file-transfer-lab"))]
mod file_lab_isolation_tests {
    use super::*;
    #[test]
    fn full_app_uses_separate_identity_data_and_secret_services() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(FILE_LAB_ID);
        check(FILE_LAB_ID, &root).unwrap();
        assert!(check("studio.pet.companion", &root).is_err());
        assert!(check(FILE_LAB_ID, &dir.path().join("studio.pet.companion")).is_err());
        assert_ne!(MODEL_KEYS, "studio.pet.companion.models");
        assert_ne!(PROBE_KEYS, "studio.pet.companion.stage0");
    }
}

// Check the build profile before creating directories or starting migration.
pub fn check(id: &str, root: &Path) -> Result<(), String> {
    if cfg!(feature = "file-transfer-lab") != (id == FILE_LAB_ID) {
        return Err("文件中转集成小样的应用标识不符".into());
    }
    if cfg!(feature = "trial") != (id == TRIAL_ID) {
        return Err("应用标识与试玩构建配置不符".into());
    }
    if id == TRIAL_ID || id == FILE_LAB_ID {
        if root.file_name() != Some(std::ffi::OsStr::new(id)) {
            return Err("试玩数据路径不属于试玩版".into());
        }
        for p in [
            root.to_owned(),
            root.join("pets"),
            root.join("settings.json"),
            root.join("brain"),
            root.join("library"),
            root.join("inbox"),
        ] {
            match std::fs::symlink_metadata(p) {
                Ok(m) if m.is_symlink() => return Err("试玩数据目录不能指向另一份数据".into()),
                Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.to_string()),
                _ => {}
            }
        }
    }
    Ok(())
}

// First run: start with the example pet on the desktop.
#[cfg(not(feature = "acceptance"))]
pub fn seed_first_run(root: &Path) -> Result<(), String> {
    let settings = root.join("settings.json");
    if settings.try_exists().map_err(|e| e.to_string())? {
        return Ok(());
    }
    let pets = crate::library::list(root)?;
    let id = match pets.first() {
        Some(p) => p.id.clone(),
        None => crate::store_example(root)?.pet.id,
    };
    crate::library::write_json(
        &settings,
        &crate::Settings {
            active_id: Some(id),
            visible: true,
            ..Default::default()
        },
    )
}

#[cfg(all(test, feature = "trial"))]
mod tests {
    use super::*;
    #[test]
    fn isolated_seed_preserves_subsequent_choices() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join(TRIAL_ID);
        assert!(check("studio.pet.companion", &root).is_err());
        assert!(check(TRIAL_ID, &dir.path().join("studio.pet.companion")).is_err());
        check(TRIAL_ID, &root).unwrap();
        std::fs::create_dir_all(root.join("pets")).unwrap();
        seed_first_run(&root).unwrap();
        let s: crate::Settings =
            serde_json::from_slice(&std::fs::read(root.join("settings.json")).unwrap()).unwrap();
        assert_eq!(s.active_id.as_deref(), Some("lizi"));
        assert!(s.visible);
        crate::library::write_json(&root.join("settings.json"), &crate::Settings::default())
            .unwrap();
        seed_first_run(&root).unwrap();
        let s: crate::Settings =
            serde_json::from_slice(&std::fs::read(root.join("settings.json")).unwrap()).unwrap();
        assert!(s.active_id.is_none());
        assert_ne!(MODEL_KEYS, "studio.pet.companion.models");
        assert_ne!(PROBE_KEYS, "studio.pet.companion.stage0");
        #[cfg(unix)]
        {
            let alias = dir.path().join("other");
            std::fs::create_dir(&alias).unwrap();
            std::os::unix::fs::symlink(&alias, root.join("brain")).unwrap();
            assert!(check(TRIAL_ID, &root).is_err());
        }
    }
}
