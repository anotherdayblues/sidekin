//! 待办 on disk (plan/27): one row per to-do, a repeating one included
//! (done, it moves to its next day). Kept in its own file, `todos.sqlite3`,
//! apart from the reminders and tasks of 伙伴大脑, so the experiment can be
//! dropped without touching them.
use super::when::{self, Group, Repeat};
use chrono::{NaiveDate, NaiveTime};
use rusqlite::{params, Connection, OptionalExtension, Row};
use serde::Serialize;
use std::path::Path;

pub type Result<T> = std::result::Result<T, String>;
fn fail(e: rusqlite::Error) -> String {
    e.to_string()
}

/// Longest title kept, in characters.
pub const TITLE_MAX: usize = 200;
/// Done ones shown, the latest first.
const DONE_SHOWN: i64 = 30;

/// The clock a step runs at: now, today, and when a day and time come here.
pub struct Now<'a> {
    pub ms: i64,
    pub today: NaiveDate,
    pub at: &'a dyn Fn(NaiveDate, NaiveTime) -> Option<i64>,
}

#[derive(Serialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Todo {
    pub id: i64,
    pub title: String,
    /// YYYY-MM-DD, or none (以后, no day set).
    pub day: Option<String>,
    /// HH:MM: the alert goes off then.
    pub time: Option<String>,
    pub repeat: Option<Repeat>,
    pub done_at: Option<i64>,
    pub tomatoes: u32,
    /// Its alert went off and is waiting for an answer in the bubble.
    pub due: bool,
    pub group: Group,
    /// Open, from an earlier day: it carries on in 今天 (昨天的).
    pub carried: bool,
}

/// A new to-do, or the fields to change in one: `Some("")` clears a day,
/// time or repeat.
#[derive(Default, Debug, Clone, serde::Deserialize)]
#[serde(default)]
pub struct Fields {
    pub title: Option<String>,
    pub day: Option<String>,
    pub time: Option<String>,
    pub repeat: Option<String>,
}

pub fn open(dir: &Path) -> Result<Connection> {
    let db = Connection::open(dir.join("todos.sqlite3")).map_err(fail)?;
    db.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(fail)?;
    db.execute_batch(
        "PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
 CREATE TABLE IF NOT EXISTS todos(
 id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, day TEXT, time TEXT, repeat TEXT,
 alert_at INTEGER, snooze_at INTEGER, due_since INTEGER, done_at INTEGER,
 tomatoes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
 source TEXT NOT NULL DEFAULT 'app', request_key TEXT UNIQUE);
 CREATE INDEX IF NOT EXISTS todo_alerts ON todos(done_at, alert_at, snooze_at);
 CREATE TABLE IF NOT EXISTS focus_on(one INTEGER PRIMARY KEY CHECK(one=1),
 todo INTEGER REFERENCES todos(id) ON DELETE SET NULL);
 CREATE TABLE IF NOT EXISTS spent(at INTEGER PRIMARY KEY,
 todo INTEGER REFERENCES todos(id) ON DELETE SET NULL, title TEXT NOT NULL);",
    )
    .map_err(fail)?;
    ordered(&db)?;
    Ok(db)
}
/// The order the user drags (plan/30). Rows from before it keep the order
/// they had: by day, then time.
fn ordered(db: &Connection) -> Result<()> {
    let has: bool = db
        .prepare("SELECT 1 FROM pragma_table_info('todos') WHERE name='position'")
        .and_then(|mut q| q.exists([]))
        .map_err(fail)?;
    if !has {
        db.execute_batch(
            "ALTER TABLE todos ADD COLUMN position REAL;
             UPDATE todos SET position=(SELECT count(*) FROM todos o WHERE
               (o.day IS NULL, o.day, o.time IS NULL, o.time, o.id) <=
               (todos.day IS NULL, todos.day, todos.time IS NULL, todos.time, todos.id));",
        )
        .map_err(fail)?;
    }
    Ok(())
}

