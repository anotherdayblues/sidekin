//! Publish a complete shared store by one rename. The legacy tree stays in place.
use crate::memory::Books;
use rusqlite::{Connection, OpenFlags, MAIN_DB};
use serde_json::{json, Value};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File},
    path::{Path, PathBuf},
    time::SystemTime,
};
type R<T> = Result<T, String>;
fn regular(path: &Path) -> R<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_file() => Ok(true),
        Ok(_) => Err(format!("需要普通文件：{}", path.display())),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
        Err(e) => Err(e.to_string()),
    }
}
fn database_copy(from: &Path, to: &Path) -> R<()> {
    let db = Connection::open_with_flags(from, OpenFlags::SQLITE_OPEN_READ_ONLY)
        .map_err(|e| e.to_string())?;
    db.backup(MAIN_DB, to, None).map_err(|e| e.to_string())?;
    let copy = Connection::open(to).map_err(|e| e.to_string())?;
    let ok: String = copy
        .query_row("PRAGMA integrity_check", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if ok != "ok" {
        return Err("SQLite 完整性检查失败".into());
    }
    Ok(())
}
fn backup(old: &Path) -> R<(PathBuf, Vec<(SystemTime, String, PathBuf)>)> {
    let staging = tempfile::Builder::new()
        .prefix(".backup-")
        .tempdir_in(old)
        .map_err(|e| e.to_string())?;
    let mut versions = Vec::new();
    for name in [
        "settings.json",
        "external.json",
        "history.sqlite3",
        "reminders.sqlite3",
    ] {
        let p = old.join(name);
        if regular(&p)? {
            let dest = staging.path().join(name);
            if name.ends_with(".sqlite3") {
                database_copy(&p, &dest)?;
            } else {
                fs::copy(p, dest).map_err(|e| e.to_string())?;
            }
        }
    }
    let memory = old.join("memory");
    if memory.exists() {
        if !fs::symlink_metadata(&memory)
            .map_err(|e| e.to_string())?
            .is_dir()
        {
            return Err("旧记忆目录异常".into());
        }
        for d in fs::read_dir(&memory).map_err(|e| e.to_string())? {
            let d = d.map_err(|e| e.to_string())?;
            if !d.file_type().map_err(|e| e.to_string())?.is_dir() {
                return Err("旧记忆目录中出现未知项目".into());
            }
            let pet = d.file_name().into_string().map_err(|_| "旧宠物编号异常")?;
            let p = d.path().join("notebooks.txt");
            if !regular(&p)? {
                continue;
            }
            let lock = d.path().join("notebooks.lock");
            let _guard = if regular(&lock)? {
                let f = File::open(lock).map_err(|e| e.to_string())?;
                f.lock_shared().map_err(|e| e.to_string())?;
                Some(f)
            } else {
                None
            };
            let relative = Path::new("memory").join(&pet).join("notebooks.txt");
            let to = staging.path().join(&relative);
            fs::create_dir_all(to.parent().unwrap()).map_err(|e| e.to_string())?;
            let at = p
                .metadata()
                .and_then(|m| m.modified())
                .map_err(|e| e.to_string())?;
            fs::copy(&p, to).map_err(|e| e.to_string())?;
            versions.push((at, pet, relative));
        }
    }
    let retained = old.join(format!(
        "backup-v1-{}",
        staging
            .path()
            .file_name()
            .unwrap()
            .to_string_lossy()
            .trim_start_matches(".backup-")
    ));
    fs::rename(staging.path(), &retained).map_err(|e| e.to_string())?;
    Ok((retained, versions))
}
pub fn shared(old: &Path) -> R<PathBuf> {
    fs::create_dir_all(old).map_err(|e| e.to_string())?;
    let lock = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(old.join("migration.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    let dest = old.join("shared-v1");
    if dest.exists() {
        let m: Value = serde_json::from_slice(
            &fs::read(dest.join("migration.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|_| "迁移标记损坏")?;
        if m["version"] != 1 {
            return Err("未知数据版本".into());
        }
        return Ok(dest);
    }
    let (backup, mut versions) = backup(old)?;
    let result = (|| {
        let stage = tempfile::Builder::new()
            .prefix(".shared-")
            .tempdir_in(old)
            .map_err(|e| e.to_string())?;
        for n in [
            "settings.json",
            "external.json",
            "history.sqlite3",
            "reminders.sqlite3",
        ] {
            let p = backup.join(n);
            if p.is_file() {
                fs::copy(p, stage.path().join(n)).map_err(|e| e.to_string())?;
            }
        }
        if stage.path().join("history.sqlite3").exists() {
            let db = crate::history::open(stage.path()).map_err(|e| e.to_string())?;
            db.execute_batch("UPDATE sessions SET closed=1;DELETE FROM memory_context;")
                .map_err(|e| e.to_string())?;
        }
        let mut books = Books::default();
        let mut seen = [HashSet::new(), HashSet::new()];
        let mut overflow = Vec::new();
        versions.sort_by(|a, b| b.0.cmp(&a.0).then(a.1.cmp(&b.1)));
        for (_, pet, rel) in &versions {
            let legacy =
                Books::decode(&fs::read_to_string(backup.join(rel)).map_err(|e| e.to_string())?)?;
            for (index, entries) in [legacy.user, legacy.notes].into_iter().enumerate() {
                let (items, limit) = if index == 0 {
                    (&mut books.user, 2000)
                } else {
                    (&mut books.notes, 2200)
                };
                for text in entries.into_iter().rev() {
                    if !seen[index].insert(text.clone()) {
                        continue;
                    }
                    let used = Books::used(items)
                        + if items.is_empty() { 0 } else { 3 }
                        + text.chars().count();
                    if used <= limit {
                        items.push(text);
                    } else {
                        overflow.push(json!({"pet":pet,"book":index,"content":text}));
                    }
                }
            }
        }
        books.user.reverse();
        books.notes.reverse();
        fs::create_dir_all(stage.path().join("memory")).map_err(|e| e.to_string())?;
        fs::write(
            stage.path().join("memory/notebooks.json"),
            serde_json::to_vec_pretty(&books).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        if !overflow.is_empty() {
            fs::write(
                backup.join("overflow.json"),
                serde_json::to_vec_pretty(&overflow).unwrap(),
            )
            .map_err(|e| e.to_string())?;
        }
        if stage.path().join("settings.json").exists() {
            let mut settings: Value = serde_json::from_slice(
                &fs::read(stage.path().join("settings.json")).map_err(|e| e.to_string())?,
            )
            .map_err(|_| "旧设置格式异常")?;
            if let Some(persona) = settings["personality"].as_str().filter(|x| !x.is_empty()) {
                let mut personalities = HashMap::new();
                let pets = old.parent().unwrap().join("pets");
                if pets.exists() {
                    for item in fs::read_dir(pets).map_err(|e| e.to_string())? {
                        let d = item.map_err(|e| e.to_string())?;
                        if d.file_type().map_err(|e| e.to_string())?.is_dir() {
                            personalities.insert(
                                d.file_name().to_string_lossy().into_owned(),
                                persona.to_owned(),
                            );
                        }
                    }
                }
                fs::write(
                    stage.path().join("personas.json"),
                    serde_json::to_vec(&personalities).unwrap(),
                )
                .map_err(|e| e.to_string())?;
            }
            if let Some(obj) = settings.as_object_mut() {
                obj.remove("personality");
            }
            serde_json::from_value::<crate::companion::Settings>(settings.clone())
                .map_err(|_| "旧设置不能迁移")?;
            fs::write(
                stage.path().join("settings.json"),
                serde_json::to_vec_pretty(&settings).unwrap(),
            )
            .map_err(|e| e.to_string())?;
        }
        crate::external::External::open(stage.path())?;
        if stage.path().join("reminders.sqlite3").exists() {
            crate::reminders::list(stage.path(), "")?;
        }
        let meta = json!({"version":1,"backup":backup.file_name().unwrap().to_string_lossy(),"overflow":overflow.len()});
        fs::write(
            stage.path().join("migration.json"),
            serde_json::to_vec_pretty(&meta).unwrap(),
        )
        .map_err(|e| e.to_string())?;
        fs::rename(stage.path(), &dest).map_err(|e| e.to_string())?;
        Ok(dest)
    })();
    result.map_err(|e: String| {
        format!(
            "共享资料迁移失败，原数据保留。备份位于 {}。{e}",
            backup.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{history, memory, reminders, schedule::Schedule};
    #[test]
    fn merges_two_legacy_pets_once_and_keeps_overflow_and_provenance() {
        let temp = tempfile::tempdir().unwrap();
        let old = temp.path().join("brain");
        fs::create_dir_all(&old).unwrap();
        for (pet, user, note, sec) in [
            ("cat", "相同\n§\n小栗", "旧".repeat(1600), 5),
            ("dog", "相同\n§\n乌龙茶", "新".repeat(1600), 10),
        ] {
            let d = old.join("memory").join(pet);
            fs::create_dir_all(&d).unwrap();
            let p = d.join("notebooks.txt");
            fs::write(&p, format!("关于你\n{user}\n── 随伴的笔记 ──\n{note}")).unwrap();
            File::options()
                .write(true)
                .open(p)
                .unwrap()
                .set_modified(SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(sec))
                .unwrap();
            let (id, _) = history::begin(&old, pet, user, sec as i64 * 1000).unwrap();
            history::finish(&old, id, "好").unwrap();
            reminders::create(
                &old,
                pet,
                pet,
                Schedule::Once {
                    at: None,
                    after_seconds: Some(60),
                },
                pet,
                0,
            )
            .unwrap();
        }
        let shared = shared(&old).unwrap();
        let b = memory::read(&shared, "cat").unwrap();
        assert_eq!(b.user.len(), 3);
        assert!(b.authored.is_empty());
        assert_eq!(b.notes, ["新".repeat(1600)]);
        let manifest: Value =
            serde_json::from_slice(&fs::read(shared.join("migration.json")).unwrap()).unwrap();
        assert_eq!(manifest["overflow"], 1);
        let backup = old.join(manifest["backup"].as_str().unwrap());
        assert_eq!(
            fs::read(old.join("memory/cat/notebooks.txt")).unwrap(),
            fs::read(backup.join("memory/cat/notebooks.txt")).unwrap()
        );
        assert!(backup.join("overflow.json").exists());
        let turns = history::list(&shared, "dog").unwrap();
        assert_eq!((turns[0].pet.as_str(), turns[0].at), ("dog", 10000));
        assert_eq!(turns[1].pet, "cat");
        assert_eq!(
            reminders::list(&shared, "cat")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            2
        );
        assert_eq!(super::shared(&old).unwrap(), shared);
        assert_eq!(
            fs::read_dir(&old)
                .unwrap()
                .flatten()
                .filter(|d| d.file_name().to_string_lossy().starts_with("backup-v1-"))
                .count(),
            1
        );
    }
    #[test]
    fn malformed_old_book_never_publishes_and_can_retry() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path();
        let d = old.join("memory/cat");
        fs::create_dir_all(&d).unwrap();
        let p = d.join("notebooks.txt");
        fs::write(&p, "无效").unwrap();
        assert!(shared(old).is_err());
        assert_eq!(fs::read_to_string(&p).unwrap(), "无效");
        assert!(!old.join("shared-v1").exists());
        fs::write(&p, "关于你\n小栗\n── 随伴的笔记 ──\n").unwrap();
        assert!(shared(old).is_ok());
    }
}
