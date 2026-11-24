//! 待办 (plan/27, an experiment): to-dos with an optional day, time and
//! repeat; an alert at the time, in the bubble; tomatoes counted on the
//! to-do they were on. Works with 伙伴大脑 off. Everything lives here and in
//! `todos.sqlite3`: the rest of the app only calls in (focus, the pet's
//! menu, the brain's tool), so it can be taken out as one piece.
mod plan;
mod store;
mod when;

use crate::chat;
use crate::companion::Companion;
use serde_json::{json, Value};
use std::path::PathBuf;
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use store::{Fields, Now, Result, Todo};
use tauri::{AppHandle, Emitter, Listener, Manager};

pub struct Todos {
    dir: PathBuf,
    wake: Mutex<Option<mpsc::Sender<()>>>,
}

fn todos(app: &AppHandle) -> tauri::State<'_, Todos> {
    app.state::<Todos>()
}
fn db(app: &AppHandle) -> Result<rusqlite::Connection> {
    store::open(&todos(app).dir)
}
fn local(day: chrono::NaiveDate, time: chrono::NaiveTime) -> Option<i64> {
    when::alert_at(&chrono::Local, day, time)
}
fn now() -> Now<'static> {
    Now {
        ms: chat::now(),
        today: chrono::Local::now().date_naive(),
        at: &local,
    }
}
/// Every window redraws, and the clock looks at the alerts again.
fn changed(app: &AppHandle) {
    let _ = app.emit("todos-changed", ());
    if let Some(tx) = todos(app).wake.lock().unwrap().as_ref() {
        let _ = tx.send(());
    }
}
/// Done: the pet waves (the user did it, so even during a tomato).
fn cheer(app: &AppHandle) {
    let _ = app.emit_to("pet", "todo-done", ());
}

/// At start: the store, the alert clock, and tomatoes counted as they end.
pub fn setup(app: &AppHandle) {
    let dir = app.state::<Companion>().dir.clone();
    app.manage(Todos {
        dir: dir.clone(),
        wake: Mutex::new(None),
    });
    if let Ok(db) = store::open(&dir) {
        let _ = store::realign(&db, &now());
    }
    let handle = app.clone();
    app.listen_any("focus-changed", move |e| {
        let payload = serde_json::from_str::<Value>(e.payload()).unwrap_or_default();
        let moment = payload["moment"].as_str();
        let Ok(db) = db(&handle) else { return };
        // Every session that ended, finished or not: what it was spent on.
        // Windows that drew the session before this was written draw again.
        let mut redraw = false;
        if let Some(at) = payload["ended"]["at"].as_i64() {
            redraw |= store::spent(&db, at).is_ok();
        }
        match moment {
            Some("Finished" | "FinishedAway") => redraw |= store::tomato(&db).is_ok(),
            // Keep the last task available in the next session's picker.
            _ => {}
        }
        if redraw {
            let _ = handle.emit("todos-changed", ());
        }
    });
    let (tx, rx) = mpsc::channel();
    *todos(app).wake.lock().unwrap() = Some(tx);
    let app = app.clone();
    std::thread::spawn(move || clock(app, rx));
}

/// Wakes at the next alert, and on every change. With alerts ahead it
/// looks again at least every half minute (a sleeping machine's clock
/// jumps); with none it only wakes on a change, or every ten minutes.
/// Alerts that go off during a tomato wait if the user asked reminders to
/// wait for the break. One connection, kept open.
fn clock(app: AppHandle, rx: mpsc::Receiver<()>) {
    const AHEAD: i64 = 30_000;
    const IDLE: i64 = 600_000;
    let mut shown: Vec<i64> = Vec::new();
    let mut db: Option<rusqlite::Connection> = None;
    loop {
        let n = now();
        let mut wait = IDLE;
        if db.is_none() {
            db = store::open(&todos(&app).dir).ok();
        }
        if let Some(c) = &db {
            // A new day: missed repeating ones move on, and windows redraw.
            let _ = store::roll(c, &n);
            let ok = store::fire(c, n.ms).is_ok();
            let due = store::pending(c, n.today).unwrap_or_default();
            let ids: Vec<i64> = due.iter().map(|t| t.id).collect();
            let new = ids.iter().any(|id| !shown.contains(id));
            if new && crate::focus::holds_reminders(&app) {
                wait = 5_000;
            } else {
                if new && alert(&app, &due).is_ok() {
                    let _ = app.emit("todos-changed", ());
                }
                shown = ids;
            }
            match store::wake(c) {
                Ok(Some(at)) => wait = wait.min((at - n.ms).clamp(1, AHEAD)),
                Ok(None) => {}
                Err(_) => db = None,
            }
            if !ok {
                db = None;
            }
        }
        if db.is_none() {
            wait = 5_000;
        }
        match rx.recv_timeout(Duration::from_millis(wait as u64)) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
        }
    }
}
/// The bubble shows what went off; the pet jumps and says the first one,
/// as for a reminder, except quietly during a tomato.
fn alert(app: &AppHandle, due: &[Todo]) -> Result<()> {
    let visible = app
        .get_webview_window("bubble")
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    if visible {
        app.emit_to("bubble", "todo-due", ())
            .map_err(|e| e.to_string())?;
    } else {
        chat::show(
            app,
            json!({"mode":"todo","todo":"due","at":chat::now()}),
            false,
        )?;
    }
    if !crate::focus::active(app) {
        let _ = app.emit_to("pet", "companion-motion", json!({"kind":"reminder"}));
        if let Some(first) = due.first() {
            crate::voice::speak_if_on(app, &first.title);
        }
    }
    Ok(())
}

