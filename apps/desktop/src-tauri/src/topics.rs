//! Topics for the chat window and chat page: list past topics, read one,
//! and reopen it so the next message continues there.
use crate::history::{self, Turn};
use crate::locale::t;
use rusqlite::{params, OptionalExtension, Result};
use serde::Serialize;
use std::path::Path;

#[derive(Serialize, Debug, PartialEq)]
pub struct Topic {
    pub id: i64,
    pub title: String,
    #[serde(rename = "lastAt")]
    pub last_at: i64,
    pub turns: i64,
    /// The pet it was with: the topics list shows its face.
    pub pet: String,
}
/// Newest first. A query keeps topics where any question or answer contains it.
pub fn list(dir: &Path, query: &str) -> Result<Vec<Topic>> {
    list_for(dir, query, None)
}

pub fn list_for(dir: &Path, query: &str, pet: Option<&str>) -> Result<Vec<Topic>> {
    let db = history::open(dir)?;
    let query = query.trim();
    let mut q = db.prepare(
        "SELECT s.id,
           (SELECT question FROM turns WHERE session=s.id ORDER BY id LIMIT 1),
           s.last_at,
           (SELECT count(*) FROM turns WHERE session=s.id),
           s.pet
         FROM sessions s
         WHERE s.closed<>2 AND (?2 IS NULL OR s.pet=?2) AND EXISTS(SELECT 1 FROM turns t WHERE t.session=s.id
           AND (?1='' OR instr(t.question,?1)>0 OR instr(t.answer,?1)>0))
         ORDER BY s.last_at DESC, s.id DESC LIMIT 200",
    )?;
    let rows = q
        .query_map(params![query, pet], |r| {
            let first: String = r.get(1)?;
            Ok(Topic {
                id: r.get(0)?,
                title: first
                    .lines()
                    .next()
                    .unwrap_or("")
                    .chars()
                    .take(40)
                    .collect(),
                last_at: r.get(2)?,
                turns: r.get(3)?,
                pet: r.get(4)?,
            })
        })?
        .collect();
    rows
}
pub fn turns(dir: &Path, id: i64) -> Result<Vec<Turn>> {
    let db = history::open(dir)?;
    let mut q = db.prepare(
        "SELECT question,answer,at,time_note,s.pet,(SELECT data FROM turn_sources WHERE turn=turns.id),(SELECT data FROM turn_steps WHERE turn=turns.id),turns.id,(SELECT png FROM turn_thumbnails WHERE turn=turns.id) FROM turns JOIN sessions s ON s.id=turns.session
         WHERE session=? ORDER BY turns.id",
    )?;
    let rows = q.query_map([id], history::row)?.collect();
    rows
}
/// The open topic the next message would continue, if there is one.
pub fn current(dir: &Path, pet: &str, now: i64) -> Result<Option<i64>> {
    history::open(dir)?
        .query_row(
            "SELECT id FROM sessions WHERE closed=0 AND pet=? AND ?-last_at<=? ORDER BY id DESC LIMIT 1",
            params![pet, now, history::TOPIC_IDLE_MS],
            |r| r.get(0),
        )
        .optional()
}
/// Make a past topic the open one, so the next message continues it.
pub fn reopen(dir: &Path, id: i64, pet: &str, now: i64) -> Result<()> {
    let mut db = history::open(dir)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let found: Option<i64> = tx
        .query_row(
            "SELECT id FROM sessions WHERE id=? AND closed<>2",
            [id],
            |r| r.get(0),
        )
        .optional()?;
    if found.is_none() {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    tx.execute(
        "UPDATE sessions SET closed=1 WHERE closed=0 AND id<>?",
        [id],
    )?;
    tx.execute(
        "UPDATE sessions SET closed=0, pet=?, last_at=? WHERE id=?",
        params![pet, now, id],
    )?;
    tx.commit()
}

/// Keep the empty session ID reserved: old timers must never deliver into a reused topic.
pub(crate) fn routing_db(dir: &Path) -> Result<rusqlite::Connection> {
    let db = history::open(dir)?;
    db.execute_batch("PRAGMA foreign_keys=ON")?;
    db.execute(
        "ATTACH DATABASE ? AS tasks",
        [dir.join("reminders.sqlite3").to_string_lossy().as_ref()],
    )?;
    Ok(db)
}
#[derive(Serialize)]
pub struct LinkedTask {
    id: i64,
    name: String,
}
fn linked(db: &rusqlite::Connection, id: i64) -> Result<Vec<LinkedTask>> {
    let mut stmt=db.prepare("SELECT r.id,coalesce(n.name,substr(r.message,1,50)) FROM task_origins o
        JOIN reminders r ON r.id=o.reminder LEFT JOIN reminder_names n ON n.reminder=r.id WHERE o.topic=? ORDER BY r.id")?;
    let rows = stmt
        .query_map([id], |r| {
            Ok(LinkedTask {
                id: r.get(0)?,
                name: r.get(1)?,
            })
        })?
        .collect();
    rows
}
pub fn linked_tasks(dir: &Path, id: i64) -> std::result::Result<Vec<LinkedTask>, String> {
    let db = crate::reminders::db(dir)?;
    linked(&db, id).map_err(|e| e.to_string())
}
pub fn delete_with_tasks(
    dir: &Path,
    id: i64,
    remove: bool,
    expected: &[i64],
) -> std::result::Result<(), String> {
    drop(crate::reminders::db(dir)?);
    let mut db = routing_db(dir).map_err(|e| e.to_string())?;
    let tx = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let current = linked(&tx, id).map_err(|e| e.to_string())?;
    if !current.iter().map(|t| t.id).eq(expected.iter().copied()) {
        return Err(t("host.tasksChanged").into());
    }
    let running:bool=tx.query_row("SELECT EXISTS(SELECT 1 FROM task_runs j JOIN task_origins o ON o.reminder=j.reminder WHERE o.topic=? AND j.status='running')",[id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if running {
        return Err(t("host.taskRunning").into());
    }
    if remove {
        tx.execute("DELETE FROM tasks.reminders WHERE id IN (SELECT reminder FROM tasks.task_origins WHERE topic=?)",[id]).map_err(|e|e.to_string())?;
    }
    delete_history(&tx, id).map_err(|e| e.to_string())?;
    tx.commit().map_err(|e| e.to_string())
}
fn delete_history(tx: &rusqlite::Transaction, id: i64) -> Result<()> {
    if tx.execute(
        "UPDATE sessions SET closed=2 WHERE id=? AND closed<>2",
        [id],
    )? == 0
    {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    tx.execute("INSERT INTO deleted_turn_limit VALUES(1,coalesce((SELECT max(id) FROM turns WHERE session=?),0))
        ON CONFLICT(singleton) DO UPDATE SET last_id=max(last_id,excluded.last_id)", [id])?;
    for (table, key) in [
        ("turn_search", "rowid"),
        ("turn_sources", "turn"),
        ("turn_steps", "turn"),
        ("turn_files", "turn"),
    ] {
        tx.execute(
            &format!("DELETE FROM {table} WHERE {key} IN (SELECT id FROM turns WHERE session=?)"),
            [id],
        )?;
    }
    for table in ["search_urls", "memory_context", "turns"] {
        tx.execute(&format!("DELETE FROM {table} WHERE session=?"), [id])?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{begin, close, finish};
    const HOUR: i64 = 60 * 60 * 1000;
    #[test]
    fn deleting_a_topic_removes_records_and_preserves_other_topics_and_future_delivery() {
        let temp = tempfile::tempdir().unwrap();
        let d = temp.path();
        let (keep, _) = begin(d, "cat", "保留", 1).unwrap();
        finish(d, keep, "保留回答").unwrap();
        close(d, "cat").unwrap();
        let (old, _) = begin(d, "cat", "obsolete needle", 2).unwrap();
        let topic = history::topic_and_note(d, old).unwrap().0;
        history::finish_with_tools(
            d,
            old,
            "obsolete answer",
            Some(&serde_json::json!(["url"])),
            Some(&serde_json::json!([])),
        )
        .unwrap();
        let file = crate::attachments::AttachedFile {
            name: "a.md".into(),
            text: "附件".into(),
        };
        history::save_files(d, old, &[file]).unwrap();
        delete_with_tasks(d, topic, false, &[]).unwrap();
        assert!(turns(d, topic).unwrap().is_empty());
        assert!(reopen(d, topic, "cat", 3).is_err());
        let db = history::open(d).unwrap();
        for table in ["turn_steps", "turn_sources", "turn_search", "turn_files"] {
            let count: i64 = db
                .query_row(
                    &format!(
                        "SELECT count(*) FROM {table} WHERE {}=?",
                        if table == "turn_search" {
                            "rowid"
                        } else {
                            "turn"
                        }
                    ),
                    [old],
                    |r| r.get(0),
                )
                .unwrap();
            assert_eq!(count, 0);
        }
        let kept = list(d, "保留").unwrap();
        assert_eq!(kept.len(), 1);
        // Each topic says which pet it was with, for its face in the list.
        assert_eq!(kept[0].pet, "cat");
        let (turn, new_topic) =
            history::begin_scheduled(d, "cat", "后续报告", 4, Some(topic)).unwrap();
        assert_ne!(topic, new_topic);
        assert!(turn > old);
        assert!(finish(d, old, "迟到的回答").is_err());
    }

    #[test]
    fn reopens_tool_steps_and_recognizes_legacy_links() {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        let (id, _) = begin(d, "cat", "查一下", 1).unwrap();
        let pages = serde_json::json!([{"title":"读过的页面","url":"https://example.org/a"}]);
        let steps = serde_json::json!([
          {"name":"web_search","status":"ok","count":2},
          {"name":"web_read","status":"ok","pages":pages},
          {"name":"web_read","status":"failed","reason":"网页读取超时"},
          {"name":"memory","status":"ok"},{"name":"reminder_create","status":"ok"},
          {"name":"mcp_fixture","status":"ok"}
        ]);
        history::finish_with_tools(d, id, "查到了", Some(&pages), Some(&steps)).unwrap();
        let topic = history::topic_and_note(d, id).unwrap().0;
        let (old, _) = begin(d, "cat", "旧记录", 2).unwrap();
        history::finish_with_tools(d, old, "旧回答", Some(&pages), None).unwrap();
        close(d, "cat").unwrap();
        reopen(d, topic, "cat", 3).unwrap();
        let restored = turns(d, topic).unwrap();
        assert_eq!(restored[0].steps.as_ref(), Some(&steps));
        assert_eq!(restored[0].id, Some(id));
        assert_eq!(restored[0].sources, pages);
        assert!(restored[1].steps.is_none());
    }
    #[test]
    fn lists_searches_and_reads_topics() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let (a, _) = begin(dir, "cat", "第一个话题\n第二行", 1).unwrap();
        finish(dir, a, "乌龙茶").unwrap();
        close(dir, "cat").unwrap();
        let (b, _) = begin(dir, "cat", "第二个话题", 2).unwrap();
        finish(dir, b, "绿茶").unwrap();
        let all = list(dir, "").unwrap();
        assert_eq!(all.len(), 2);
        assert_eq!(all[0].title, "第二个话题");
        assert_eq!(all[1].title, "第一个话题");
        let found = list(dir, "乌龙").unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(turns(dir, found[0].id).unwrap()[0].answer, "乌龙茶");
    }
    #[test]
    fn reopened_topic_is_continued_by_the_next_message() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let (a, _) = begin(dir, "cat", "旧话题", 1).unwrap();
        finish(dir, a, "好的").unwrap();
        let (b, _) = begin(dir, "cat", "新话题", 3 * HOUR).unwrap();
        finish(dir, b, "嗯").unwrap();
        let old = list(dir, "旧话题").unwrap()[0].id;
        reopen(dir, old, "dog", 4 * HOUR).unwrap();
        assert_eq!(current(dir, "dog", 4 * HOUR).unwrap(), Some(old));
        let (_, previous) = begin(dir, "dog", "接着说", 4 * HOUR + 1).unwrap();
        assert_eq!(previous.len(), 1);
        assert_eq!(previous[0].question, "旧话题");
        assert!(reopen(dir, 999, "dog", 5 * HOUR).is_err());
    }
    #[test]
    fn current_skips_idle_or_other_pets_topics() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        begin(dir, "cat", "你好", 1).unwrap();
        assert!(current(dir, "cat", 2).unwrap().is_some());
        assert_eq!(current(dir, "dog", 2).unwrap(), None);
        assert_eq!(current(dir, "cat", 1 + HOUR).unwrap(), None);
    }
}
