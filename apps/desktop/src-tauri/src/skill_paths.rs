// Resolve files shipped with this installation and the inbox this process watches.
use crate::library;
use crate::locale::t;
use crate::State;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};

include!(concat!(env!("OUT_DIR"), "/bundled_skills.rs"));

const INTEGRITY_FILE: &str = ".integrity.json";

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SkillPaths {
    manifest: PathBuf,
    data_root: PathBuf,
    inbox: PathBuf,
}

#[derive(Serialize, Deserialize)]
struct IntegrityManifest {
    version: u32,
    files: BTreeMap<String, String>,
}

fn factory_files_for(name: &str) -> Vec<(&'static str, &'static [u8])> {
    let prefix = format!("{name}/");
    FACTORY_SKILLS
        .iter()
        .copied()
        .filter(|(rel, _)| rel.starts_with(&prefix))
        .collect()
}

fn set_readonly(path: &Path, readonly: bool) {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if meta.file_type().is_symlink() {
            return;
        }
        let mut perms = meta.permissions();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = perms.mode();
            perms.set_mode(if readonly { mode & !0o222 } else { mode | 0o200 });
            let _ = fs::set_permissions(path, perms);
        }
        #[cfg(not(unix))]
        {
            perms.set_readonly(readonly);
            let _ = fs::set_permissions(path, perms);
        }
    }
}

fn make_tree_writable(path: &Path) {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return;
    };
    if meta.file_type().is_symlink() {
        return;
    }
    set_readonly(path, false);
    if meta.is_dir() {
        if let Ok(entries) = fs::read_dir(path) {
            for entry in entries.flatten() {
                make_tree_writable(&entry.path());
            }
        }
    }
}

fn collect_skill_files(
    skills_dir: &Path,
    dir: &Path,
    out: &mut BTreeSet<String>,
) -> Result<(), String> {
    let entries = fs::read_dir(dir).map_err(|_| t("host.skillTampered").to_owned())?;
    for entry in entries {
        let entry = entry.map_err(|_| t("host.skillTampered").to_owned())?;
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            return Err(t("host.skillTampered").into());
        };
        if name_str == "__pycache__" || name_str == ".DS_Store" || name_str.ends_with(".pyc") {
            continue;
        }
        let path = entry.path();
        let meta = fs::symlink_metadata(&path).map_err(|_| t("host.skillTampered").to_owned())?;
        if meta.file_type().is_symlink() {
            return Err(t("host.skillTampered").into());
        }
        if meta.is_dir() {
            collect_skill_files(skills_dir, &path, out)?;
        } else if meta.is_file() {
            let rel = path
                .strip_prefix(skills_dir)
                .map_err(|_| t("host.skillTampered").to_owned())?;
            let posix = rel
                .components()
                .map(|c| c.as_os_str().to_string_lossy().into_owned())
                .collect::<Vec<_>>()
                .join("/");
            out.insert(posix);
        } else {
            return Err(t("host.skillTampered").into());
        }
    }
    Ok(())
}

fn matches_factory(skills_dir: &Path, name: &str, expected: &[(&str, &[u8])]) -> bool {
    let target_dir = skills_dir.join(name);
    let Ok(dir_meta) = fs::symlink_metadata(&target_dir) else {
        return false;
    };
    if dir_meta.file_type().is_symlink() || !dir_meta.is_dir() {
        return false;
    }
    for (rel, bytes) in expected {
        let full = skills_dir.join(rel);
        let Ok(meta) = fs::symlink_metadata(&full) else {
            return false;
        };
        if meta.file_type().is_symlink() || !meta.is_file() {
            return false;
        }
        let Ok(actual) = fs::read(&full) else {
            return false;
        };
        if actual != *bytes {
            return false;
        }
    }
    let mut actual_files = BTreeSet::new();
    if collect_skill_files(skills_dir, &target_dir, &mut actual_files).is_err() {
        return false;
    }
    let expected_keys: BTreeSet<String> = expected.iter().map(|(k, _)| (*k).to_owned()).collect();
    actual_files == expected_keys
}

