//! Model tools address SQLite document/section numbers only. No tool accepts a disk path.
use crate::companion::Companion;
use crate::locale::t;
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, io::Write, path::Path};
use tauri::{AppHandle, Manager, WebviewWindow};
const MAX: usize = 20 * 1024 * 1024;
type R<T> = Result<T, String>;
fn db(dir: &Path) -> R<Connection> {
    fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    let db = Connection::open(dir.join("index.sqlite3")).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS files(id INTEGER PRIMARY KEY,name TEXT NOT NULL,note TEXT NOT NULL,object TEXT NOT NULL);CREATE TABLE IF NOT EXISTS chunks(id INTEGER PRIMARY KEY,file INTEGER NOT NULL,section INTEGER NOT NULL,text TEXT NOT NULL,UNIQUE(file,section));CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(text,tokenize='trigram');CREATE TRIGGER IF NOT EXISTS docs_add AFTER INSERT ON chunks BEGIN INSERT INTO docs_fts(rowid,text) VALUES(new.id,new.text);END;CREATE TRIGGER IF NOT EXISTS docs_del AFTER DELETE ON chunks BEGIN DELETE FROM docs_fts WHERE rowid=old.id;END;").map_err(|e|e.to_string())?;
    Ok(db)
}
fn ext(name: &str) -> R<String> {
    let extension = Path::new(name)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_lowercase();
    if name.is_empty()
        || name.chars().count() > 250
        || name.contains(['/', '\\', '\0'])
        || !["txt", "md", "pdf", "docx", "html"].contains(&extension.as_str())
    {
        return Err(t("host.docTypes").into());
    }
    Ok(extension)
}
pub fn import(dir: &Path, name: &str, note: &str, bytes: &[u8], text: &str) -> R<i64> {
    store(dir, None, name, note, bytes, text)
}
pub fn replace(dir: &Path, id: i64, name: &str, note: &str, bytes: &[u8], text: &str) -> R<i64> {
    store(dir, Some(id), name, note, bytes, text)
}
fn store(
    dir: &Path,
    replace_id: Option<i64>,
    name: &str,
    note: &str,
    bytes: &[u8],
    text: &str,
) -> R<i64> {
    let extension = ext(name)?;
    if text.trim().is_empty() {
        return Err(if extension == "pdf" {
            t("library.pdfImages").into()
        } else {
            t("library.noText").into()
        });
    }
    if bytes.len() > MAX || text.len() > 32 * 1024 * 1024 || note.chars().count() > 400 {
        return Err(t("host.docLimits").into());
    }
    let mut db = db(dir)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let object = format!("{:x}.{extension}", Sha256::digest(bytes));
    let objects = dir.join("objects");
    fs::create_dir_all(&objects).map_err(|e| e.to_string())?;
    if !objects.join(&object).is_file() {
        let mut tmp = tempfile::NamedTempFile::new_in(&objects).map_err(|e| e.to_string())?;
        tmp.write_all(bytes)
            .and_then(|_| tmp.as_file().sync_all())
            .map_err(|e| e.to_string())?;
        tmp.persist_noclobber(objects.join(&object))
            .map_err(|e| e.to_string())?;
    }
    // Replacing keeps the entry and its note unless a new note is given. An
    // entry deleted meanwhile is imported anew.
    let previous: Option<(String, String)> = replace_id.and_then(|id| {
        tx.query_row("SELECT object,note FROM files WHERE id=?", [id], |r| {
            Ok((r.get(0)?, r.get(1)?))
        })
        .ok()
    });
    let id = match (replace_id, &previous) {
        (Some(id), Some((_, previous_note))) => {
            let note = if note.is_empty() { previous_note } else { note };
            tx.execute("DELETE FROM chunks WHERE file=?", [id])
                .map_err(|e| e.to_string())?;
            tx.execute(
                "UPDATE files SET name=?,note=?,object=? WHERE id=?",
                params![name, note, object, id],
            )
            .map_err(|e| e.to_string())?;
            id
        }
        _ => {
            tx.execute(
                "INSERT INTO files(name,note,object) VALUES(?,?,?)",
                params![name, note, object],
            )
            .map_err(|e| e.to_string())?;
            tx.last_insert_rowid()
        }
    };
    let mut chars = text.chars();
    for section in 1.. {
        let part = chars.by_ref().take(1000).collect::<String>();
        if part.is_empty() {
            break;
        }
        tx.execute(
            "INSERT INTO chunks(file,section,text) VALUES(?,?,?)",
            params![id, section, part],
        )
        .map_err(|e| e.to_string())?;
    }
    let stale = match previous {
        Some((old, _)) if old != object && unused(&tx, &old)? => Some(old),
        _ => None,
    };
    tx.commit().map_err(|e| e.to_string())?;
    if let Some(old) = stale {
        drop_copy(&objects, &old);
    }
    Ok(id)
}
pub fn list(dir: &Path) -> R<Vec<Value>> {
    let db = db(dir)?;
    let mut q=db.prepare("SELECT f.id,name,note,count(c.id) FROM files f LEFT JOIN chunks c ON c.file=f.id GROUP BY f.id ORDER BY f.id DESC").map_err(|e|e.to_string())?;
    let rows=q.query_map([],|r|Ok(json!({"id":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?,"note":r.get::<_,String>(2)?,"sections":r.get::<_,i64>(3)?}))).map_err(|e|e.to_string())?.collect::<rusqlite::Result<Vec<_>>>();
    rows.map_err(|e| e.to_string())
}
pub fn catalog(dir: &Path) -> R<String> {
    let files = list(dir)?;
    let title = format!("资料库里有 {} 个文件，用 library_search 查。", files.len());
    if files.len() > 20 {
        return Ok(title);
    }
    let lines = files
        .iter()
        .map(|v| {
            format!(
                "#{} {} {}",
                v["id"],
                v["name"].as_str().unwrap_or(""),
                v["note"].as_str().unwrap_or("")
            )
        })
        .collect::<Vec<_>>()
        .join("\n");
    Ok(lines.chars().take(800).collect())
}
fn row(r: &rusqlite::Row) -> rusqlite::Result<Value> {
    Ok(
        json!({"file":r.get::<_,i64>(0)?,"name":r.get::<_,String>(1)?,"section":r.get::<_,i64>(2)?,"text":r.get::<_,String>(3)?}),
    )
}
pub fn search(dir: &Path, query: &str) -> R<Value> {
    let db = db(dir)?;
    let words: Vec<_> = query.split_whitespace().take(8).collect();
    if words.is_empty() {
        return Ok(json!([]));
    }
    let short = words.iter().any(|w| w.chars().count() < 3);
    let term = if short {
        json!(words).to_string()
    } else {
        words
            .iter()
            .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
            .collect::<Vec<_>>()
            .join(" OR ")
    };
    let sql = if short {
        "SELECT f.id,f.name,c.section,c.text FROM chunks c JOIN files f ON f.id=c.file JOIN json_each(?1) w ON instr(c.text,w.value)>0 OR instr(f.name,w.value)>0 OR instr(f.note,w.value)>0 GROUP BY c.id ORDER BY count(*) DESC,c.id LIMIT 5"
    } else {
        "SELECT f.id,f.name,c.section,c.text FROM docs_fts JOIN chunks c ON c.id=docs_fts.rowid JOIN files f ON f.id=c.file WHERE docs_fts MATCH ? ORDER BY rank,c.id LIMIT 5"
    };
    let mut q = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows = q
        .query_map([term], row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    if !short && rows.is_empty() {
        let mut metadata=db.prepare("SELECT f.id,f.name,c.section,c.text FROM chunks c JOIN files f ON f.id=c.file JOIN json_each(?) w ON instr(f.name,w.value)>0 OR instr(f.note,w.value)>0 WHERE c.section=1 GROUP BY c.id ORDER BY c.id LIMIT 5").map_err(|e|e.to_string())?;
        let matches = metadata
            .query_map([json!(words).to_string()], row)
            .map_err(|e| e.to_string())?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(|e| e.to_string())?;
        return Ok(json!(matches));
    }
    Ok(json!(rows))
}
pub fn read(dir: &Path, file: i64, start: i64, count: i64) -> R<Value> {
    if file < 1 || start < 1 || !(1..=5).contains(&count) {
        return Err("段号从 1 开始，一次最多 5 段".into());
    }
    let db = db(dir)?;
    let mut q=db.prepare("SELECT f.id,f.name,c.section,c.text FROM chunks c JOIN files f ON f.id=c.file WHERE f.id=? AND c.section>=? ORDER BY c.section LIMIT ?").map_err(|e|e.to_string())?;
    let rows = q
        .query_map(params![file, start, count], row)
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(|e| e.to_string())?;
    Ok(json!(rows))
}
fn studio(w: &WebviewWindow) -> R<()> {
    if !["studio", "chat"].contains(&w.label()) {
        return Err(t("host.docWhere").into());
    }
    Ok(())
}
#[tauri::command]
pub async fn library_source(window: WebviewWindow, path: String) -> R<String> {
    studio(&window)?;
    let p = Path::new(&path);
    ext(p
        .file_name()
        .and_then(|s| s.to_str())
        .ok_or(t("host.noFileName"))?)?;
    let bytes = crate::library::bounded(p, MAX as u64)?;
    Ok(STANDARD.encode(bytes))
}
#[tauri::command]
pub async fn import_document(
    app: AppHandle,
    window: WebviewWindow,
    name: String,
    note: String,
    data: String,
    text: String,
    replace_id: Option<i64>,
) -> R<i64> {
    studio(&window)?;
    if data.len() > 4 * MAX.div_ceil(3) {
        return Err(t("library.tooBig").into());
    }
    let dir = app.state::<Companion>().host.library.clone();
    crate::tips::used(&app, "library");
    tauri::async_runtime::spawn_blocking(move || {
        let bytes = STANDARD.decode(data).map_err(|_| t("host.fileBad"))?;
        if let Some(id) = replace_id {
            replace(&dir, id, &name, &note, &bytes, &text)
        } else {
            import(&dir, &name, &note, &bytes, &text)
        }
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn list_documents(app: AppHandle) -> R<Vec<Value>> {
    list(&app.state::<Companion>().host.library)
}
#[tauri::command]
pub fn document_note(app: AppHandle, id: i64, note: String) -> R<()> {
    self::note(&app.state::<Companion>().host.library, id, &note)
}
#[tauri::command]
pub fn remove_document(app: AppHandle, window: WebviewWindow, id: i64) -> R<()> {
    studio(&window)?;
    remove(&app.state::<Companion>().host.library, id)
}
pub fn note(dir: &Path, id: i64, note: &str) -> R<()> {
    if note.chars().count() > 400 {
        return Err(t("host.noteTooLong").into());
    }
    db(dir)?
        .execute("UPDATE files SET note=? WHERE id=?", params![note, id])
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn remove(dir: &Path, id: i64) -> R<()> {
    let mut db = db(dir)?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let object: String = tx
        .query_row("SELECT object FROM files WHERE id=?", [id], |r| r.get(0))
        .map_err(|e| match e {
            rusqlite::Error::QueryReturnedNoRows => t("host.docMissing").into(),
            other => other.to_string(),
        })?;
    tx.execute("DELETE FROM chunks WHERE file=?", [id])
        .map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM files WHERE id=?", [id])
        .map_err(|e| e.to_string())?;
    let stale = unused(&tx, &object)?;
    tx.commit().map_err(|e| e.to_string())?;
    if stale {
        drop_copy(&dir.join("objects"), &object);
    }
    Ok(())
}
/// True when no entry uses this internal copy any more.
fn unused(tx: &rusqlite::Transaction, object: &str) -> R<bool> {
    tx.query_row(
        "SELECT count(*)=0 FROM files WHERE object=?",
        [object],
        |r| r.get(0),
    )
    .map_err(|e| e.to_string())
}
/// Deletes the library's own copy of a file, never anything outside
/// `objects`. The user's original file is never touched.
fn drop_copy(objects: &Path, object: &str) {
    if object.is_empty() || object.contains(['/', '\\', '\0']) || object == "." || object == ".." {
        return;
    }
    let copy = objects.join(object);
    if copy.is_file() {
        let _ = fs::remove_file(copy);
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn scoped_numbered_chunks_zh() {
        let t = tempfile::tempdir().unwrap();
        let dir = t.path();
        let id = import(
            dir,
            "需求.md",
            "我的项目",
            b"sample",
            &("背景".repeat(500) + "截止日期 12 月 1 日。我最爱喝乌龙茶"),
        )
        .unwrap();
        for word in ["乌龙", "乌龙茶", "爱喝"] {
            assert_eq!(search(dir, word).unwrap()[0]["section"], 2);
        }
        assert_eq!(read(dir, id, 2, 1).unwrap()[0]["file"], id);
        assert!(read(dir, id, 1, 6).is_err());
        assert!(import(dir, "../密码.txt", "", b"x", "x").is_err());
        assert!(!catalog(dir).unwrap().contains("12 月"));
    }
    #[test]
    fn remove_deletes_only_library_copy_and_keeps_original_file() {
        let src_dir = tempfile::tempdir().unwrap();
        let lib_dir = tempfile::tempdir().unwrap();
        let original = src_dir.path().join("重要合同.md");
        let content = "甲方与乙方的保密协议条款";
        fs::write(&original, content).unwrap();

        let bytes = crate::library::bounded(&original, MAX as u64).unwrap();
        let id1 = import(lib_dir.path(), "重要合同.md", "合同", &bytes, content).unwrap();
        let id2 = import(lib_dir.path(), "重要合同-副本.md", "备份", &bytes, content).unwrap();
        assert_eq!(list(lib_dir.path()).unwrap().len(), 2);

        // Removing the first entry keeps the shared internal object for the second entry,
        // and never touches the user's original file.
        remove(lib_dir.path(), id1).unwrap();
        assert_eq!(list(lib_dir.path()).unwrap().len(), 1);
        assert!(original.is_file());
        assert_eq!(fs::read_to_string(&original).unwrap(), content);

        // Removing the last entry cleans up the internal object and FTS index,
        // while the user's original file on disk remains completely intact.
        remove(lib_dir.path(), id2).unwrap();
        assert!(list(lib_dir.path()).unwrap().is_empty());
        assert!(search(lib_dir.path(), "保密协议")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            fs::read_dir(lib_dir.path().join("objects"))
                .unwrap()
                .count(),
            0
        );
        assert!(original.is_file());
        assert_eq!(fs::read_to_string(&original).unwrap(), content);
    }
    #[test]
    fn replace_updates_existing_entry_and_preserves_note() {
        let lib_dir = tempfile::tempdir().unwrap();
        let id = import(
            lib_dir.path(),
            "我的简历.pdf",
            "2025版简历",
            b"v1",
            "旧的工作经历",
        )
        .unwrap();
        let replaced = replace(
            lib_dir.path(),
            id,
            "我的简历.pdf",
            "",
            b"v2",
            "新的项目经历",
        )
        .unwrap();
        assert_eq!(id, replaced);
        let docs = list(lib_dir.path()).unwrap();
        assert_eq!(docs.len(), 1);
        assert_eq!(docs[0]["note"], "2025版简历");
        assert!(search(lib_dir.path(), "旧的工作")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(search(lib_dir.path(), "新的项目").unwrap()[0]["file"], id);
        assert_eq!(
            fs::read_dir(lib_dir.path().join("objects"))
                .unwrap()
                .count(),
            1
        );
        // The entry was deleted in the meantime: the file comes in anew.
        remove(lib_dir.path(), id).unwrap();
        let again = replace(lib_dir.path(), id, "我的简历.pdf", "", b"v3", "第三版").unwrap();
        assert_eq!(search(lib_dir.path(), "第三版").unwrap()[0]["file"], again);
    }
}