/// The next tomato is on `id`, or on nothing.
pub fn focus_on(app: &AppHandle, id: Option<i64>) -> Result<()> {
    let db = db(app)?;
    if let Some(id) = id {
        store::get(&db, id, now().today)?;
    }
    store::set_focus(&db, id)?;
    changed(app);
    Ok(())
}
/// Starts a tomato on `id`, or on nothing.
fn start_focus(app: &AppHandle, id: Option<i64>, minutes: Option<u32>) -> Result<Value> {
    focus_on(app, id)?;
    Ok(crate::focus::focus_start(app.clone(), minutes))
}
/// Every list as of now: a repeating one missed on an earlier day has
/// moved on first (store::roll).
fn list(db: &rusqlite::Connection) -> Result<Vec<Todo>> {
    let n = now();
    store::roll(db, &n)?;
    store::list(db, n.today)
}

#[tauri::command]
pub fn todo_list(app: AppHandle) -> Result<Vec<Todo>> {
    list(&db(&app)?)
}
/// Whether 伙伴大脑 is on: the to-do helpers (plan/31) show only then.
#[tauri::command]
pub fn todo_ai_ready(app: AppHandle) -> bool {
    app.state::<Companion>().client().is_ok()
}
/// 伙伴大脑 drafts to-dos (plan/31): `mode` "split" reads a pasted
/// paragraph, "break" turns one to-do into steps. Only drafts: the user
/// picks what to add.
#[tauri::command]
pub async fn todo_plan(app: AppHandle, text: String, mode: String) -> Result<Vec<plan::Draft>> {
    let action = match mode.as_str() {
        "split" => "todo-split",
        "break" => "todo-break",
        _ => return Err(crate::locale::t("host.todoMissing")),
    };
    let client = app.state::<Companion>().client()?;
    let input = plan::input(&text, now().today);
    let answer = tauri::async_runtime::spawn_blocking(move || {
        client.call("translate", json!({"text": input, "action": action}))
    })
    .await
    .map_err(|e| e.to_string())??;
    Ok(plan::drafts(answer["text"].as_str().unwrap_or("")))
}
/// Dragged into 今天 or 以后, before `before` or last (plan/30).
#[tauri::command]
pub fn todo_move(app: AppHandle, id: i64, today: bool, before: Option<i64>) -> Result<Todo> {
    let t = store::move_to(&db(&app)?, id, today, before, &now())?;
    changed(&app);
    Ok(t)
}
#[tauri::command]
pub fn todo_add(app: AppHandle, fields: Fields, source: Option<String>) -> Result<Todo> {
    let t = store::add(
        &db(&app)?,
        fields,
        source.as_deref().unwrap_or("app"),
        None,
        &now(),
    )?;
    // 待办 lights up in 它会的事 once one is added.
    crate::tips::used(&app, "todo");
    changed(&app);
    Ok(t)
}
#[tauri::command]
pub fn todo_update(app: AppHandle, id: i64, fields: Fields) -> Result<Todo> {
    let t = store::update(&db(&app)?, id, fields, &now())?;
    changed(&app);
    Ok(t)
}
#[tauri::command]
pub fn todo_complete(app: AppHandle, id: i64) -> Result<Todo> {
    let t = store::complete(&db(&app)?, id, &now())?;
    cheer(&app);
    changed(&app);
    Ok(t)
}
#[tauri::command]
pub fn todo_reopen(app: AppHandle, id: i64) -> Result<Todo> {
    let t = store::reopen(&db(&app)?, id, &now())?;
    changed(&app);
    Ok(t)
}
#[tauri::command]
pub fn todo_remove(app: AppHandle, id: i64) -> Result<()> {
    store::remove(&db(&app)?, id)?;
    changed(&app);
    Ok(())
}
/// What went off and waits for an answer in the bubble.
#[tauri::command]
pub fn todo_pending(app: AppHandle) -> Result<Vec<Todo>> {
    store::pending(&db(&app)?, now().today)
}
/// The bubble's answer: "done", "snooze10", "snooze60", "tonight",
/// "tomorrow" or "dismiss".
#[tauri::command]
pub fn todo_answer(app: AppHandle, ids: Vec<i64>, action: String) -> Result<Vec<Todo>> {
    let db = db(&app)?;
    store::answer(&db, &ids, &action, &now())?;
    if action == "done" {
        cheer(&app);
    }
    changed(&app);
    store::pending(&db, now().today)
}
/// The to-do the running tomato is on, and the open ones it could be on.
#[tauri::command]
pub fn todo_focus_state(app: AppHandle) -> Result<Value> {
    let db = db(&app)?;
    let n = now();
    let choices = store::focus_candidates(&db, &n)?;
    let current = store::focus_on(&db, n.today)?;
    Ok(json!({"current": current, "candidates": choices}))
}
/// What the focus sessions begun since `from` (ms) were spent on.
#[tauri::command]
pub fn todo_spent(app: AppHandle, from: i64) -> Result<Value> {
    let spent = store::spent_since(&db(&app)?, from)?;
    Ok(json!(spent
        .into_iter()
        .map(|(at, title)| json!({"at": at, "title": title}))
        .collect::<Vec<_>>()))
}
#[tauri::command]
pub fn todo_focus(app: AppHandle, id: Option<i64>) -> Result<Value> {
    start_focus(&app, id, None)
}
/// With a task to choose from, ask before starting. Otherwise just time.
#[tauri::command]
pub fn todo_start_from_menu(app: AppHandle) -> Result<()> {
    if store::focus_candidates(&db(&app)?, &now())?.is_empty() {
        start_focus(&app, None, None)?;
        return Ok(());
    }
    chat::show(
        &app,
        json!({"mode":"todo","todo":"pick","at":chat::now()}),
        true,
    )
}
/// The running tomato is on `id` from now on (换一件).
#[tauri::command]
pub fn todo_focus_set(app: AppHandle, id: Option<i64>) -> Result<()> {
    focus_on(&app, id)
}
/// 待办… from the pet's menu: the line to add one, over today's list.
#[tauri::command]
pub fn todo_today_from_menu(app: AppHandle) -> Result<()> {
    chat::show(
        &app,
        json!({"mode":"todo","todo":"today","at":chat::now()}),
        true,
    )
}
/// The `todo` tool of 伙伴大脑 (apps/brain/src/todo.ts).
pub fn from_brain(app: &AppHandle, args: &Value) -> Result<Value> {
    let db = db(app)?;
    let n = now();
    let id = || {
        args["id"]
            .as_i64()
            .ok_or_else(|| "需要待办编号".to_string())
    };
    let fields = || Fields {
        title: args["title"].as_str().map(String::from),
        day: args["day"].as_str().map(String::from),
        time: args["time"].as_str().map(String::from),
        repeat: args["repeat"].as_str().map(String::from),
    };
    let one = |t: &Todo| {
        json!({"id":t.id,"title":t.title,"day":t.day,"time":t.time,"repeat":t.repeat,
               "group":t.group,"carried":t.carried,"tomatoes":t.tomatoes,"done":t.done_at.is_some()})
    };
    let out = match args["action"].as_str().unwrap_or("") {
        "list" => {
            let all = list(&db)?;
            return Ok(
                json!({"today": when::day_text(n.today), "todos": all.iter().map(one).collect::<Vec<_>>()}),
            );
        }
        "add" => {
            let key = args["key"].as_str();
            one(&store::add(&db, fields(), "brain", key, &n)?)
        }
        "update" => one(&store::update(&db, id()?, fields(), &n)?),
        "complete" => {
            let t = store::complete(&db, id()?, &n)?;
            cheer(app);
            json!({"todo": one(&t), "advanced": t.done_at.is_none()})
        }
        "remove" => {
            store::remove(&db, id()?)?;
            json!({"removed": true})
        }
        _ => return Err("未知待办操作".into()),
    };
    changed(app);
    Ok(out)
}
