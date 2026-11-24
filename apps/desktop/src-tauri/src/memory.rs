// Memory layout and bounded edit operations follow Hermes Agent's MIT-licensed
// memory tool. Storage, locking, transaction handling and Chinese checks are local.
use crate::locale::t;
use std::{
    fs::{self, File},
    io::Write,
    path::Path,
};

fn locked(dir: &Path, pet: &str) -> Result<(File, std::path::PathBuf), String> {
    if pet.is_empty()
        || !pet
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err("宠物编号无效".into());
    }
    let dir = dir.join("memory");
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let lock = File::options()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join("notebooks.lock"))
        .map_err(|e| e.to_string())?;
    lock.lock().map_err(|e| e.to_string())?;
    Ok((lock, dir))
}
fn load(dir: &Path) -> Result<Books, String> {
    let mut books: Books = match fs::read_to_string(dir.join("notebooks.json")) {
        Ok(s) => serde_json::from_str(&s).map_err(|_| t("host.memoryBad").into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Books::default()),
        Err(e) => Err(e.to_string()),
    }?;
    if books.migrate_profile() {
        save(dir, &books)?;
    }
    Ok(books)
}
pub(crate) fn save_profile(dir: &Path, pet: &str, text: String) -> Result<Books, String> {
    if text.chars().count() > 2000 {
        return Err(t("host.profileLimit").into());
    }
    let (_lock, dir) = locked(dir, pet)?;
    let mut books = load(&dir)?;
    books.profile = text;
    save(&dir, &books)?;
    Ok(books)
}
pub(crate) fn profile_migration(dir: &Path, pet: &str, undo: bool) -> Result<Books, String> {
    let (_lock, dir) = locked(dir, pet)?;
    let mut books = load(&dir)?;
    if undo {
        books.undo_profile_migration()?;
    } else {
        books.redo_profile_migration()?;
    }
    save(&dir, &books)?;
    Ok(books)
}
pub fn read(dir: &Path, pet: &str) -> Result<Books, String> {
    let (_lock, dir) = locked(dir, pet)?;
    load(&dir)
}
pub fn apply(dir: &Path, pet: &str, ops: &[Operation]) -> Result<Books, String> {
    apply_as(dir, pet, ops, false)
}
pub(crate) fn apply_as(
    dir: &Path,
    pet: &str,
    ops: &[Operation],
    manual: bool,
) -> Result<Books, String> {
    change(dir, pet, ops, manual).map(|(_, after)| after)
}
fn change(
    dir: &Path,
    pet: &str,
    ops: &[Operation],
    manual: bool,
) -> Result<(Books, Books), String> {
    if ops.is_empty() || ops.len() > 64 {
        return Err("每次需要 1 至 64 个操作".into());
    }
    let (_lock, dir) = locked(dir, pet)?;
    let before = load(&dir)?;
    let mut books = before.clone();
    for op in ops {
        books.edit(op, manual)?;
    }
    for (name, used, limit, current) in [
        ("关于你", Books::used(&books.user), 2000, &before.user),
        ("笔记", Books::used(&books.notes), 2200, &before.notes),
    ] {
        if used > limit {
            return Err(format!(
                "{name}超出 {} 个字符，请在同一批合并或删除旧条目。整批未写入。\n当前完整条目：{}",
                used - limit,
                serde_json::to_string(current).map_err(|e| e.to_string())?
            ));
        }
    }
    save(&dir, &books)?;
    Ok((before, books))
}
fn save(dir: &Path, books: &Books) -> Result<(), String> {
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    tmp.write_all(&serde_json::to_vec_pretty(&books).map_err(|e| e.to_string())?)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    tmp.persist(dir.join("notebooks.json"))
        .map_err(|e| e.to_string())?;
    #[cfg(unix)]
    File::open(&dir)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}

