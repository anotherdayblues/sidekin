//! Persist each due task before executing it, so timer refreshes cannot run it twice.
use crate::locale::t;
use crate::{chat, companion::Companion, history, library, reminders, State};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager};

pub fn schema(db: &Connection) -> rusqlite::Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS task_origins(reminder INTEGER PRIMARY KEY REFERENCES reminders(id) ON DELETE CASCADE,topic INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS task_modes(reminder INTEGER PRIMARY KEY REFERENCES reminders(id) ON DELETE CASCADE, mode TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS task_runs(id INTEGER PRIMARY KEY, reminder INTEGER NOT NULL REFERENCES reminders(id) ON DELETE CASCADE, due INTEGER NOT NULL, instruction TEXT NOT NULL, pet TEXT NOT NULL, mode TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'queued', result TEXT, UNIQUE(reminder,due));
    -- The action a task picked for the pet, played when its result shows (plan/10 §8.2).
    CREATE TABLE IF NOT EXISTS task_actions(run INTEGER PRIMARY KEY REFERENCES task_runs(id) ON DELETE CASCADE, action TEXT NOT NULL);")
}
pub fn mode(tx: &Transaction, id: i64, value: &str) -> Result<(), String> {
    if !matches!(value, "notify" | "agent") {
        return Err("无效任务类型".into());
    }
    tx.execute(
        "INSERT OR REPLACE INTO task_modes VALUES(?,?)",
        params![id, value],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn enqueue(tx: &Transaction, id: i64, due: i64) -> rusqlite::Result<()> {
    tx.execute("INSERT OR IGNORE INTO task_runs(reminder,due,instruction,pet,mode) SELECT r.id,?,r.message,r.pet,m.mode FROM reminders r JOIN task_modes m ON r.id=m.reminder WHERE r.id=? AND m.mode!='notify'",params![due,id])?;
    Ok(())
}
struct Job {
    id: i64,
    pet: String,
    instruction: String,
    reminder: i64,
    zone: Option<String>,
}
fn claim(db: &mut Connection) -> rusqlite::Result<Option<Job>> {
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let job=tx.query_row("SELECT id,pet,instruction,reminder,(SELECT json_extract(rule,'$.zone') FROM reminders WHERE id=task_runs.reminder) FROM task_runs WHERE status='queued' ORDER BY due LIMIT 1",[],|r|Ok(Job{id:r.get(0)?,pet:r.get(1)?,instruction:r.get(2)?,reminder:r.get(3)?,zone:r.get(4)?})).optional()?;
    if let Some(j) = &job {
        tx.execute("UPDATE task_runs SET status='running' WHERE id=?", [j.id])?;
    }
    tx.commit()?;
    Ok(job)
}
fn begin_delivery(dir: &std::path::Path, job: &Job, at: i64) -> rusqlite::Result<(i64, i64)> {
    let mut db = crate::topics::routing_db(dir)?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let origin: Option<i64> = tx.query_row(
        "SELECT o.topic FROM reminders r LEFT JOIN task_origins o ON o.reminder=r.id WHERE r.id=?",
        [job.reminder],
        |r| r.get(0),
    )?;
    let (turn, topic) = history::begin_scheduled_tx(&tx, &job.pet, &job.instruction, at, origin)?;
    if origin != Some(topic) {
        if let Some(old) = origin {
            tx.execute("UPDATE task_origins SET topic=? WHERE topic=? AND reminder IN (SELECT id FROM reminders WHERE pet=?)",params![topic,old,job.pet])?;
        } else {
            tx.execute(
                "INSERT INTO task_origins(reminder,topic) VALUES(?,?)",
                params![job.reminder, topic],
            )?;
        }
    }
    tx.commit()?;
    Ok((turn, topic))
}
/// The task's answer, whether it succeeded, and the action it picked.
fn execute(app: &AppHandle, job: &Job) -> Result<(String, bool, Option<String>), String> {
    let state = app.state::<Companion>();
    let pet = library::pet(&app.state::<State>().root, &job.pet)?;
    let token = format!("scheduled-{}", job.id);
    let _lease = state.host.lease(&token, &job.pet)?;
    let settings = state.settings.lock().unwrap().clone();
    let (turn, topic) = begin_delivery(&state.dir, job, chat::now()).map_err(|e| e.to_string())?;
    state.host.bind_turn(&token, turn)?;
    let result = (|| {
        let books = crate::memory::read(&state.dir, &job.pet)?;
        let personality = crate::persona::get(&state.dir, &job.pet, &pet.description)?;
        let catalog = crate::documents::catalog(&state.host.library)?;
        let mut servers = json!(state.host.external.config().enabled);
        servers
            .as_array_mut()
            .unwrap()
            .extend(crate::tool_cards::servers(&app.state::<State>().root)?);
        state.client()?.call("chat",json!({"token":token,"scheduled":true,"taskZone":job.zone.as_deref().filter(|z|*z!="local"),"topic":topic,"text":job.instruction,"webUrls":[],"libraryEnabled":true,"mcpServers":servers,"pet":{"displayName":pet.display_name,"description":pet.description,"personality":personality},"petActions":crate::pet_action::choices(&app.state::<State>().root,&job.pet),"sections":{"profile":books.profile,"user":if settings.memory{books.user_text()}else{String::new()},"notes":if settings.memory{books.notes_text()}else{String::new()},"catalog":catalog}}))
    })();
    let text = match &result {
        Ok(v) if v["text"].as_str().is_some_and(|s| !s.trim().is_empty()) => {
            v["text"].as_str().unwrap().to_owned()
        }
        Ok(_) => t("host.taskNoResult").into(),
        Err(e) => crate::locale::tf("host.taskFailed", &[("e", &e)]),
    };
    let v = result.as_ref().ok();
    history::finish_with_tools(
        &state.dir,
        turn,
        &text,
        v.and_then(|r| r.get("sources")),
        v.and_then(|r| r.get("steps")),
    )
    .map_err(|e| e.to_string())?;
    let _ = app.emit("chat-updated", ());
    let action = v
        .and_then(|r| r["petAction"]["action"].as_str())
        .map(str::to_owned);
    Ok((
        text,
        result.is_ok()
            && v.is_some_and(|r| r["text"].as_str().is_some_and(|s| !s.trim().is_empty())),
        action,
    ))
}
pub fn dispatch(app: &AppHandle, db: &mut Connection) -> Result<(), String> {
    if db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM task_runs WHERE status='running')",
            [],
            |r| r.get::<_, bool>(0),
        )
        .map_err(|e| e.to_string())?
    {
        return Ok(());
    }
    if let Some(job) = claim(db).map_err(|e| e.to_string())? {
        let app = app.clone();
        std::thread::spawn(move || {
            let (text, ok, action) = execute(&app, &job).unwrap_or_else(|e| {
                (
                    crate::locale::tf("host.taskFailed", &[("e", &e)]),
                    false,
                    None,
                )
            });
            let state = app.state::<Companion>();
            if let Ok(db) = reminders::db(&state.dir) {
                if let Some(action) = action.filter(|_| ok) {
                    let _ = db.execute(
                        "INSERT OR REPLACE INTO task_actions(run,action) VALUES(?,?)",
                        params![job.id, action],
                    );
                }
                let _ = db.execute(
                    "UPDATE task_runs SET status=?,result=? WHERE id=?",
                    params![if ok { "done" } else { "failed" }, text, job.id],
                );
            }
            state.host.alarm.changed();
        });
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn due_task_waits_for_result_and_claims_once() {
        let d = tempfile::tempdir().unwrap();
        let mut db = reminders::db(d.path()).unwrap();
        let tx = db.transaction().unwrap();
        tx.execute("INSERT INTO reminders(id,pet,message,rule,request_key) VALUES(1,'cat','查义乌天气','{}','test')",[]).unwrap();
        mode(&tx, 1, "agent").unwrap();
        enqueue(&tx, 1, 1200).unwrap();
        enqueue(&tx, 1, 1200).unwrap();
        tx.commit().unwrap();
        assert_eq!(claim(&mut db).unwrap().unwrap().instruction, "查义乌天气");
        assert!(claim(&mut db).unwrap().is_none());
    }
}

#[cfg(test)]
mod origin_tests {
    use super::*;
    #[test]
    fn result_returns_to_creator_while_another_topic_is_open() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let (first, _) = history::begin(dir, "cat", "帮我做调研", 10).unwrap();
        let source = history::topic_and_note(dir, first).unwrap().0;
        history::close(dir, "cat").unwrap();
        let (second, _) = history::begin(dir, "cat", "另一个话题", 20).unwrap();
        let current = history::topic_and_note(dir, second).unwrap().0;
        let (report, topic) =
            history::begin_scheduled(dir, "cat", "调研", 30, Some(source)).unwrap();
        history::finish(dir, report, "报告正文").unwrap();
        assert_eq!(topic, source);
        assert_eq!(
            crate::topics::current(dir, "cat", 30).unwrap(),
            Some(current)
        );
    }
}

#[cfg(test)]
mod deletion_tests {
    use super::*;
    use crate::{schedule::Schedule, topics};
    #[test]
    fn confirmed_task_set_is_preserved_rerouted_or_removed_together() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let (turn, _) = history::begin(dir, "p", "旧话题", 1).unwrap();
        let old = history::topic_and_note(dir, turn).unwrap().0;
        let create = |key: &str, origin| {
            reminders::create_mode(
                dir,
                "p",
                key,
                Schedule::Interval { seconds: 60 },
                key,
                1,
                "agent",
                origin,
                Some(key),
            )
            .unwrap()["id"]
                .as_i64()
                .unwrap()
        };
        let a = create("天气", Some(old));
        let b = create("周报", Some(old));
        let other = create("其他", None);
        assert!(topics::delete_with_tasks(dir, old, true, &[a]).is_err());
        assert_eq!(topics::linked_tasks(dir, old).unwrap().len(), 2);
        topics::delete_with_tasks(dir, old, false, &[a, b]).unwrap();
        let deliver = |reminder, at| {
            begin_delivery(
                dir,
                &Job {
                    id: at,
                    pet: "p".into(),
                    instruction: "交付".into(),
                    reminder,
                    zone: None,
                },
                at,
            )
            .unwrap()
            .1
        };
        let new = deliver(a, 100);
        assert_ne!(new, old);
        assert_eq!(new, deliver(a, 200));
        assert_eq!(new, deliver(b, 300));
        assert_eq!(topics::linked_tasks(dir, new).unwrap().len(), 2);
        {
            let mut db = reminders::db(dir).unwrap();
            let tx = db.transaction().unwrap();
            enqueue(&tx, a, 400).unwrap();
            tx.commit().unwrap();
        }
        topics::delete_with_tasks(dir, new, true, &[a, b]).unwrap();
        let db = reminders::db(dir).unwrap();
        let ids: Vec<i64> = db
            .prepare("SELECT id FROM reminders")
            .unwrap()
            .query_map([], |r| r.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(ids, vec![other]);
        assert_eq!(
            db.query_row("SELECT count(*) FROM task_runs", [], |r| r.get::<_, i64>(0))
                .unwrap(),
            0
        );
        assert!(topics::linked_tasks(dir, new).unwrap().is_empty());
    }
}