const COLUMNS: &str = "id,title,day,time,repeat,done_at,tomatoes,due_since";
fn read(r: &Row, today: NaiveDate) -> rusqlite::Result<Todo> {
    let day: Option<String> = r.get(2)?;
    let done_at: Option<i64> = r.get(5)?;
    let repeat: Option<String> = r.get(4)?;
    let date = day.as_deref().and_then(when::day);
    Ok(Todo {
        id: r.get(0)?,
        title: r.get(1)?,
        group: when::group(date, done_at.is_some(), today),
        carried: done_at.is_none() && date.is_some_and(|d| d < today),
        day,
        time: r.get(3)?,
        repeat: repeat.as_deref().and_then(Repeat::parse),
        done_at,
        tomatoes: r.get(6)?,
        due: r.get::<_, Option<i64>>(7)?.is_some(),
    })
}
pub fn get(db: &Connection, id: i64, today: NaiveDate) -> Result<Todo> {
    db.query_row(
        &format!("SELECT {COLUMNS} FROM todos WHERE id=?"),
        [id],
        |r| read(r, today),
    )
    .optional()
    .map_err(fail)?
    .ok_or_else(|| crate::locale::t("host.todoMissing"))
}

/// The day, time and repeat as stored: a time or a repeat needs a day, so
/// one without gets today.
fn settle(
    day: Option<String>,
    time: Option<String>,
    repeat: Option<String>,
    today: NaiveDate,
) -> Result<(Option<String>, Option<String>, Option<String>)> {
    let bad = || crate::locale::t("host.todoWhenBad");
    let time = match time.filter(|s| !s.is_empty()) {
        Some(s) => Some(when::time(&s).ok_or_else(bad)?.format("%H:%M").to_string()),
        None => None,
    };
    let repeat = match repeat.filter(|s| !s.is_empty() && s != "none") {
        Some(s) => Some(Repeat::parse(&s).ok_or_else(bad)?.name().to_string()),
        None => None,
    };
    let day = match day.filter(|s| !s.is_empty()) {
        Some(s) => Some(when::day_text(when::day(&s).ok_or_else(bad)?)),
        None if time.is_some() || repeat.is_some() => Some(when::day_text(today)),
        None => None,
    };
    Ok((day, time, repeat))
}
fn title(s: &str) -> Result<String> {
    let s = s.split_whitespace().collect::<Vec<_>>().join(" ");
    if s.is_empty() || s.chars().count() > TITLE_MAX {
        return Err(crate::locale::t("host.todoTitleBad"));
    }
    Ok(s)
}
/// When the alert of an open to-do goes off: its day at its time, if that
/// is still ahead.
fn alert(day: Option<&str>, time: Option<&str>, now: &Now) -> Option<i64> {
    let (day, time) = (when::day(day?)?, when::time(time?)?);
    (now.at)(day, time).filter(|at| *at > now.ms)
}

/// Adds one. A `key` the brain sends again returns the one it made before
/// (a retried tool call does not add it twice).
pub fn add(db: &Connection, f: Fields, source: &str, key: Option<&str>, now: &Now) -> Result<Todo> {
    if let Some(key) = key {
        let found: Option<i64> = db
            .query_row("SELECT id FROM todos WHERE request_key=?", [key], |r| {
                r.get(0)
            })
            .optional()
            .map_err(fail)?;
        if let Some(id) = found {
            return get(db, id, now.today);
        }
    }
    let title = title(f.title.as_deref().unwrap_or(""))?;
    let (day, time, repeat) = settle(f.day, f.time, f.repeat, now.today)?;
    let at = alert(day.as_deref(), time.as_deref(), now);
    // A new one goes last.
    db.execute(
        "INSERT INTO todos(title,day,time,repeat,alert_at,created_at,source,request_key,position)
         VALUES(?,?,?,?,?,?,?,?,(SELECT coalesce(max(position),0)+1 FROM todos))",
        params![title, day, time, repeat, at, now.ms, source, key],
    )
    .map_err(fail)?;
    get(db, db.last_insert_rowid(), now.today)
}

/// Changes what `f` names; a new day or time sets the alert again.
pub fn update(db: &Connection, id: i64, f: Fields, now: &Now) -> Result<Todo> {
    let old = get(db, id, now.today)?;
    let title = match f.title {
        Some(t) => title(&t)?,
        None => old.title,
    };
    let (day, time, repeat) = settle(
        f.day.or(old.day),
        f.time.or(old.time),
        f.repeat.or(old.repeat.map(|r| r.name().into())),
        now.today,
    )?;
    let at = if old.done_at.is_some() {
        None
    } else {
        alert(day.as_deref(), time.as_deref(), now)
    };
    db.execute(
        "UPDATE todos SET title=?,day=?,time=?,repeat=?,alert_at=?,snooze_at=NULL,due_since=NULL WHERE id=?",
        params![title, day, time, repeat, at, id],
    )
    .map_err(fail)?;
    get(db, id, now.today)
}