fn restore_skill_dir(
    skills_dir: &Path,
    name: &str,
    expected: &[(&str, &[u8])],
) -> Result<(), String> {
    fs::create_dir_all(skills_dir).map_err(|e| e.to_string())?;
    let target_dir = skills_dir.join(name);
    if let Ok(meta) = fs::symlink_metadata(&target_dir) {
        if meta.file_type().is_symlink() || meta.is_file() {
            set_readonly(&target_dir, false);
            fs::remove_file(&target_dir).map_err(|e| e.to_string())?;
        } else {
            make_tree_writable(&target_dir);
            fs::remove_dir_all(&target_dir).map_err(|e| e.to_string())?;
        }
    }
    for (rel, bytes) in expected {
        let full = skills_dir.join(rel);
        if let Some(parent) = full.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&full, bytes).map_err(|e| e.to_string())?;
        #[cfg(unix)]
        set_readonly(&full, true);
    }
    // Keep .integrity.json in sync if present.
    let integrity_path = skills_dir.join(INTEGRITY_FILE);
    if integrity_path.is_file() && !integrity_path.is_symlink() {
        set_readonly(&integrity_path, false);
        let mut manifest = fs::read(&integrity_path)
            .ok()
            .and_then(|raw| serde_json::from_slice::<IntegrityManifest>(&raw).ok())
            .filter(|m| m.version == 1)
            .unwrap_or_else(|| IntegrityManifest {
                version: 1,
                files: BTreeMap::new(),
            });
        let prefix = format!("{name}/");
        manifest.files.retain(|k, _| !k.starts_with(&prefix));
        for (rel, bytes) in expected {
            manifest
                .files
                .insert((*rel).to_owned(), format!("{:x}", Sha256::digest(bytes)));
        }
        if let Ok(json) = serde_json::to_string_pretty(&manifest) {
            let _ = fs::write(&integrity_path, format!("{json}\n"));
        }
        #[cfg(unix)]
        set_readonly(&integrity_path, true);
    }
    if matches_factory(skills_dir, name, expected) {
        Ok(())
    } else {
        Err(t("host.skillTampered").into())
    }
}

fn verify_integrity(skills_dir: &Path, name: &str) -> Result<(), String> {
    let manifest_path = skills_dir.join(INTEGRITY_FILE);
    let Ok(meta) = fs::symlink_metadata(&manifest_path) else {
        return Ok(());
    };
    if meta.file_type().is_symlink() || !meta.is_file() {
        return Err(t("host.skillTampered").into());
    }
    let raw = fs::read(&manifest_path).map_err(|_| t("host.skillTampered").to_owned())?;
    let parsed: IntegrityManifest =
        serde_json::from_slice(&raw).map_err(|_| t("host.skillTampered").to_owned())?;
    if parsed.version != 1 {
        return Err(t("host.skillTampered").into());
    }
    let prefix = format!("{name}/");
    let expected: BTreeMap<String, String> = parsed
        .files
        .into_iter()
        .filter(|(k, _)| k.starts_with(&prefix))
        .collect();
    if !expected.contains_key(&format!("{name}/SKILL.md")) {
        return Err(t("host.skillTampered").into());
    }
    for (rel, digest) in &expected {
        if library::relative(rel).is_err() {
            return Err(t("host.skillTampered").into());
        }
        let full = skills_dir.join(rel);
        let file_meta =
            fs::symlink_metadata(&full).map_err(|_| t("host.skillTampered").to_owned())?;
        if file_meta.file_type().is_symlink() || !file_meta.is_file() {
            return Err(t("host.skillTampered").into());
        }
        let bytes = fs::read(&full).map_err(|_| t("host.skillTampered").to_owned())?;
        let actual = format!("{:x}", Sha256::digest(&bytes));
        if actual != *digest {
            return Err(t("host.skillTampered").into());
        }
    }
    let mut actual_files = BTreeSet::new();
    collect_skill_files(skills_dir, &skills_dir.join(name), &mut actual_files)?;
    let expected_keys: BTreeSet<String> = expected.keys().cloned().collect();
    if actual_files != expected_keys {
        return Err(t("host.skillTampered").into());
    }
    Ok(())
}

