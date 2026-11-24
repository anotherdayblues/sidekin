//! 翻译记录: each translation's original and result, kept apart from chat.
//! Translations never become chat topics and carry no context between them.
use crate::locale::t;
use crate::{companion::Companion, history};
use rusqlite::{params, Result};
use serde::Serialize;
use std::path::Path;
use tauri::{AppHandle, Manager};

/// Only the newest records are kept.
const KEEP: i64 = 500;

#[derive(Serialize, Debug, PartialEq)]
pub struct Translation {
    pub id: i64,
    pub source: String,
    pub result: String,
    pub at: i64,
    /// The language it went into (plan/41); None for older records and when
    /// the model chose the direction.
    pub into: Option<String>,
}
fn table(db: &rusqlite::Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS translations(id INTEGER PRIMARY KEY, source TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL);",
    )?;
    // plan/41 added `into_lang`. An added column keeps older builds working:
    // they name the columns they read and write.
    let has: bool = db.query_row(
        "SELECT count(*) FROM pragma_table_info('translations') WHERE name='into_lang'",
        [],
        |r| r.get::<_, i64>(0).map(|n| n > 0),
    )?;
    if !has {
        db.execute_batch("ALTER TABLE translations ADD COLUMN into_lang TEXT;")?;
    }
    Ok(())
}
pub fn record(
    dir: &Path,
    source: &str,
    result: &str,
    into: Option<&str>,
    at: i64,
) -> Result<()> {
    if source.trim().is_empty() || result.trim().is_empty() {
        return Ok(());
    }
    let db = history::open(dir)?;
    table(&db)?;
    db.execute(
        "INSERT INTO translations(source,result,at,into_lang) VALUES(?,?,?,?)",
        params![source, result, at, into],
    )?;
    db.execute(
        "DELETE FROM translations WHERE id <= (SELECT max(id) FROM translations) - ?",
        [KEEP],
    )?;
    Ok(())
}
/// Newest first.
pub fn list(dir: &Path, limit: i64) -> Result<Vec<Translation>> {
    let db = history::open(dir)?;
    table(&db)?;
    let mut q =
        db.prepare(
            "SELECT id,source,result,at,into_lang FROM translations ORDER BY id DESC LIMIT ?",
        )?;
    let rows = q
        .query_map([limit], |r| {
            Ok(Translation {
                id: r.get(0)?,
                source: r.get(1)?,
                result: r.get(2)?,
                at: r.get(3)?,
                into: r.get(4)?,
            })
        })?
        .collect();
    rows
}
/// One record, by id; or every record when `id` is None.
pub fn remove(dir: &Path, id: Option<i64>) -> Result<()> {
    let db = history::open(dir)?;
    table(&db)?;
    match id {
        Some(id) => db.execute("DELETE FROM translations WHERE id=?", [id])?,
        None => db.execute("DELETE FROM translations", [])?,
    };
    Ok(())
}
#[tauri::command]
pub fn delete_translation(app: AppHandle, id: Option<i64>) -> Result<(), String> {
    remove(&app.state::<Companion>().dir, id).map_err(|_| t("host.translationsDelete").into())
}
#[tauri::command]
pub fn translation_history(app: AppHandle) -> Result<Vec<Translation>, String> {
    list(&app.state::<Companion>().dir, 200).map_err(|_| t("host.translationsRead").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn records_stay_apart_from_chat_newest_first() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        record(dir, "Hello", "你好", None, 1).unwrap();
        record(dir, "Good night", "晚安", None, 2).unwrap();
        record(dir, "  ", "空的不记", None, 3).unwrap();
        let all = list(dir, 10).unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].source, "Good night");
        assert_eq!(all[1].result, "你好");
        // Nothing reached the chat topics.
        assert!(crate::topics::list(dir, "").unwrap().is_empty());
    }
    #[test]
    fn one_record_or_all_can_be_deleted() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        record(dir, "Hello", "你好", None, 1).unwrap();
        record(dir, "Good night", "晚安", None, 2).unwrap();
        record(dir, "Thanks", "谢谢", None, 3).unwrap();
        let gone = list(dir, 10).unwrap()[1].id;
        remove(dir, Some(gone)).unwrap();
        let left: Vec<_> = list(dir, 10)
            .unwrap()
            .into_iter()
            .map(|r| r.source)
            .collect();
        assert_eq!(left, ["Thanks", "Hello"]);
        // An id already gone is not an error.
        remove(dir, Some(gone)).unwrap();
        remove(dir, None).unwrap();
        assert!(list(dir, 10).unwrap().is_empty());
        // Recording goes on after a clear.
        record(dir, "Again", "再来", None, 4).unwrap();
        assert_eq!(list(dir, 10).unwrap().len(), 1);
    }
    #[test]
    fn language_column_added_to_an_older_table() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        // A table as older builds made it, with one record.
        let db = history::open(dir).unwrap();
        db.execute_batch(
            "CREATE TABLE translations(id INTEGER PRIMARY KEY, source TEXT NOT NULL, result TEXT NOT NULL, at INTEGER NOT NULL);
             INSERT INTO translations(source,result,at) VALUES('Hi','你好',1);",
        )
        .unwrap();
        drop(db);
        record(dir, "周末吃拉面吧", "週末ラーメン食べよう", Some("日文"), 2).unwrap();
        let all = list(dir, 10).unwrap();
        assert_eq!(all[0].into.as_deref(), Some("日文"));
        assert_eq!(all[1].into, None);
        // An older build still writes the way it always did.
        let db = history::open(dir).unwrap();
        db.execute(
            "INSERT INTO translations(source,result,at) VALUES('Bye','再见',3)",
            [],
        )
        .unwrap();
        assert_eq!(list(dir, 10).unwrap().len(), 3);
    }
}