/// Done. A repeating one moves to its next day instead, and stays open.
pub fn complete(db: &Connection, id: i64, now: &Now) -> Result<Todo> {
    let t = get(db, id, now.today)?;
    if t.done_at.is_some() {
        return Ok(t);
    }
    match (t.repeat, t.day.as_deref().and_then(when::day)) {
        (Some(repeat), Some(day)) => {
            let next = when::day_text(when::next_day(repeat, day, now.today));
            let at = alert(Some(&next), t.time.as_deref(), now);
            db.execute(
                "UPDATE todos SET day=?,alert_at=?,snooze_at=NULL,due_since=NULL WHERE id=?",
                params![next, at, id],
            )
        }
        _ => db.execute(
            "UPDATE todos SET done_at=?,alert_at=NULL,snooze_at=NULL,due_since=NULL WHERE id=?",
            params![now.ms, id],
        ),
    }
    .map_err(fail)?;
    // Done with it: a tomato after this is on nothing until one is picked.
    db.execute("UPDATE focus_on SET todo=NULL WHERE todo=?", [id])
        .map_err(fail)?;
    get(db, id, now.today)
}
/// Back from 已完成 to its day.
pub fn reopen(db: &Connection, id: i64, now: &Now) -> Result<Todo> {
    let t = get(db, id, now.today)?;
    let at = alert(t.day.as_deref(), t.time.as_deref(), now);
    db.execute(
        "UPDATE todos SET done_at=NULL,alert_at=? WHERE id=?",
        params![at, id],
    )
    .map_err(fail)?;
    get(db, id, now.today)
}
/// Dragged (plan/30): into 今天 or 以后, before `before` or last. Into 今天
/// it is today's, its reminder time kept; into 以后 it loses a day that is
/// not ahead, and that day's reminder (a repeating one goes to its next
/// run instead). Within its group only its place changes.
pub fn move_to(
    db: &Connection,
    id: i64,
    today: bool,
    before: Option<i64>,
    now: &Now,
) -> Result<Todo> {
    let t = get(db, id, now.today)?;
    if t.done_at.is_some() {
        return Ok(t);
    }
    let date = t.day.as_deref().and_then(when::day);
    let (day, time) = match (today, t.repeat, date) {
        (true, _, d) if d != Some(now.today) => (Some(now.today), t.time.clone()),
        (false, Some(r), Some(d)) if d <= now.today => {
            (Some(when::next_day(r, d, now.today)), t.time.clone())
        }
        (false, None, Some(d)) if d <= now.today => (None, None),
        _ => (date, t.time.clone()),
    };
    let day = day.map(when::day_text);
    let place: f64 = match before.filter(|b| *b != id) {
        Some(b) => {
            let at: f64 = db
                .query_row("SELECT position FROM todos WHERE id=?", [b], |r| r.get(0))
                .optional()
                .map_err(fail)?
                .ok_or_else(|| crate::locale::t("host.todoMissing"))?;
            let prev: Option<f64> = db
                .query_row(
                    "SELECT max(position) FROM todos WHERE position<? AND id<>?",
                    params![at, id],
                    |r| r.get(0),
                )
                .map_err(fail)?;
            match prev {
                Some(p) => (p + at) / 2.0,
                None => at - 1.0,
            }
        }
        None => db
            .query_row(
                "SELECT coalesce(max(position),0)+1 FROM todos WHERE id<>?",
                [id],
                |r| r.get(0),
            )
            .map_err(fail)?,
    };
    let changed_day = day != t.day || time != t.time;
    let at = alert(day.as_deref(), time.as_deref(), now);
    if changed_day {
        db.execute(
            "UPDATE todos SET day=?,time=?,alert_at=?,snooze_at=NULL,due_since=NULL,position=? WHERE id=?",
            params![day, time, at, place, id],
        )
    } else {
        db.execute("UPDATE todos SET position=? WHERE id=?", params![place, id])
    }
    .map_err(fail)?;
    get(db, id, now.today)
}
/// A new day: a repeating one missed on an earlier day moves to its run on
/// or after today, so it never piles up and is never 昨天的. A one-off one
/// stays on its day and carries on in 今天.
pub fn roll(db: &Connection, now: &Now) -> Result<()> {
    let missed: Vec<(i64, String, String, Option<String>)> = db
        .prepare(
            "SELECT id,day,repeat,time FROM todos WHERE done_at IS NULL AND repeat IS NOT NULL AND day<?",
        )
        .map_err(fail)?
        .query_map([when::day_text(now.today)], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(fail)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(fail)?;
    let yesterday = now.today.pred_opt().unwrap_or(now.today);
    for (id, day, repeat, time) in missed {
        let (Some(day), Some(repeat)) = (when::day(&day), Repeat::parse(&repeat)) else {
            continue;
        };
        let next = when::day_text(when::next_day(repeat, day, yesterday));
        let at = alert(Some(&next), time.as_deref(), now);
        db.execute(
            "UPDATE todos SET day=?,alert_at=?,snooze_at=NULL,due_since=NULL WHERE id=?",
            params![next, at, id],
        )
        .map_err(fail)?;
    }
    Ok(())
}
pub fn remove(db: &Connection, id: i64) -> Result<()> {
    db.execute("DELETE FROM todos WHERE id=?", [id])
        .map_err(fail)?;
    Ok(())
}

/// Every open one and the latest done ones: 今天 (the ones carried on from
/// an earlier day first), 以后, each in the order the user dragged them;
/// then 已完成, the latest first. A time only says when to remind.
pub fn list(db: &Connection, today: NaiveDate) -> Result<Vec<Todo>> {
    let rows = |sql: &str| -> Result<Vec<Todo>> {
        db.prepare(sql)
            .map_err(fail)?
            .query_map([], |r| read(r, today))
            .map_err(fail)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(fail)
    };
    let mut open = rows(&format!(
        "SELECT {COLUMNS} FROM todos WHERE done_at IS NULL ORDER BY position, id"
    ))?;
    let order = |g: Group| match g {
        Group::Today => 0,
        Group::Later => 1,
        Group::Done => 2,
    };
    open.sort_by_key(|t| (order(t.group), !t.carried));
    open.extend(rows(&format!(
        "SELECT {COLUMNS} FROM todos WHERE done_at IS NOT NULL ORDER BY done_at DESC LIMIT {DONE_SHOWN}"
    ))?);
    Ok(open)
}

/// Alerts due by now go off: they wait for an answer. True if any did.
pub fn fire(db: &Connection, now: i64) -> Result<bool> {
    let n = db
        .execute(
            "UPDATE todos SET due_since=coalesce(due_since,min(coalesce(alert_at,?1),coalesce(snooze_at,?1))),alert_at=NULL,snooze_at=NULL
             WHERE done_at IS NULL AND (alert_at<=?1 OR snooze_at<=?1)",
            [now],
        )
        .map_err(fail)?;
    Ok(n > 0)
}
/// The ones whose alert went off and wait for an answer, oldest first.
pub fn pending(db: &Connection, today: NaiveDate) -> Result<Vec<Todo>> {
    db.prepare(&format!(
        "SELECT {COLUMNS} FROM todos WHERE due_since IS NOT NULL AND done_at IS NULL ORDER BY due_since, id"
    ))
    .map_err(fail)?
    .query_map([], |r| read(r, today))
    .map_err(fail)?
    .collect::<rusqlite::Result<Vec<_>>>()
    .map_err(fail)
}
/// The next alert or snooze, for the clock to wake at.
pub fn wake(db: &Connection) -> Result<Option<i64>> {
    db.query_row(
        "SELECT min(at) FROM (SELECT alert_at at FROM todos WHERE done_at IS NULL UNION ALL SELECT snooze_at FROM todos WHERE done_at IS NULL)",
        [],
        |r| r.get(0),
    )
    .map_err(fail)
}
/// After a restart or a change of time zone: alerts still ahead are worked
/// out again from their day and time.
pub fn realign(db: &Connection, now: &Now) -> Result<()> {
    let open: Vec<(i64, Option<String>, Option<String>)> = db
        .prepare("SELECT id,day,time FROM todos WHERE done_at IS NULL AND due_since IS NULL AND alert_at>?")
        .map_err(fail)?
        .query_map([now.ms], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))
        .map_err(fail)?
        .collect::<rusqlite::Result<Vec<_>>>()
        .map_err(fail)?;
    for (id, day, time) in open {
        let at = alert(day.as_deref(), time.as_deref(), now);
        db.execute("UPDATE todos SET alert_at=? WHERE id=?", params![at, id])
            .map_err(fail)?;
    }
    Ok(())
}