fn locate(resources: &Path, data_root: &Path, name: &str) -> Result<SkillPaths, String> {
    if name.is_empty()
        || !name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(t("host.skillName").into());
    }
    let skills_dir = resources.join("skills");
    let factory = factory_files_for(name);
    if !factory.is_empty() {
        if matches_factory(&skills_dir, name, &factory) {
            return Ok(SkillPaths {
                manifest: skills_dir.join(name).join("SKILL.md"),
                data_root: data_root.to_owned(),
                inbox: data_root.join("inbox"),
            });
        }
        // Auto-heal modified or damaged bundled skills back to factory state.
        if restore_skill_dir(&skills_dir, name, &factory).is_ok() {
            return Ok(SkillPaths {
                manifest: skills_dir.join(name).join("SKILL.md"),
                data_root: data_root.to_owned(),
                inbox: data_root.join("inbox"),
            });
        }
        // If the app install folder is read-only (e.g. /Applications), restore a clean copy in data_root.
        let fallback_skills = data_root.join("skills-factory");
        if !matches_factory(&fallback_skills, name, &factory) {
            restore_skill_dir(&fallback_skills, name, &factory)
                .map_err(|_| t("host.skillTampered").to_owned())?;
        }
        return Ok(SkillPaths {
            manifest: fallback_skills.join(name).join("SKILL.md"),
            data_root: data_root.to_owned(),
            inbox: data_root.join("inbox"),
        });
    }
    let manifest = skills_dir.join(name).join("SKILL.md");
    if !manifest.is_file() {
        return Err(t("host.skillMissing").into());
    }
    verify_integrity(&skills_dir, name)?;
    Ok(SkillPaths {
        manifest,
        data_root: data_root.to_owned(),
        inbox: data_root.join("inbox"),
    })
}