// A receipt exists only in this desktop process, for one committed chat write.
// Keep the exact pre-image so a batch containing edits can also be undone.
struct Receipt {
    id: u64,
    token: String,
    pet: String,
    before: Books,
    after: Books,
    until: std::time::Instant,
}
#[derive(Default)]
pub struct RecentWrite {
    next: u64,
    receipt: Option<Receipt>,
}
impl RecentWrite {
    pub fn apply(
        &mut self,
        dir: &Path,
        pet: &str,
        ops: &[Operation],
        manual: bool,
        chat: Option<&str>,
    ) -> Result<Books, String> {
        let (before, after) = change(dir, pet, ops, manual)?;
        if before == after {
            return Ok(after);
        }
        let previous = self.receipt.take();
        if let Some(token) = chat {
            let now = std::time::Instant::now();
            let original = previous
                .filter(|r| r.pet == pet && r.token == token && r.until > now && r.after == before)
                .map_or(before, |r| r.before);
            if original != after {
                self.next += 1;
                self.receipt = Some(Receipt {
                    id: self.next,
                    token: token.into(),
                    pet: pet.into(),
                    before: original,
                    after: after.clone(),
                    until: now + std::time::Duration::from_secs(5),
                });
            }
        }
        Ok(after)
    }
    pub fn notice(&self, token: &str) -> Option<serde_json::Value> {
        let r = self.receipt.as_ref().filter(|r| r.token == token)?;
        let ms = r
            .until
            .checked_duration_since(std::time::Instant::now())?
            .as_millis();
        let mut entries = Vec::new();
        for (book, old, new) in [
            ("user", &r.before.user, &r.after.user),
            ("notes", &r.before.notes, &r.after.notes),
        ] {
            for entry in new.iter().filter(|s| !old.contains(s)) {
                entries.push(serde_json::json!({"book":book,"added":entry}));
            }
            for entry in old.iter().filter(|s| !new.contains(s)) {
                entries.push(serde_json::json!({"book":book,"removed":entry}));
            }
        }
        Some(serde_json::json!({"id":r.id,"petId":r.pet,"expiresInMs":ms,"entries":entries}))
    }
    pub fn undo(&mut self, dir: &Path, pet: &str, id: u64) -> Result<Books, String> {
        let r = self
            .receipt
            .as_ref()
            .filter(|r| r.id == id && r.pet == pet && r.until > std::time::Instant::now())
            .ok_or(t("host.undoExpired"))?;
        let (_guard, dir) = locked(dir, pet)?;
        if load(&dir)? != r.after {
            return Err(t("host.memoryChanged").into());
        }
        save(&dir, &r.before)?;
        Ok(self.receipt.take().unwrap().before)
    }
}
pub fn view(b: &Books) -> serde_json::Value {
    let remembered: Vec<_> = b
        .user
        .iter()
        .filter(|s| !b.authored.contains(*s))
        .cloned()
        .collect();
    let migration = b.profile_migration.as_ref().map(|r| {
        serde_json::json!({
            "undone": r.undone, "canUndo": !r.undone && b.profile == r.after,
            "entries": r.entries.iter().map(|(_, s)| s).collect::<Vec<_>>()
        })
    });
    serde_json::json!({"profile":{"text":b.profile,"used":b.profile.chars().count(),"limit":2000,"migration":migration},"user":{"entries":remembered,"used":Books::used(&remembered),"limit":2000},"notes":{"entries":b.notes,"used":Books::used(&b.notes),"limit":2200}})
}

#[tauri::command]
pub async fn memory_view(app: tauri::AppHandle) -> Result<serde_json::Value, String> {
    use tauri::Manager;
    let pet = crate::chat::pet(&app)?.0;
    tauri::async_runtime::spawn_blocking(move || {
        read(&app.state::<crate::companion::Companion>().dir, &pet).map(|b| {
            let mut result = view(&b);
            result["petId"] = pet.into();
            if let Ok(v) = fs::read(
                app.state::<crate::companion::Companion>()
                    .dir
                    .join("migration.json"),
            ) {
                result["migration"] = serde_json::from_slice(&v).unwrap_or_default();
            }
            result
        })
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn memory_edit(
    app: tauri::AppHandle,
    pet_id: String,
    operations: Option<Vec<Operation>>,
    undo_id: Option<u64>,
    profile: Option<String>,
    profile_action: Option<String>,
) -> Result<serde_json::Value, String> {
    use tauri::{Emitter, Manager};
    if crate::chat::pet(&app)?.0 != pet_id {
        return Err(t("host.petSwitchedRefresh").into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<crate::companion::Companion>();
        let mut writes = state.host.recent_write.lock().unwrap();
        let books = match (undo_id, operations, profile, profile_action.as_deref()) {
            (Some(id), None, None, None) => writes.undo(&state.dir, &pet_id, id)?,
            (None, Some(ops), None, None) => writes.apply(&state.dir, &pet_id, &ops, true, None)?,
            (None, None, Some(text), None) => save_profile(&state.dir, &pet_id, text)?,
            (None, None, None, Some("undo")) => profile_migration(&state.dir, &pet_id, true)?,
            (None, None, None, Some("migrate")) => profile_migration(&state.dir, &pet_id, false)?,
            _ => return Err(t("host.editOrUndo").into()),
        };
        drop(writes);
        let _ = app.emit_to("studio", "memory-changed", ());
        Ok(view(&books))
    })
    .await
    .map_err(|e| e.to_string())?
}

#[path = "memory_books.rs"]
mod books;
pub use books::{Books, Operation};
#[cfg(test)]
#[path = "memory_tests.rs"]
mod memory_tests;
#[cfg(test)]
#[path = "memory_profile_tests.rs"]
mod profile_regression;