/// When a snooze rings again: in 10 minutes, in an hour, tonight at 20:00,
/// or tomorrow at 9:00 (plan/30).
pub fn snooze_at(action: &str, now: &Now) -> Option<i64> {
    let clock = |h| NaiveTime::from_hms_opt(h, 0, 0);
    match action {
        "snooze10" => Some(now.ms + 10 * 60_000),
        "snooze60" => Some(now.ms + 60 * 60_000),
        "tonight" => (now.at)(now.today, clock(20)?).filter(|at| *at > now.ms),
        "tomorrow" => (now.at)(now.today.succ_opt()?, clock(9)?),
        _ => None,
    }
}
/// The bubble's answer to alerts that went off: "done", a snooze (see
/// `snooze_at`), or "dismiss" (closed: seen, it stays on the list).
pub fn answer(db: &Connection, ids: &[i64], action: &str, now: &Now) -> Result<()> {
    for &id in ids {
        match action {
            "done" => {
                complete(db, id, now)?;
            }
            "snooze10" | "snooze60" | "tonight" | "tomorrow" => {
                let later =
                    snooze_at(action, now).ok_or_else(|| crate::locale::t("host.todoWhenBad"))?;
                db.execute(
                    "UPDATE todos SET snooze_at=?,due_since=NULL WHERE id=? AND done_at IS NULL",
                    params![later, id],
                )
                .map_err(fail)?;
            }
            "dismiss" => {
                db.execute("UPDATE todos SET due_since=NULL WHERE id=?", [id])
                    .map_err(fail)?;
            }
            _ => return Err(crate::locale::t("host.todoMissing")),
        }
    }
    Ok(())
}