#[tauri::command]
pub fn bundled_skill_paths(
    app: AppHandle,
    state: tauri::State<State>,
    name: String,
) -> Result<SkillPaths, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|_| t("host.installMissing"))?;
    locate(&resources, &state.root, &name)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn future_skill_and_active_inbox_are_resolved_without_installing_anything() {
        let tmp = tempfile::tempdir().unwrap();
        let resources = tmp.path().join("随伴 Resources");
        let folder = resources.join("skills/future-tool");
        std::fs::create_dir_all(&folder).unwrap();
        std::fs::write(folder.join("SKILL.md"), "fixture").unwrap();
        for profile in ["app.sidekin.desktop", "app.sidekin.desktop.trial"] {
            let data = tmp.path().join(profile);
            let paths = locate(&resources, &data, "future-tool").unwrap();
            assert_eq!(paths.manifest, folder.join("SKILL.md"));
            assert_eq!(paths.data_root, data);
            assert_eq!(paths.inbox, data.join("inbox"));
        }
        for name in ["missing", "../future-tool", "C:\\elsewhere"] {
            assert!(locate(&resources, tmp.path(), name).is_err());
        }
    }

    #[test]
    fn bundled_skill_auto_restores_from_factory_backup_on_tampering() {
        let tmp = tempfile::tempdir().unwrap();
        let resources = tmp.path().join("Resources");
        let data = tmp.path().join("data");
        let skills = resources.join("skills");
        let folder = skills.join("make-desktop-pet");
        fs::create_dir_all(folder.join("scripts")).unwrap();
        // Corrupt SKILL.md and inject a rogue file.
        fs::write(folder.join("SKILL.md"), b"hacked by agent").unwrap();
        fs::write(folder.join("rogue.py"), b"evil").unwrap();
        let paths = locate(&resources, &data, "make-desktop-pet").unwrap();
        assert_eq!(paths.manifest, folder.join("SKILL.md"));
        assert!(!folder.join("rogue.py").exists());
        let expected_md = factory_files_for("make-desktop-pet")
            .into_iter()
            .find(|(k, _)| *k == "make-desktop-pet/SKILL.md")
            .unwrap()
            .1;
        assert_eq!(fs::read(&paths.manifest).unwrap(), expected_md);
        assert!(folder.join("scripts/deliver.py").is_file());
    }

    #[cfg(unix)]
    #[test]
    fn readonly_install_falls_back_to_factory_copy_in_data_root() {
        let tmp = tempfile::tempdir().unwrap();
        let resources = tmp.path().join("Resources");
        let data = tmp.path().join("data");
        let skills = resources.join("skills");
        let folder = skills.join("find-pet-tool");
        fs::create_dir_all(&folder).unwrap();
        fs::write(folder.join("SKILL.md"), b"tampered").unwrap();
        // Simulate a non-writable app bundle under /Applications.
        set_readonly(&folder.join("SKILL.md"), true);
        set_readonly(&folder, true);
        set_readonly(&skills, true);
        let paths = locate(&resources, &data, "find-pet-tool").unwrap();
        assert_eq!(
            paths.manifest,
            data.join("skills-factory/find-pet-tool/SKILL.md")
        );
        let expected_md = factory_files_for("find-pet-tool")
            .into_iter()
            .find(|(k, _)| *k == "find-pet-tool/SKILL.md")
            .unwrap()
            .1;
        assert_eq!(fs::read(&paths.manifest).unwrap(), expected_md);
        // Clean up readonly bits so tempdir removal succeeds.
        set_readonly(&skills, false);
        set_readonly(&folder, false);
        set_readonly(&folder.join("SKILL.md"), false);
    }

    #[test]
    fn custom_sealed_skill_passes_and_tampering_is_blocked() {
        let tmp = tempfile::tempdir().unwrap();
        let resources = tmp.path().join("Resources");
        let skills = resources.join("skills");
        let folder = skills.join("future-tool");
        fs::create_dir_all(folder.join("scripts")).unwrap();
        let skill_md = b"# Original skill\n";
        let script = b"print('ok')\n";
        fs::write(folder.join("SKILL.md"), skill_md).unwrap();
        fs::write(folder.join("scripts/run.py"), script).unwrap();
        let digest = |b: &[u8]| format!("{:x}", Sha256::digest(b));
        let manifest = serde_json::json!({
            "version": 1,
            "files": {
                "future-tool/SKILL.md": digest(skill_md),
                "future-tool/scripts/run.py": digest(script),
            }
        });
        fs::write(skills.join(INTEGRITY_FILE), manifest.to_string()).unwrap();
        assert!(locate(&resources, tmp.path(), "future-tool").is_ok());

        fs::write(folder.join("rogue.py"), b"evil").unwrap();
        let err = locate(&resources, tmp.path(), "future-tool").err().unwrap();
        assert_eq!(err, t("host.skillTampered"));
        fs::remove_file(folder.join("rogue.py")).unwrap();

        fs::write(folder.join("scripts/run.py"), b"print('hacked')\n").unwrap();
        let err = locate(&resources, tmp.path(), "future-tool").err().unwrap();
        assert_eq!(err, t("host.skillTampered"));
        fs::write(folder.join("scripts/run.py"), script).unwrap();

        fs::write(skills.join(INTEGRITY_FILE), "{bad json").unwrap();
        let err = locate(&resources, tmp.path(), "future-tool").err().unwrap();
        assert_eq!(err, t("host.skillTampered"));
    }
}
