use crate::attachments::AttachedFile;
use rusqlite::{params, Connection, OptionalExtension, Result};
use serde::Serialize;
use std::path::Path;
#[cfg(test)]
#[path = "history_profile_tests.rs"]
mod profile_regression;
#[derive(Serialize)]
pub struct Turn {
    pub id: Option<i64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumbnail: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_data: Option<String>,
    pub steps: Option<serde_json::Value>,
    pub sources: serde_json::Value,
    pub question: String,
    pub answer: String,
    pub at: i64,
    #[serde(rename = "timeNote")]
    pub time_note: String,
    pub pet: String,
    /// Files sent with this turn; only filled for the turns given to the brain.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub files: Vec<AttachedFile>,
}
pub(crate) fn open(dir: &Path) -> Result<Connection> {
    let db = Connection::open(dir.join("history.sqlite3"))?;
    db.busy_timeout(std::time::Duration::from_secs(3))?;
    db.execute_batch("PRAGMA journal_mode=WAL;
 CREATE TABLE IF NOT EXISTS sessions(id INTEGER PRIMARY KEY, pet TEXT NOT NULL,last_at INTEGER NOT NULL,closed INTEGER NOT NULL DEFAULT 0);
 CREATE INDEX IF NOT EXISTS by_pet ON sessions(pet,id);
 CREATE TABLE IF NOT EXISTS turns(id INTEGER PRIMARY KEY,session INTEGER NOT NULL,question TEXT NOT NULL,answer TEXT NOT NULL DEFAULT '',at INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS deleted_turn_limit(singleton INTEGER PRIMARY KEY CHECK(singleton=1),last_id INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS by_session ON turns(session,id);
 CREATE TABLE IF NOT EXISTS turn_thumbnails(turn INTEGER PRIMARY KEY, png BLOB NOT NULL);
 CREATE TABLE IF NOT EXISTS turn_images(turn INTEGER PRIMARY KEY, png BLOB NOT NULL);
 CREATE TRIGGER IF NOT EXISTS drop_turn_image AFTER DELETE ON turns BEGIN DELETE FROM turn_images WHERE turn=old.id; END;
 CREATE TRIGGER IF NOT EXISTS drop_thumbnail AFTER DELETE ON turns BEGIN DELETE FROM turn_thumbnails WHERE turn=old.id; END;
 CREATE TABLE IF NOT EXISTS turn_steps(turn INTEGER PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS turn_sources(turn INTEGER PRIMARY KEY, data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS search_urls(session INTEGER NOT NULL,url TEXT NOT NULL,UNIQUE(session,url));
 CREATE TABLE IF NOT EXISTS memory_context(session INTEGER PRIMARY KEY, body TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS turn_files(turn INTEGER NOT NULL,name TEXT NOT NULL,text TEXT NOT NULL,PRIMARY KEY(turn,name));
 CREATE TABLE IF NOT EXISTS memory_reviews(pet TEXT NOT NULL, total INTEGER NOT NULL,PRIMARY KEY(pet,total));
 CREATE VIRTUAL TABLE IF NOT EXISTS turn_search USING fts5(question,answer, tokenize='trigram');
 CREATE TRIGGER IF NOT EXISTS index_turn AFTER INSERT ON turns BEGIN INSERT INTO turn_search(rowid,question,answer) VALUES(new.id,new.question,new.answer);END;
 CREATE TRIGGER IF NOT EXISTS update_turn AFTER UPDATE OF answer ON turns BEGIN UPDATE turn_search SET answer=new.answer WHERE rowid=new.id;END;")?;
    let has: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM pragma_table_info('turns') WHERE name='time_note')",
        [],
        |r| r.get(0),
    )?;
    if !has {
        db.execute(
            "ALTER TABLE turns ADD COLUMN time_note TEXT NOT NULL DEFAULT ''",
            [],
        )?;
    }
    Ok(db)
}
pub(crate) fn row(r: &rusqlite::Row) -> Result<Turn> {
    Ok(Turn {
        id: r.get(7).ok(),
        image_data: None,
        thumbnail: r.get::<_, Vec<u8>>(8).ok().map(|bytes| {
            use base64::{engine::general_purpose::STANDARD, Engine};
            format!("data:image/png;base64,{}", STANDARD.encode(bytes))
        }),
        steps: r
            .get::<_, String>(6)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok()),
        sources: r
            .get::<_, String>(5)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_else(|| serde_json::json!([])),
        question: r.get(0)?,
        answer: r.get(1)?,
        at: r.get(2)?,
        time_note: r.get(3)?,
        pet: r.get(4)?,
        files: vec![],
    })
}
/// A topic left alone this long ends; the next message starts a new one.
pub const TOPIC_IDLE_MS: i64 = 30 * 60 * 1000;
pub fn begin(dir: &Path, pet: &str, text: &str, now: i64) -> Result<(i64, Vec<Turn>)> {
    begin_topic_turn(dir, pet, text, now, TopicTarget::Current, None)
}
pub enum TopicTarget {
    Current,
    New,
    Selected(i64),
}

pub fn begin_topic_turn(
    dir: &Path,
    pet: &str,
    text: &str,
    now: i64,
    target: TopicTarget,
    picture: Option<&crate::chat_images::Picture>,
) -> Result<(i64, Vec<Turn>)> {
    let mut db = open(dir)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    // An older version deletes turns without knowing this table. Cleared
    // here, where a write is under way anyway, so reading never has to write.
    tx.execute(
        "DELETE FROM turn_files WHERE turn NOT IN (SELECT id FROM turns)",
        [],
    )?;
    let last: Option<(i64, i64, String)> = tx
        .query_row(
            "SELECT id,last_at,pet FROM sessions WHERE closed=0 ORDER BY id DESC LIMIT 1",
            [],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    let session = match (target, last) {
        (TopicTarget::Selected(id), _) => {
            let changed = tx.execute(
                "UPDATE sessions SET closed=0 WHERE id=? AND pet=? AND closed<>2",
                params![id, pet],
            )?;
            if changed == 0 {
                return Err(rusqlite::Error::QueryReturnedNoRows);
            }
            tx.execute(
                "UPDATE sessions SET closed=1 WHERE closed=0 AND id<>?",
                [id],
            )?;
            id
        }
        (TopicTarget::Current, Some((id, at, previous_pet)))
            if previous_pet == pet && now - at <= TOPIC_IDLE_MS =>
        {
            id
        }
        _ => {
            tx.execute("UPDATE sessions SET closed=1 WHERE closed=0", [])?;
            tx.execute(
                "INSERT INTO sessions(pet,last_at) VALUES(?,?)",
                params![pet, now],
            )?;
            tx.last_insert_rowid()
        }
    };
    let mut previous = tx
        .prepare("SELECT question,answer,at,time_note,s.pet FROM turns JOIN sessions s ON s.id=turns.session WHERE session=? ORDER BY turns.id")?
        .query_map([session], row)?
        .collect::<Result<Vec<_>>>()?;
    let ids = tx
        .prepare("SELECT id FROM turns WHERE session=? ORDER BY id")?
        .query_map([session], |r| r.get::<_, i64>(0))?
        .collect::<Result<Vec<_>>>()?;
    let mut files = tx.prepare("SELECT name,text FROM turn_files WHERE turn=? ORDER BY rowid")?;
    let mut images = crate::chat_images::recent(&tx, session, picture.is_some())?;
    for (turn, id) in previous.iter_mut().zip(&ids) {
        turn.image_data = images.remove(id);
        turn.files = files
            .query_map([id], |r| {
                Ok(AttachedFile {
                    name: r.get(0)?,
                    text: r.get(1)?,
                })
            })?
            .collect::<Result<Vec<_>>>()?;
    }
    drop(files);
    tx.execute(
        "UPDATE sessions SET last_at=? WHERE id=?",
        params![now, session],
    )?;
    let previous_at: Option<i64> = tx.query_row("SELECT max(at) FROM turns", [], |r| r.get(0))?;
    tx.execute(
        "INSERT INTO turns(id,session,question,at,time_note) VALUES((SELECT max(coalesce((SELECT max(id) FROM turns),0),coalesce((SELECT last_id FROM deleted_turn_limit),0))+1),?,?,?,?)",
        params![session, text, now, time_note(now, previous_at)],
    )?;
    let id = tx.last_insert_rowid();
    if let Some(image) = picture {
        image.save(&tx, id)?;
    }
    tx.commit()?;
    Ok((id, previous))
}
/// Keeps the files sent with a turn, so the topic's later turns see them.
pub fn save_files(dir: &Path, turn: i64, files: &[AttachedFile]) -> Result<()> {
    let mut db = open(dir)?;
    let tx = db.transaction()?;
    for f in files {
        tx.execute(
            "INSERT OR REPLACE INTO turn_files(turn,name,text) VALUES(?,?,?)",
            params![turn, f.name, f.text],
        )?;
    }
    tx.commit()
}
/// Background reports get their own history entry without switching the open chat.
#[cfg(test)]
pub fn begin_scheduled(
    dir: &Path,
    pet: &str,
    text: &str,
    at: i64,
    origin: Option<i64>,
) -> Result<(i64, i64)> {
    let mut db = open(dir)?;
    let tx = db.transaction()?;
    let result = begin_scheduled_tx(&tx, pet, text, at, origin)?;
    tx.commit()?;
    Ok(result)
}
pub(crate) fn begin_scheduled_tx(
    tx: &rusqlite::Transaction,
    pet: &str,
    text: &str,
    at: i64,
    origin: Option<i64>,
) -> Result<(i64, i64)> {
    let existing = tx
        .query_row(
            "SELECT id FROM sessions WHERE id=? AND pet=? AND closed<>2",
            params![origin, pet],
            |r| r.get::<_, i64>(0),
        )
        .optional()?;
    let topic = if let Some(id) = existing {
        tx.execute(
            "UPDATE sessions SET last_at=max(last_at,?) WHERE id=?",
            params![at, id],
        )?;
        id
    } else {
        tx.execute(
            "INSERT INTO sessions(pet,last_at,closed) VALUES(?,?,1)",
            params![pet, at],
        )?;
        tx.last_insert_rowid()
    };
    tx.execute("INSERT INTO turns(id,session,question,at,time_note) VALUES((SELECT max(coalesce((SELECT max(id) FROM turns),0),coalesce((SELECT last_id FROM deleted_turn_limit),0))+1),?,?,?,?)",params![topic,text,at,time_note(at,None)])?;
    Ok((tx.last_insert_rowid(), topic))
}
pub fn time_note(now: i64, last: Option<i64>) -> String {
    use chrono::{Datelike, Local, TimeZone};
    let dt = Local.timestamp_millis_opt(now).single().unwrap();
    let clock = dt.format("%H:%M").to_string();
    let template = include_str!("../../../brain/prompts/time-note.md").trim_end();
    let mins = last.map(|at| now.saturating_sub(at) / 60000).unwrap_or(0);
    if mins < 10 {
        return template
            .replace("，{{星期}}。距上次说话 {{间隔}}", "")
            .replace("{{时:分}}", &clock);
    }
    let elapsed = if mins >= 1440 {
        format!("{} 天", mins / 1440)
    } else if mins >= 60 {
        format!("{} 小时", mins / 60)
    } else {
        format!("{mins} 分钟")
    };
    template
        .replace("{{时:分}}", &clock)
        .replace(
            "{{星期}}",
            [
                "星期一",
                "星期二",
                "星期三",
                "星期四",
                "星期五",
                "星期六",
                "星期日",
            ][dt.weekday().num_days_from_monday() as usize],
        )
        .replace("{{间隔}}", &elapsed)
}
pub fn topic_and_note(dir: &Path, id: i64) -> Result<(i64, String)> {
    open(dir)?.query_row(
        "SELECT session,time_note FROM turns WHERE id=?",
        [id],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
}
pub fn finish(dir: &Path, id: i64, answer: &str) -> Result<()> {
    finish_with_tools(dir, id, answer, None, None)
}
pub fn finish_with_tools(
    dir: &Path,
    id: i64,
    answer: &str,
    sources: Option<&serde_json::Value>,
    steps: Option<&serde_json::Value>,
) -> Result<()> {
    let mut db = open(dir)?;
    let tx = db.transaction()?;
    if tx.execute("UPDATE turns SET answer=? WHERE id=?", params![answer, id])? == 0 {
        return Err(rusqlite::Error::QueryReturnedNoRows);
    }
    if let Some(items) = steps.and_then(|s| s.as_array()) {
        tx.execute(
            "INSERT OR REPLACE INTO turn_steps VALUES(?,?)",
            params![id, serde_json::json!(items).to_string()],
        )?;
    }
    if let Some(items) = sources.and_then(|v| v.as_array()).filter(|v| !v.is_empty()) {
        tx.execute(
            "INSERT OR REPLACE INTO turn_sources VALUES(?,?)",
            params![id, serde_json::json!(items).to_string()],
        )?;
    }
    tx.commit()
}
pub fn close(dir: &Path, _pet: &str) -> Result<()> {
    open(dir)?.execute("UPDATE sessions SET closed=1 WHERE closed=0", [])?;
    Ok(())
}
pub fn list(dir: &Path, _pet: &str) -> Result<Vec<Turn>> {
    let db = open(dir)?;
    let mut q=db.prepare("SELECT question,answer,at,time_note,pet FROM turns JOIN sessions ON sessions.id=turns.session ORDER BY turns.id DESC LIMIT 100")?;
    let rows = q.query_map([], row)?.collect();
    rows
}
pub fn snapshot(dir: &Path, turn: i64, current: &str) -> Result<String> {
    let mut db = open(dir)?;
    let tx = db.transaction()?;
    tx.execute(
        "DELETE FROM memory_context WHERE session IN (SELECT id FROM sessions WHERE closed=1)",
        [],
    )?;
    tx.execute(
        "INSERT OR IGNORE INTO memory_context SELECT session,? FROM turns WHERE id=?",
        params![current, turn],
    )?;
    let mut result: String=tx.query_row("SELECT body FROM memory_context JOIN turns ON turns.session=memory_context.session WHERE turns.id=?",[turn],|r|r.get(0))?;
    // Only user-controlled fields refresh. Pet-written memory stays frozen for this topic.
    if let (Ok(serde_json::Value::Object(mut frozen)), Ok(serde_json::Value::Object(current))) =
        (serde_json::from_str(&result), serde_json::from_str(current))
    {
        // Older topics mixed authored entries into this string. Drop only those
        // tagged blocks once; their migrated text now lives in the profile field.
        if !frozen.contains_key("profile") && current.contains_key("profile") {
            if let Some(user) = frozen.get("user").and_then(|v| v.as_str()) {
                let mut authored = false;
                let kept = user
                    .lines()
                    .filter(|line| {
                        if line.starts_with("- （用户写的）") {
                            authored = true;
                        } else if line.starts_with("- （你记的）") {
                            authored = false;
                        }
                        !authored
                    })
                    .collect::<Vec<_>>()
                    .join("\n");
                frozen.insert("user".into(), kept.into());
            }
        }
        for field in ["profile", "personality"] {
            if let Some(value) = current.get(field) {
                frozen.insert(field.into(), value.clone());
            }
        }
        let updated = serde_json::Value::Object(frozen).to_string();
        if updated != result {
            tx.execute("UPDATE memory_context SET body=? WHERE session=(SELECT session FROM turns WHERE id=?)", params![updated, turn])?;
            result = updated;
        }
    }
    tx.commit()?;
    Ok(result)
}
pub fn review_due(dir: &Path, _pet: &str) -> Result<Option<Vec<Turn>>> {
    let mut db = open(dir)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let n: i64 = tx.query_row(
        "SELECT COUNT(*) FROM turns t JOIN sessions s ON s.id=t.session WHERE t.answer<>''",
        [],
        |r| r.get(0),
    )?;
    if n == 0
        || n % 6 != 0
        || tx.execute(
            "INSERT OR IGNORE INTO memory_reviews VALUES(?,?)",
            params!["shared", n],
        )? == 0
    {
        return Ok(None);
    }
    let mut rows=tx.prepare("SELECT question,answer,at,time_note,pet FROM turns JOIN sessions ON sessions.id=turns.session WHERE answer<>'' ORDER BY turns.id DESC LIMIT 6")?.query_map([],row)?.collect::<Result<Vec<Turn>>>()?;
    rows.reverse();
    tx.commit()?;
    Ok(Some(rows))
}
pub fn save_urls(dir: &Path, turn: i64, urls: &[String]) -> Result<()> {
    let mut db = open(dir)?;
    let tx = db.transaction()?;
    for url in urls {
        tx.execute(
            "INSERT OR IGNORE INTO search_urls SELECT session,?2 FROM turns WHERE id=?1",
            params![turn, url],
        )?;
    }
    tx.commit()
}
pub fn urls(dir: &Path, turn: i64) -> Result<Vec<String>> {
    let db = open(dir)?;
    let mut q=db.prepare("SELECT url FROM search_urls WHERE session=(SELECT session FROM turns WHERE id=?) ORDER BY rowid DESC LIMIT 500")?;
    let result = q.query_map([turn], |r| r.get(0))?.collect();
    result
}
pub fn search(dir: &Path, _pet: &str, query: &str) -> Result<serde_json::Value> {
    let db = open(dir)?;
    let words: Vec<_> = query.split_whitespace().take(8).collect();
    if words.is_empty() {
        return Ok(serde_json::json!([]));
    }
    let expression = words
        .iter()
        .map(|w| format!("\"{}\"", w.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" OR ");
    let short = words.iter().any(|w| w.chars().count() < 3);
    let tokens = serde_json::json!(words).to_string();
    let sql = if short {
        "SELECT t.question,t.answer,t.at,t.time_note,s.pet FROM turns t JOIN sessions s ON s.id=t.session JOIN json_each(?1) k ON instr(t.question,k.value)>0 OR instr(t.answer,k.value)>0 GROUP BY t.id ORDER BY count(*) DESC,t.id DESC LIMIT 5"
    } else {
        "SELECT snippet(turn_search,0,'','','…',36),snippet(turn_search,1,'','','…',36),t.at,t.time_note,s.pet FROM turn_search JOIN turns t ON t.id=turn_search.rowid JOIN sessions s ON s.id=t.session WHERE turn_search MATCH ?1 ORDER BY rank,t.id DESC LIMIT 5"
    };
    let mut stmt = db.prepare(sql)?;
    let rows = stmt
        .query_map(params![if short { &tokens } else { &expression }], row)?
        .collect::<Result<Vec<_>>>()?;
    Ok(serde_json::json!(rows.into_iter().map(|t|serde_json::json!({"dateMs":t.at,"pet":t.pet,"question":t.question.chars().take(320).collect::<String>(),"answer":t.answer.chars().take(320).collect::<String>()})).collect::<Vec<_>>()))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn screenshot_starts_a_separate_topic_and_followups_keep_its_answer() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let (old, _) = begin(dir, "cat", "之前的话题", 1).unwrap();
        let (first, prior) =
            begin_topic_turn(dir, "cat", "这是什么？", 2, TopicTarget::New, None).unwrap();
        assert!(prior.is_empty());
        assert_ne!(
            topic_and_note(dir, old).unwrap().0,
            topic_and_note(dir, first).unwrap().0
        );
        finish(dir, first, "这是权限提示").unwrap();
        let (next, history) = begin(dir, "cat", "下一步呢？", 3).unwrap();
        assert_eq!(
            topic_and_note(dir, first).unwrap().0,
            topic_and_note(dir, next).unwrap().0
        );
        assert_eq!(history.len(), 1);
        assert_eq!(history[0].answer, "这是权限提示");
    }
    #[test]
    fn screenshot_can_continue_a_selected_older_topic() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let (first, _) = begin(dir, "cat", "安装软件", 1).unwrap();
        finish(dir, first, "打开设置").unwrap();
        let topic = topic_and_note(dir, first).unwrap().0;
        begin_topic_turn(dir, "cat", "别的话题", 2, TopicTarget::New, None).unwrap();
        let (turn, prior) = begin_topic_turn(
            dir,
            "cat",
            "点击哪里？",
            3,
            TopicTarget::Selected(topic),
            Some(&crate::chat_images::Picture {
                png: b"clear".to_vec(),
                thumbnail: b"preview".to_vec(),
            }),
        )
        .unwrap();
        assert_eq!(prior[0].answer, "打开设置");
        assert_eq!(topic_and_note(dir, turn).unwrap().0, topic);
        assert!(crate::topics::turns(dir, topic)
            .unwrap()
            .last()
            .unwrap()
            .thumbnail
            .is_some());
        assert!(
            begin_topic_turn(dir, "other", "?", 4, TopicTarget::Selected(topic), None).is_err()
        );
        assert_eq!(crate::topics::current(dir, "cat", 4).unwrap(), Some(topic));
    }
    #[test]
    fn reading_does_not_wait_for_a_write_in_progress() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        begin(dir, "cat", "你好", 1).unwrap();
        let mut writer = open(dir).unwrap();
        let tx = writer
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .unwrap();
        tx.execute("UPDATE turns SET answer='写到一半'", [])
            .unwrap();
        let started = std::time::Instant::now();
        assert_eq!(list(dir, "cat").unwrap().len(), 1);
        assert!(started.elapsed() < std::time::Duration::from_secs(1));
    }
    #[test]
    fn files_come_back_with_their_own_turn_and_orphans_are_cleared() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let file = |n: &str| AttachedFile {
            name: n.into(),
            text: format!("{n} 的内容"),
        };
        let (first, _) = begin(dir, "cat", "看看这份", 1).unwrap();
        save_files(dir, first, &[file("a.md"), file("b.md")]).unwrap();
        finish(dir, first, "看完了").unwrap();
        let (second, previous) = begin(dir, "cat", "再说说", 2).unwrap();
        assert_eq!(previous[0].files, [file("a.md"), file("b.md")]);
        finish(dir, second, "好").unwrap();
        let (_, previous) = begin(dir, "cat", "第三句", 3).unwrap();
        assert_eq!(previous[0].files.len(), 2);
        assert!(previous[1].files.is_empty(), "only the turn they came with");
        // A version that does not know the table deletes the turn only.
        open(dir)
            .unwrap()
            .execute("DELETE FROM turns WHERE id=?", [first])
            .unwrap();
        begin(dir, "cat", "第四句", 4).unwrap();
        let left: i64 = open(dir)
            .unwrap()
            .query_row("SELECT count(*) FROM turn_files", [], |r| r.get(0))
            .unwrap();
        assert_eq!(left, 0);
    }
    #[test]
    fn persists_indexes_and_splits_sessions() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let (id, _) = begin(dir, "cat", "今天去哪儿", 1).unwrap();
        finish(dir, id, "植物园见").unwrap();
        assert_eq!(
            begin(dir, "cat", "几点", 2).unwrap().1[0].answer,
            "植物园见"
        );
        assert_eq!(
            open(dir)
                .unwrap()
                .query_row(
                    "SELECT count(*) FROM turn_search WHERE turn_search MATCH '植物园'",
                    [],
                    |r| r.get::<_, u32>(0)
                )
                .unwrap(),
            1
        );
        assert!(begin(dir, "cat", "久违", 1800003).unwrap().1.is_empty());
        close(dir, "cat").unwrap();
        assert!(begin(dir, "cat", "新话题", 1800004).unwrap().1.is_empty());
        assert!(!list(dir, "dog").unwrap().is_empty());
    }
}
#[cfg(test)]
mod notebook_tests {
    use super::*;
    #[test]
    fn only_search_results_of_the_same_topic_are_reused() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let (a, _) = begin(dir, "cat", "搜索", 1).unwrap();
        save_urls(dir, a, &["https://example.org/a".into()]).unwrap();
        let (b, _) = begin(dir, "cat", "接着读", 2).unwrap();
        assert_eq!(urls(dir, b).unwrap(), ["https://example.org/a"]);
        let (c, _) = begin(dir, "dog", "新话题", 3).unwrap();
        assert!(urls(dir, c).unwrap().is_empty());
    }
    #[test]
    fn chinese_search_across_pets() {
        let tmp = tempfile::tempdir().unwrap();
        let (id, _) = begin(tmp.path(), "cat", "我最爱喝乌龙茶", 1).unwrap();
        finish(tmp.path(), id, "好").unwrap();
        for word in ["乌龙", "乌龙茶", "爱喝"] {
            let hits = search(tmp.path(), "dog", word).unwrap();
            assert_eq!(hits[0]["question"], "我最爱喝乌龙茶");
        }
    }
    #[test]
    fn snapshot_is_frozen_and_review_is_once_per_six() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        for n in 1..=6 {
            let (id, _) = begin(dir, "cat", "昨晚喝了乌龙茶", n).unwrap();
            let context = snapshot(dir, id, if n == 1 { "旧快照" } else { "新快照" }).unwrap();
            assert_eq!(context, "旧快照");
            finish(dir, id, "好的").unwrap();
            let review = review_due(dir, "cat").unwrap();
            assert_eq!(review.is_some(), n == 6);
        }
        assert!(review_due(dir, "cat").unwrap().is_none());
        close(dir, "cat").unwrap();
        let (id, _) = begin(dir, "cat", "你好", 9).unwrap();
        assert_eq!(snapshot(dir, id, "新快照").unwrap(), "新快照");
        assert!(!search(dir, "dog", "乌龙茶")
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert_eq!(
            search(dir, "cat", "乌龙茶")
                .unwrap()
                .as_array()
                .unwrap()
                .len(),
            5
        );
    }
}