/// Up to three choices: the last unfinished task first, then today's.
pub fn focus_candidates(db: &Connection, n: &Now) -> Result<Vec<Todo>> {
    roll(db, n)?;
    let last = focus_on(db, n.today)?.map(|t| t.id);
    let mut tasks = list(db, n.today)?;
    tasks.retain(|t| t.group == Group::Today || (Some(t.id) == last && t.done_at.is_none()));
    tasks.sort_by_key(|t| Some(t.id) != last);
    tasks.truncate(3);
    Ok(tasks)
}

/// The to-do the running tomato is on, if any.
pub fn focus_on(db: &Connection, today: NaiveDate) -> Result<Option<Todo>> {
    let id: Option<i64> = db
        .query_row("SELECT todo FROM focus_on WHERE one=1", [], |r| r.get(0))
        .optional()
        .map_err(fail)?
        .flatten();
    match id {
        Some(id) => get(db, id, today).map(Some),
        None => Ok(None),
    }
}
pub fn set_focus(db: &Connection, id: Option<i64>) -> Result<()> {
    db.execute(
        "INSERT INTO focus_on(one,todo) VALUES(1,?) ON CONFLICT(one) DO UPDATE SET todo=excluded.todo",
        [id],
    )
    .map_err(fail)?;
    Ok(())
}
/// A tomato finished: one more on the to-do it was on.
pub fn tomato(db: &Connection) -> Result<()> {
    db.execute(
        "UPDATE todos SET tomatoes=tomatoes+1 WHERE id=(SELECT todo FROM focus_on WHERE one=1)",
        [],
    )
    .map_err(fail)?;
    Ok(())
}

/// A focus session that began at `at` ended: note the to-do it was on,
/// with its title as it was, for 今天的专注.
pub fn spent(db: &Connection, at: i64) -> Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO spent(at,todo,title) SELECT ?,id,title FROM todos
         WHERE id=(SELECT todo FROM focus_on WHERE one=1)",
        [at],
    )
    .map_err(fail)?;
    Ok(())
}
/// What the sessions begun since `from` were spent on: (at, title).
pub fn spent_since(db: &Connection, from: i64) -> Result<Vec<(i64, String)>> {
    let mut q = db
        .prepare("SELECT at,title FROM spent WHERE at>=? ORDER BY at")
        .map_err(fail)?;
    let rows = q
        .query_map([from], |r| Ok((r.get(0)?, r.get(1)?)))
        .map_err(fail)?;
    rows.collect::<rusqlite::Result<_>>().map_err(fail)
}

#[cfg(test)]
#[path = "store_tests.rs"]
mod tests;
