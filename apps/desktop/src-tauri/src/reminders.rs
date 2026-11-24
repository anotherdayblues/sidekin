use crate::locale::t;
use crate::{
    chat,
    companion::Companion,
    schedule::{Result, Schedule},
};
use rusqlite::{params, Connection, TransactionBehavior};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    sync::mpsc,
    thread,
    time::Duration,
};
use tauri::{AppHandle, Emitter, Manager};

fn fail(e: rusqlite::Error) -> String {
    e.to_string()
}
pub(crate) fn db(dir: &Path) -> Result<Connection> {
    let db = Connection::open(dir.join("reminders.sqlite3")).map_err(fail)?;
    db.busy_timeout(Duration::from_secs(3)).map_err(fail)?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS reminders(
 id INTEGER PRIMARY KEY AUTOINCREMENT, pet TEXT NOT NULL, message TEXT NOT NULL, rule TEXT NOT NULL,
 next_at INTEGER, snooze_at INTEGER, local_zone TEXT, paused INTEGER NOT NULL DEFAULT 0,
 request_key TEXT NOT NULL, UNIQUE(pet,request_key));
 CREATE TABLE IF NOT EXISTS reminder_names(reminder INTEGER PRIMARY KEY REFERENCES reminders(id) ON DELETE CASCADE, name TEXT NOT NULL);
 CREATE INDEX IF NOT EXISTS next_reminder ON reminders(paused,next_at);
 CREATE TABLE IF NOT EXISTS pending(
 id INTEGER PRIMARY KEY AUTOINCREMENT, reminder INTEGER NOT NULL UNIQUE REFERENCES reminders(id) ON DELETE CASCADE,
 due INTEGER NOT NULL, missed INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1);").map_err(fail)?;
    crate::scheduled::schema(&db).map_err(fail)?;
    Ok(db)
}
fn local_zone() -> Result<String> {
    iana_time_zone::get_timezone().map_err(|_| t("host.noZone").into())
}
#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub id: i64,
    pub revision: i64,
    pub reminder: i64,
    pub pet: String,
    pub message: String,
    pub due: i64,
    pub missed: bool,
    /// The action the task picked for the pet, if any (plan/10 §8.2).
    #[serde(skip)]
    pub action: Option<String>,
}
#[derive(Deserialize, Debug)]
pub struct Receipt {
    pub id: i64,
    pub revision: i64,
}
pub fn create(
    dir: &Path,
    pet: &str,
    message: &str,
    rule: Schedule,
    key: &str,
    now: i64,
) -> Result<Value> {
    create_mode(dir, pet, message, rule, key, now, "notify", None, None)
}
pub fn create_mode(
    dir: &Path,
    pet: &str,
    message: &str,
    rule: Schedule,
    key: &str,
    now: i64,
    mode: &str,
    origin: Option<i64>,
    name: Option<&str>,
) -> Result<Value> {
    let msg = message.trim();
    if msg.is_empty() || msg.chars().count() > 1000 {
        return Err(t("host.reminderLength").into());
    }
    let local = local_zone()?;
    let mut db = db(dir)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(fail)?;
    use rusqlite::OptionalExtension;
    if let Some((id, at)) = tx
        .query_row(
            "SELECT id,next_at FROM reminders WHERE pet=? AND request_key=?",
            params![pet, key],
            |r| Ok((r.get::<_, i64>(0)?, r.get::<_, Option<i64>>(1)?)),
        )
        .optional()
        .map_err(fail)?
    {
        return Ok(json!({"id":id,"nextAt":at}));
    }
    let next = rule.first(now, &local)?;
    let spec = serde_json::to_string(&rule).map_err(|_| t("host.ruleBad"))?;
    tx.execute("INSERT INTO reminders(pet,message,rule,next_at,local_zone,request_key) VALUES(?,?,?,?,?,?)",params![pet,msg,spec,next,rule.local_zone().then_some(local),key]).map_err(fail)?;
    let id = tx.last_insert_rowid();
    let fallback: String = msg.chars().take(50).collect();
    let label = name
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .unwrap_or(fallback.trim());
    save_name(&tx, id, Some(label))?;
    crate::scheduled::mode(&tx, id, mode)?;
    if let Some(topic) = origin {
        tx.execute("INSERT INTO task_origins VALUES(?,?)", params![id, topic])
            .map_err(fail)?;
    }
    tx.commit().map_err(fail)?;
    Ok(json!({"id":id,"nextAt":next}))
}
fn save_name(tx: &rusqlite::Transaction, id: i64, name: Option<&str>) -> Result<()> {
    if let Some(name) = name {
        let name = name.trim();
        if name.is_empty() {
            return Ok(());
        }
        tx.execute("INSERT INTO reminder_names(reminder,name) VALUES(?,?) ON CONFLICT(reminder) DO UPDATE SET name=excluded.name",params![id,name]).map_err(fail)?;
    }
    Ok(())
}
pub fn list(dir: &Path, _pet: &str) -> Result<Value> {
    let db = db(dir)?;
    let mut q=db.prepare("SELECT r.id,r.message,r.rule,r.next_at,r.snooze_at,r.paused,p.id,coalesce((SELECT mode FROM task_modes WHERE reminder=r.id),'notify'),coalesce((SELECT name FROM reminder_names WHERE reminder=r.id),substr(r.message,1,50)) FROM reminders r LEFT JOIN pending p ON r.id=p.reminder ORDER BY r.paused,coalesce(r.snooze_at,r.next_at,9223372036854775807),r.id").map_err(fail)?;
    let rows=q.query_map([],|r|{
   let rule:String=r.get(2)?;
   Ok(json!({"id":r.get::<_,i64>(0)?,"message":r.get::<_,String>(1)?,"name":r.get::<_,String>(8)?,"mode":r.get::<_,String>(7)?,"rule":serde_json::from_str::<Value>(&rule).unwrap_or(Value::Null),"nextAt":r.get::<_,Option<i64>>(3)?,"snoozeAt":r.get::<_,Option<i64>>(4)?,"paused":r.get::<_,bool>(5)?,"pending":r.get::<_,Option<i64>>(6)?.is_some()}))
 }).map_err(fail)?.collect::<rusqlite::Result<Vec<_>>>().map_err(fail)?;
    Ok(json!(rows))
}
pub fn manage(dir: &Path, _pet: &str, id: i64, action: &str, now: i64) -> Result<()> {
    let mut db = db(dir)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(fail)?;
    let (spec, paused, at): (String, bool, Option<i64>) = tx
        .query_row(
            "SELECT rule,paused,next_at FROM reminders WHERE id=?",
            [id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .map_err(|_| t("host.reminderMissing"))?;
    match action {
        "run" => {
            crate::scheduled::enqueue(&tx, id, now).map_err(fail)?;
            tx.execute("INSERT INTO pending(reminder,due,missed) VALUES(?,?,0) ON CONFLICT(reminder) DO UPDATE SET revision=revision+1,due=excluded.due,missed=0",params![id,now]).map_err(fail)?;
        }
        "delete" => {
            tx.execute("DELETE FROM reminders WHERE id=?", [id])
                .map_err(fail)?;
        }
        "pause" if !paused => {
            tx.execute(
                "DELETE FROM task_runs WHERE reminder=? AND status='queued'",
                [id],
            )
            .map_err(fail)?;
            tx.execute(
                "UPDATE reminders SET paused=1,snooze_at=NULL WHERE id=?",
                [id],
            )
            .map_err(fail)?;
            tx.execute("DELETE FROM pending WHERE reminder=?", [id])
                .map_err(fail)?;
        }
        "resume" if paused => {
            let rule: Schedule =
                serde_json::from_str(&spec).map_err(|_| t("host.reminderRuleBad"))?;
            let local = local_zone()?;
            let next = if matches!(rule, Schedule::Once { .. }) {
                at.unwrap_or(now)
            } else {
                rule.first(now, &local)?
            };
            tx.execute(
                "UPDATE reminders SET paused=0,next_at=?,local_zone=? WHERE id=?",
                params![next, rule.local_zone().then_some(local), id],
            )
            .map_err(fail)?;
        }
        "resume" | "pause" => {}
        _ => return Err(t("host.reminderOp").into()),
    }
    tx.commit().map_err(fail)
}
fn pending(db: &Connection) -> Result<Vec<Notice>> {
    let mut stmt=db.prepare("SELECT p.id,p.revision,r.id,r.pet,coalesce(j.result,r.message),p.due,p.missed,(SELECT action FROM task_actions WHERE run=j.id) FROM pending p JOIN reminders r ON r.id=p.reminder LEFT JOIN task_runs j ON j.reminder=r.id AND j.due=p.due WHERE j.id IS NULL OR j.status IN ('done','failed') ORDER BY p.due,r.id").map_err(fail)?;
    let rows = stmt
        .query_map([], |r| {
            Ok(Notice {
                id: r.get(0)?,
                revision: r.get(1)?,
                reminder: r.get(2)?,
                pet: r.get(3)?,
                message: r.get(4)?,
                due: r.get(5)?,
                missed: r.get(6)?,
                action: r.get(7)?,
            })
        })
        .map_err(fail)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(fail)?;
    Ok(rows)
}
const DUE: &str =
    "paused=0 AND (next_at<=?1 OR snooze_at<=?1 OR (local_zone IS NOT NULL AND local_zone<>?2))";
fn advance(db: &mut Connection, now: i64, started: i64, local: &str) -> Result<Vec<Notice>> {
    let exists: bool = db
        .query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM reminders WHERE {DUE})"),
            params![now, local],
            |r| r.get(0),
        )
        .map_err(fail)?;
    if !exists {
        return pending(db);
    }
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(fail)?;
    let entries = tx
        .prepare(&format!(
            "SELECT id,rule,next_at,snooze_at,local_zone FROM reminders WHERE {DUE}"
        ))
        .map_err(fail)?
        .query_map(params![now, local], |r| {
            Ok((
                r.get::<_, i64>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<i64>>(2)?,
                r.get::<_, Option<i64>>(3)?,
                r.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(fail)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(fail)?;
    for (id, spec, mut next, mut snooze, zone) in entries {
        let rule: Schedule = serde_json::from_str(&spec).map_err(|_| t("host.reminderRuleBad"))?;
        if zone.as_deref().is_some_and(|z| z != local) {
            next = Some(rule.first(now, local)?);
        }
        let mut fire = None;
        if let Some(at) = next.filter(|at| *at <= now) {
            next = rule.following(at, now, local)?;
            if snooze.is_none() {
                fire = Some(at);
            }
        }
        if let Some(at) = snooze.filter(|at| *at <= now) {
            fire = Some(at);
            snooze = None;
        }
        if let Some(at) = fire {
            crate::scheduled::enqueue(&tx, id, at).map_err(fail)?;
            let missed = at < started || now - at > 5000;
            tx.execute("INSERT INTO pending(reminder,due,missed) VALUES(?,?,?) ON CONFLICT(reminder) DO UPDATE SET revision=revision+1,due=excluded.due,missed=max(pending.missed,excluded.missed)",params![id,at,missed]).map_err(fail)?;
        }
        tx.execute(
            "UPDATE reminders SET next_at=?,snooze_at=?,local_zone=? WHERE id=?",
            params![next, snooze, rule.local_zone().then_some(local), id],
        )
        .map_err(fail)?;
    }
    tx.commit().map_err(fail)?;
    pending(db)
}
fn resolve(dir: &Path, items: &[Receipt], snooze: bool, now: i64) -> Result<Vec<Notice>> {
    let mut db = db(dir)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(fail)?;
    for item in items {
        let reminder: i64 = tx
            .query_row(
                "SELECT reminder FROM pending WHERE id=? AND revision=?",
                params![item.id, item.revision],
                |r| r.get(0),
            )
            .map_err(|_| t("host.reminderChanged"))?;
        if snooze {
            tx.execute(
                "UPDATE reminders SET snooze_at=? WHERE id=?",
                params![now + 600000, reminder],
            )
            .map_err(fail)?;
        }
        tx.execute("DELETE FROM pending WHERE id=?", [item.id])
            .map_err(fail)?;
    }
    tx.commit().map_err(fail)?;
    pending(&db)
}

enum Signal {
    Stop,
    Changed,
}
#[derive(Default)]
pub struct Alarm(std::sync::Mutex<Option<mpsc::Sender<Signal>>>);
impl Alarm {
    pub fn changed(&self) {
        if let Some(tx) = self.0.lock().unwrap().as_ref() {
            let _ = tx.send(Signal::Changed);
        }
    }
}
pub struct Clock {
    stop: mpsc::Sender<Signal>,
    alarm: std::sync::Arc<Alarm>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Clock {
    pub fn start(app: AppHandle, dir: PathBuf, alarm: std::sync::Arc<Alarm>) -> Self {
        let started = chat::now();
        let (tx, rx) = mpsc::channel();
        *alarm.0.lock().unwrap() = Some(tx.clone());
        let worker = thread::spawn(move || {
            let mut connection = None;
            let mut visible = Vec::<Notice>::new();
            let mut errors = 0u32;
            loop {
                let result = (|| {
                    if connection.is_none() {
                        connection = Some(db(&dir)?);
                    }
                    crate::scheduled::dispatch(&app, connection.as_mut().unwrap())?;
                    advance(
                        connection.as_mut().unwrap(),
                        chat::now(),
                        started,
                        &local_zone()?,
                    )
                })();
                match result {
                    Ok(notices) => {
                        errors = 0;
                        let new_due = notices.iter().any(|n| {
                            !visible
                                .iter()
                                .any(|v| v.id == n.id && v.revision == n.revision)
                        });
                        // 番茄钟 may hold them until the break; they stay pending.
                        let held = new_due && crate::focus::holds_reminders(&app);
                        if !held && notices != visible && publish(&app, &notices, new_due).is_ok() {
                            visible = notices;
                        }
                    }
                    Err(_) => {
                        connection = None;
                        errors += 1;
                        if errors == 1 {
                            crate::brain::log(&dir.join("logs"), "reminder scheduler unavailable");
                            let _ = app.emit("reminder-error", t("host.clockDown"));
                        }
                    }
                }
                // Wake on edits or the nearest deadline. Periodically recheck the
                // local zone and wall clock after a clock adjustment or machine sleep.
                let wait = if errors > 0 {
                    2000
                } else {
                    let next:Option<i64>=connection.as_ref().and_then(|db|db.query_row(
                        "SELECT min(at) FROM (SELECT min(next_at) at FROM reminders WHERE paused=0 UNION ALL SELECT min(snooze_at) FROM reminders WHERE paused=0)",
                        [],|r|r.get(0)).ok().flatten());
                    next.map(|at| (at - chat::now()).clamp(1, 5000) as u64)
                        .unwrap_or(5000)
                };
                match rx.recv_timeout(Duration::from_millis(wait)) {
                    Ok(Signal::Changed) | Err(mpsc::RecvTimeoutError::Timeout) => {}
                    Ok(Signal::Stop) | Err(mpsc::RecvTimeoutError::Disconnected) => break,
                }
            }
        });
        Self {
            stop: tx,
            alarm,
            worker: Some(worker),
        }
    }
}
impl Drop for Clock {
    fn drop(&mut self) {
        self.alarm.0.lock().unwrap().take();
        let _ = self.stop.send(Signal::Stop);
        if let Some(w) = self.worker.take() {
            let _ = w.join();
        }
    }
}
fn publish(app: &AppHandle, items: &[Notice], new_due: bool) -> Result<()> {
    let bubble = app.get_webview_window("bubble").ok_or("disabled")?;
    if new_due {
        if !bubble.is_visible().map_err(|_| t("host.bubbleDown"))? {
            chat::show(app, json!({"mode":"reminder","at":chat::now()}), false)?;
        }
        // A task that picked an action plays it instead of the jump, when the
        // pet showing now has it.
        let mut motion = json!({"kind":"reminder"});
        if let (Some(action), Ok((pet, ..))) = (
            items.iter().find_map(|n| n.action.as_deref()),
            chat::pet(app),
        ) {
            let root = app.state::<crate::State>().root.clone();
            if let Some(play) = crate::pet_action::for_reminder(&root, &pet, action) {
                motion["action"] = play["action"].clone();
                motion["sleep"] = play["sleep"].clone();
            }
        }
        // During a tomato the reminder comes quietly: no jump, no voice.
        let quiet = crate::focus::active(app);
        if !quiet {
            let _ = app.emit_to("pet", "companion-motion", motion);
        }
        // 宠物声音: the pet says the first one.
        if let (Some(first), false) = (items.first(), quiet) {
            crate::voice::speak_if_on(app, &first.message);
        }
        crate::brain::log(
            &app.state::<Companion>().dir.join("logs"),
            &format!("reminder delivery: {} items", items.len()),
        );
    }
    app.emit_to("bubble", "reminders-due", items)
        .map_err(|e| e.to_string())?;
    let _ = app.emit_to("studio", "reminders-changed", ());
    Ok(())
}
#[tauri::command]
pub async fn list_reminders(app: AppHandle) -> Result<Value> {
    let dir = app.state::<Companion>().dir.clone();
    let pet = chat::pet(&app)?.0;
    tauri::async_runtime::spawn_blocking(move || list(&dir, &pet))
        .await
        .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn edit_reminder(
    app: AppHandle,
    id: i64,
    name: Option<String>,
    message: String,
    mode: String,
    schedule: Option<Schedule>,
) -> Result<()> {
    let state = app.state::<Companion>();
    edit(
        &state.dir,
        id,
        &message,
        &mode,
        schedule,
        chat::now(),
        name.as_deref(),
    )?;
    state.host.alarm.changed();
    let _ = app.emit("reminders-changed", ());
    Ok(())
}
pub fn edit(
    dir: &Path,
    id: i64,
    text: &str,
    mode: &str,
    schedule: Option<Schedule>,
    now: i64,
    name: Option<&str>,
) -> Result<()> {
    patch(dir, id, Some(text), Some(mode), schedule, now, name)
}
pub fn patch(
    dir: &Path,
    id: i64,
    text: Option<&str>,
    mode: Option<&str>,
    schedule: Option<Schedule>,
    now: i64,
    name: Option<&str>,
) -> Result<()> {
    let msg = text.map(str::trim);
    if msg.is_some_and(|m| m.is_empty() || m.chars().count() > 1000) {
        return Err(t("host.taskLength").into());
    }
    let mut db = db(dir)?;
    let tx = db
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(fail)?;
    if tx
        .execute(
            "UPDATE reminders SET message=coalesce(?,message) WHERE id=?",
            params![msg, id],
        )
        .map_err(fail)?
        != 1
    {
        return Err(t("host.taskMissing").into());
    }
    let execution_changed = msg.is_some() || mode.is_some() || schedule.is_some();
    if let Some(rule) = schedule {
        let local = local_zone()?;
        let next = rule.first(now, &local)?;
        tx.execute(
            "UPDATE reminders SET rule=?,next_at=?,snooze_at=NULL,local_zone=? WHERE id=?",
            params![
                serde_json::to_string(&rule).map_err(|e| e.to_string())?,
                next,
                rule.local_zone().then_some(local),
                id
            ],
        )
        .map_err(fail)?;
    }
    if execution_changed {
        tx.execute("DELETE FROM pending WHERE reminder=?", [id])
            .map_err(fail)?;
        tx.execute(
            "DELETE FROM task_runs WHERE reminder=? AND status='queued'",
            [id],
        )
        .map_err(fail)?;
    }
    save_name(&tx, id, name)?;
    if let Some(mode) = mode {
        crate::scheduled::mode(&tx, id, mode)?;
    }
    tx.commit().map_err(fail)
}
#[tauri::command]
pub async fn manage_reminder(
    app: AppHandle,
    pet_id: String,
    id: i64,
    action: String,
) -> Result<()> {
    if chat::pet(&app)?.0 != pet_id {
        return Err(t("host.petSwitchedShort").into());
    }
    let dir = app.state::<Companion>().dir.clone();
    tauri::async_runtime::spawn_blocking(move || manage(&dir, &pet_id, id, &action, chat::now()))
        .await
        .map_err(|e| e.to_string())??;
    app.state::<Companion>().host.alarm.changed();
    Ok(())
}
#[tauri::command]
pub fn pending_reminders(app: AppHandle) -> Result<Vec<Notice>> {
    let state = app.state::<Companion>();
    if !state
        .host
        .reminders
        .load(std::sync::atomic::Ordering::Acquire)
    {
        return Ok(vec![]);
    }
    pending(&db(&state.dir)?)
}
#[tauri::command]
pub async fn resolve_reminders(
    app: AppHandle,
    items: Vec<Receipt>,
    snooze: bool,
) -> Result<Vec<Notice>> {
    let dir = app.state::<Companion>().dir.clone();
    let remaining =
        tauri::async_runtime::spawn_blocking(move || resolve(&dir, &items, snooze, chat::now()))
            .await
            .map_err(|e| e.to_string())??;
    app.state::<Companion>().host.alarm.changed();
    Ok(remaining)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_finished_task_brings_its_pet_action_to_the_notice() {
        let d = tempfile::tempdir().unwrap();
        let db = db(d.path()).unwrap();
        db.execute_batch("INSERT INTO reminders(id,pet,message,rule,request_key) VALUES(1,'cat','下班','{}','a'),(2,'cat','喝水','{}','b');
            INSERT INTO pending(reminder,due,missed) VALUES(1,100,0),(2,100,0);
            INSERT INTO task_runs(id,reminder,due,instruction,pet,mode,status,result) VALUES(7,1,100,'下班，跳个舞','cat','agent','done','快下班啦');
            INSERT INTO task_actions(run,action) VALUES(7,'dance');").unwrap();
        let notices = pending(&db).unwrap();
        assert_eq!(notices[0].message, "快下班啦");
        assert_eq!(notices[0].action.as_deref(), Some("dance"));
        assert_eq!(notices[1].action, None, "a plain reminder has no action");
        // The bubble never sees it.
        assert!(serde_json::to_value(&notices[0])
            .unwrap()
            .get("action")
            .is_none());
    }
    fn once(s: u64) -> Schedule {
        Schedule::Once {
            at: None,
            after_seconds: Some(s),
        }
    }
    fn ack(n: &Notice) -> Receipt {
        Receipt {
            id: n.id,
            revision: n.revision,
        }
    }
    #[test]
    fn unnamed_job_keeps_its_fallback_title_when_instruction_changes() {
        let d = tempfile::tempdir().unwrap();
        let text = format!("{}  完整任务", "猫".repeat(48));
        let job = create_mode(
            d.path(),
            "cat",
            &text,
            once(60),
            "one",
            0,
            "agent",
            None,
            None,
        )
        .unwrap();
        let id = job["id"].as_i64().unwrap();
        edit(d.path(), id, "更新后的指令", "agent", None, 1, None).unwrap();
        assert_eq!(list(d.path(), "cat").unwrap()[0]["name"], "猫".repeat(48));
    }
    #[test]
    fn title_and_instruction_remain_independent_on_edit() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let job = create_mode(
            dir,
            "cat",
            "请阅读资料并写报告",
            once(60),
            "one",
            0,
            "agent",
            None,
            Some("市场周报"),
        )
        .unwrap();
        let id = job["id"].as_i64().unwrap();
        let row = &list(dir, "cat").unwrap()[0];
        assert_eq!(row["name"], "市场周报");
        assert_eq!(row["message"], "请阅读资料并写报告");
        edit(
            dir,
            id,
            "请阅读资料并写报告",
            "agent",
            None,
            1,
            Some("采购周报"),
        )
        .unwrap();
        let updated = &list(dir, "cat").unwrap()[0];
        assert_eq!(updated["name"], "采购周报");
        assert_eq!(updated["nextAt"], row["nextAt"]);
        assert_eq!(updated["message"], row["message"]);
    }
    #[test]
    fn offline_batch_survives_restart_and_snoozes_once() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let a = create(dir, "cat", "水", once(1), "a", 0).unwrap();
        assert_eq!(
            create(dir, "cat", "水", once(1), "a", 20).unwrap()["id"],
            a["id"]
        );
        create(dir, "cat", "茶", once(2), "b", 0).unwrap();
        let batch = advance(&mut db(dir).unwrap(), 15000, 14000, "UTC").unwrap();
        assert_eq!(batch.len(), 2);
        assert!(batch.iter().all(|x| x.missed));
        assert_eq!(
            advance(&mut db(dir).unwrap(), 16000, 15000, "UTC").unwrap(),
            batch
        );
        resolve(dir, &[ack(&batch[0])], true, 16000).unwrap();
        resolve(dir, &[ack(&batch[1])], false, 16000).unwrap();
        assert!(advance(&mut db(dir).unwrap(), 615999, 20000, "UTC")
            .unwrap()
            .is_empty());
        let due = advance(&mut db(dir).unwrap(), 616000, 20000, "UTC").unwrap();
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].message, "水");
        assert!(resolve(dir, &[ack(&batch[0])], false, 616000).is_err());
    }
    #[test]
    fn pause_cancel_and_coalesce_recurring() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let id = create(
            dir,
            "cat",
            "转圈",
            Schedule::Interval { seconds: 5 },
            "a",
            0,
        )
        .unwrap()["id"]
            .as_i64()
            .unwrap();
        let first = advance(&mut db(dir).unwrap(), 5000, 0, "UTC").unwrap();
        let merged = advance(&mut db(dir).unwrap(), 31000, 30000, "UTC").unwrap();
        assert_eq!(merged.len(), 1);
        assert!(resolve(dir, &[ack(&first[0])], false, 32000).is_err());
        assert_eq!(list(dir, "dog").unwrap()[0]["id"], id);
        manage(dir, "cat", id, "pause", 32000).unwrap();
        assert!(advance(&mut db(dir).unwrap(), 80000, 0, "UTC")
            .unwrap()
            .is_empty());
        manage(dir, "cat", id, "resume", 80000).unwrap();
        assert_eq!(list(dir, "cat").unwrap()[0]["nextAt"], 85000);
        manage(dir, "cat", id, "delete", 81000).unwrap();
        assert_eq!(list(dir, "cat").unwrap(), json!([]));
    }
    #[test]
    fn device_zone_change_reschedules_only_floating_wall_times() {
        let d = tempfile::tempdir().unwrap();
        let dir = d.path();
        let now = chat::now();
        let rule = Schedule::Daily {
            hour: 9,
            minute: 0,
            zone: None,
        };
        create(dir, "cat", "浮动", rule.clone(), "a", now).unwrap();
        let fixed = Schedule::Daily {
            hour: 9,
            minute: 0,
            zone: Some("Asia/Shanghai".into()),
        };
        create(dir, "cat", "固定", fixed.clone(), "b", now).unwrap();
        for zone in ["America/New_York", "Asia/Shanghai"] {
            advance(&mut db(dir).unwrap(), now, now, zone).unwrap();
            for row in list(dir, "cat").unwrap().as_array().unwrap() {
                let rule = if row["message"] == "浮动" {
                    &rule
                } else {
                    &fixed
                };
                assert_eq!(row["nextAt"], rule.first(now, zone).unwrap());
            }
        }
    }
}
