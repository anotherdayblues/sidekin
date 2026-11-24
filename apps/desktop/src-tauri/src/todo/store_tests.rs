use super::*;
use chrono::{FixedOffset, NaiveDate};

const MIN: i64 = 60_000;

fn day(s: &str) -> NaiveDate {
    when::day(s).unwrap()
}
/// Beijing time; `ms` at noon on `today`.
fn at(today: &str, ms_after_noon: i64) -> (i64, NaiveDate) {
    let zone = FixedOffset::east_opt(8 * 3600).unwrap();
    let noon = when::alert_at(&zone, day(today), when::time("12:00").unwrap()).unwrap();
    (noon + ms_after_noon, day(today))
}
fn beijing(d: NaiveDate, t: chrono::NaiveTime) -> Option<i64> {
    when::alert_at(&FixedOffset::east_opt(8 * 3600).unwrap(), d, t)
}
fn now((ms, today): (i64, NaiveDate)) -> Now<'static> {
    Now {
        ms,
        today,
        at: &beijing,
    }
}
fn fields(title: &str, day: &str, time: &str, repeat: &str) -> Fields {
    let s = |v: &str| (!v.is_empty()).then(|| v.to_string());
    Fields {
        title: Some(title.into()),
        day: s(day),
        time: s(time),
        repeat: s(repeat),
    }
}
fn temp() -> (tempfile::TempDir, Connection) {
    let dir = tempfile::tempdir().unwrap();
    let db = open(dir.path()).unwrap();
    (dir, db)
}

#[test]
fn adding_cleans_the_title_and_a_time_needs_a_day() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0));
    let t = add(&db, fields("  写   周报 ", "", "", ""), "app", None, &n).unwrap();
    assert_eq!(
        (t.title.as_str(), t.day.clone(), t.group),
        ("写 周报", None, Group::Later)
    );
    // A time alone is today at that time.
    let t = add(&db, fields("开会", "", "15:00", ""), "app", None, &n).unwrap();
    assert_eq!(
        (t.day.as_deref(), t.group),
        (Some("2026-11-16"), Group::Today)
    );
    assert!(add(&db, fields("   ", "", "", ""), "app", None, &n).is_err());
    assert!(add(&db, fields("x", "2026-02-30", "", ""), "app", None, &n).is_err());
    assert!(add(&db, fields("x", "", "9点", ""), "app", None, &n).is_err());
    assert!(add(
        &db,
        fields(&"长".repeat(TITLE_MAX + 1), "", "", ""),
        "app",
        None,
        &n
    )
    .is_err());
}

#[test]
fn the_same_request_key_adds_once() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0));
    let a = add(&db, fields("交报告", "", "", ""), "brain", Some("k1"), &n).unwrap();
    let b = add(&db, fields("交报告", "", "", ""), "brain", Some("k1"), &n).unwrap();
    assert_eq!(a.id, b.id);
    assert_eq!(list(&db, n.today).unwrap().len(), 1);
}

#[test]
fn groups_come_in_order_each_in_the_order_added_carried_ones_first() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0));
    add(&db, fields("以后没日子", "", "", ""), "app", None, &n).unwrap();
    add(&db, fields("明天", "2026-11-17", "", ""), "app", None, &n).unwrap();
    add(
        &db,
        fields("今天下午", "2026-11-16", "16:00", ""),
        "app",
        None,
        &n,
    )
    .unwrap();
    add(
        &db,
        fields("今天全天", "2026-11-16", "", ""),
        "app",
        None,
        &n,
    )
    .unwrap();
    add(
        &db,
        fields("今天上午", "2026-11-16", "09:00", ""),
        "app",
        None,
        &n,
    )
    .unwrap();
    let old = add(&db, fields("昨天的", "2026-11-15", "", ""), "app", None, &n).unwrap();
    let done = add(&db, fields("做完的", "2026-11-16", "", ""), "app", None, &n).unwrap();
    complete(&db, done.id, &n).unwrap();
    let titles: Vec<_> = list(&db, n.today)
        .unwrap()
        .into_iter()
        .map(|t| t.title)
        .collect();
    assert_eq!(
        titles,
        [
            "昨天的",
            "今天下午",
            "今天全天",
            "今天上午",
            "以后没日子",
            "明天",
            "做完的"
        ]
    );
    // Yesterday's carries on in 今天, quietly: not 已过期.
    let old = get(&db, old.id, n.today).unwrap();
    assert_eq!((old.group, old.carried), (Group::Today, true));
}

#[test]
fn the_alert_goes_off_once_and_waits_for_an_answer() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0));
    let t = add(&db, fields("开会", "", "15:00", ""), "app", None, &n).unwrap();
    // A time already past today sets no alert.
    add(&db, fields("早上的", "", "08:00", ""), "app", None, &n).unwrap();
    let three = at("2026-11-16", 3 * 60 * MIN);
    assert_eq!(wake(&db).unwrap(), Some(three.0));
    assert!(!fire(&db, three.0 - 1).unwrap());
    assert!(fire(&db, three.0).unwrap());
    assert!(!fire(&db, three.0 + MIN).unwrap(), "fires once");
    let due = pending(&db, n.today).unwrap();
    assert_eq!(due.iter().map(|t| t.id).collect::<Vec<_>>(), [t.id]);
    assert!(due[0].due);
    assert_eq!(wake(&db).unwrap(), None);

    // Later: back in 10 minutes.
    let n3 = now(three);
    answer(&db, &[t.id], "snooze10", &n3).unwrap();
    assert!(pending(&db, n.today).unwrap().is_empty());
    assert_eq!(wake(&db).unwrap(), Some(three.0 + 10 * MIN));
    assert!(fire(&db, three.0 + 10 * MIN).unwrap());
    // Seen: off the bubble, still on the list, not done.
    answer(&db, &[t.id], "dismiss", &n3).unwrap();
    assert!(pending(&db, n.today).unwrap().is_empty());
    assert_eq!(get(&db, t.id, n.today).unwrap().done_at, None);
    // A new time sets a new alert.
    let t = update(
        &db,
        t.id,
        Fields {
            time: Some("18:30".into()),
            ..Default::default()
        },
        &n3,
    )
    .unwrap();
    assert_eq!(t.time.as_deref(), Some("18:30"));
    assert_eq!(wake(&db).unwrap(), Some(at("2026-11-16", 390 * MIN).0));
    // Cleared time: no alert.
    update(
        &db,
        t.id,
        Fields {
            time: Some(String::new()),
            ..Default::default()
        },
        &n3,
    )
    .unwrap();
    assert_eq!(wake(&db).unwrap(), None);
}

#[test]
fn done_from_the_bubble_and_reopened() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0));
    let t = add(&db, fields("开会", "", "13:00", ""), "app", None, &n).unwrap();
    fire(&db, at("2026-11-16", 60 * MIN).0).unwrap();
    answer(&db, &[t.id], "done", &n).unwrap();
    let t = get(&db, t.id, n.today).unwrap();
    assert_eq!((t.group, t.due), (Group::Done, false));
    let t = reopen(&db, t.id, &n).unwrap();
    assert_eq!((t.group, t.done_at), (Group::Today, None));
    // Its time is still ahead: the alert is back.
    assert!(wake(&db).unwrap().is_some());
    remove(&db, t.id).unwrap();
    assert!(get(&db, t.id, n.today).is_err());
}

#[test]
fn a_repeating_one_moves_on_when_done() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0));
    let t = add(&db, fields("喝水", "", "15:00", "daily"), "app", None, &n).unwrap();
    assert_eq!(t.repeat, Some(Repeat::Daily));
    // Done before its alert: today's alert is skipped, tomorrow's is set.
    let t = complete(&db, t.id, &n).unwrap();
    assert_eq!(
        (t.day.as_deref(), t.done_at, t.group),
        (Some("2026-11-17"), None, Group::Later)
    );
    assert_eq!(wake(&db).unwrap(), Some(at("2026-11-17", 3 * 60 * MIN).0));
    // Missed for days: done today, it comes back tomorrow, once.
    let late = now(at("2026-11-20", 0));
    assert_eq!(get(&db, t.id, late.today).unwrap().group, Group::Today);
    let t = complete(&db, t.id, &late).unwrap();
    assert_eq!(t.day.as_deref(), Some("2026-11-21"));
    assert_eq!(list(&db, late.today).unwrap().len(), 1);
}

#[test]
fn focus_candidates_offer_the_last_unfinished_task_even_if_it_is_for_later() {
    let (_dir, db) = temp();
    let n = now(at("2026-11-16", 0));
    let later = add(&db, fields("读书", "", "", ""), "app", None, &n).unwrap();
    assert!(focus_candidates(&db, &n).unwrap().is_empty());
    set_focus(&db, Some(later.id)).unwrap();
    for title in ["周报", "回信", "开会"] {
        add(&db, fields(title, "2026-11-16", "", ""), "app", None, &n).unwrap();
    }
    let choices = focus_candidates(&db, &n).unwrap();
    assert_eq!(choices.len(), 3);
    assert_eq!(choices[0].id, later.id);
    complete(&db, later.id, &n).unwrap();
    assert!(focus_candidates(&db, &n)
        .unwrap()
        .iter()
        .all(|t| t.group == Group::Today));
}

#[test]
fn a_tomato_counts_on_the_to_do_it_was_on() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0));
    let a = add(&db, fields("写周报", "", "", ""), "app", None, &n).unwrap();
    tomato(&db).unwrap(); // none picked: nothing counts
    set_focus(&db, Some(a.id)).unwrap();
    tomato(&db).unwrap();
    tomato(&db).unwrap();
    assert_eq!(focus_on(&db, n.today).unwrap().unwrap().tomatoes, 2);
    // Done: the next tomato is on nothing until one is picked.
    complete(&db, a.id, &n).unwrap();
    assert_eq!(focus_on(&db, n.today).unwrap(), None);
    // Deleted while focused on: nothing either.
    let b = add(&db, fields("读书", "", "", ""), "app", None, &n).unwrap();
    set_focus(&db, Some(b.id)).unwrap();
    remove(&db, b.id).unwrap();
    assert_eq!(focus_on(&db, n.today).unwrap(), None);
}

#[test]
fn alerts_ahead_are_set_again_after_a_restart() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0));
    let t = add(&db, fields("开会", "", "15:00", ""), "app", None, &n).unwrap();
    // Set for another time zone: an hour off.
    db.execute(
        "UPDATE todos SET alert_at=alert_at+3600000 WHERE id=?",
        [t.id],
    )
    .unwrap();
    realign(&db, &n).unwrap();
    assert_eq!(wake(&db).unwrap(), Some(at("2026-11-16", 3 * 60 * MIN).0));
}

#[test]
fn each_session_notes_the_to_do_it_was_spent_on_by_its_title_then() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0));
    let a = add(&db, fields("写周报", "", "", ""), "app", None, &n).unwrap();
    spent(&db, 1_000).unwrap(); // none picked: not noted
    set_focus(&db, Some(a.id)).unwrap();
    spent(&db, 2_000).unwrap(); // ended early, still noted
    spent(&db, 3_000).unwrap();
    // Renamed or deleted later, the note keeps what it was called.
    remove(&db, a.id).unwrap();
    assert_eq!(
        spent_since(&db, 0).unwrap(),
        vec![(2_000, "写周报".to_string()), (3_000, "写周报".to_string())]
    );
    assert_eq!(spent_since(&db, 2_500).unwrap().len(), 1);
}

// ---------- plan/30: the order dragged, carried on, rolled, snoozed ----------

fn titles(db: &Connection, today: NaiveDate) -> Vec<String> {
    list(db, today)
        .unwrap()
        .into_iter()
        .filter(|t| t.done_at.is_none())
        .map(|t| t.title)
        .collect()
}

#[test]
fn dragging_sets_the_order_and_moves_between_today_and_later() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0));
    let a = add(&db, fields("写周报", "2026-11-16", "", ""), "app", None, &n).unwrap();
    let b = add(
        &db,
        fields("开会", "2026-11-16", "15:00", ""),
        "app",
        None,
        &n,
    )
    .unwrap();
    let c = add(
        &db,
        fields("交报告", "2026-11-17", "15:00", ""),
        "app",
        None,
        &n,
    )
    .unwrap();
    let d = add(&db, fields("学吉他", "", "", ""), "app", None, &n).unwrap();
    // A time does not decide the order: 开会 goes first only when dragged.
    assert_eq!(titles(&db, n.today), ["写周报", "开会", "交报告", "学吉他"]);
    move_to(&db, b.id, true, Some(a.id), &n).unwrap();
    assert_eq!(titles(&db, n.today), ["开会", "写周报", "交报告", "学吉他"]);
    // Into 今天: today's, the reminder time kept and set again.
    let c = move_to(&db, c.id, true, Some(a.id), &n).unwrap();
    assert_eq!(
        (c.day.as_deref(), c.time.as_deref(), c.group),
        (Some("2026-11-16"), Some("15:00"), Group::Today)
    );
    assert_eq!(titles(&db, n.today), ["开会", "交报告", "写周报", "学吉他"]);
    assert_eq!(wake(&db).unwrap(), Some(at("2026-11-16", 3 * 60 * MIN).0));
    // Into 以后: no day, no reminder; last when nothing comes after.
    let b = move_to(&db, b.id, false, None, &n).unwrap();
    assert_eq!((b.day, b.time, b.group), (None, None, Group::Later));
    assert_eq!(titles(&db, n.today), ["交报告", "写周报", "学吉他", "开会"]);
    // Within 以后, only the place.
    let b = move_to(&db, b.id, false, Some(d.id), &n).unwrap();
    assert_eq!(b.day, None);
    assert_eq!(titles(&db, n.today), ["交报告", "写周报", "开会", "学吉他"]);
    // A repeating one sent to 以后 goes to its next run, not nowhere.
    let r = add(&db, fields("喝水", "", "16:30", "daily"), "app", None, &n).unwrap();
    let r = move_to(&db, r.id, false, None, &n).unwrap();
    assert_eq!(
        (r.day.as_deref(), r.time.as_deref()),
        (Some("2026-11-17"), Some("16:30"))
    );
}

#[test]
fn a_carried_one_dragged_in_today_is_todays() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0));
    let a = add(&db, fields("写周报", "2026-11-16", "", ""), "app", None, &n).unwrap();
    let old = add(
        &db,
        fields("回复意见", "2026-11-15", "", ""),
        "app",
        None,
        &n,
    )
    .unwrap();
    assert_eq!(titles(&db, n.today), ["回复意见", "写周报"]);
    let old = move_to(&db, old.id, true, None, &n).unwrap();
    assert!(!old.carried);
    assert_eq!(titles(&db, n.today), ["写周报", "回复意见"]);
    let _ = a;
}

#[test]
fn a_missed_repeating_one_rolls_to_today_without_piling_up() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 0)); // Monday
    let t = add(&db, fields("喝水", "", "16:30", "daily"), "app", None, &n).unwrap();
    let w = add(
        &db,
        fields("周会", "2026-11-16", "10:00", "weekly"),
        "app",
        None,
        &n,
    )
    .unwrap();
    // Three days later, never done.
    let late = now(at("2026-11-19", 0));
    roll(&db, &late).unwrap();
    let t = get(&db, t.id, late.today).unwrap();
    assert_eq!(
        (t.day.as_deref(), t.carried, t.group),
        (Some("2026-11-19"), false, Group::Today)
    );
    assert_eq!(
        wake(&db).unwrap(),
        Some(at("2026-11-19", 4 * 60 * MIN + 30 * MIN).0)
    );
    // Weekly keeps its weekday: next Monday, in 以后.
    let w = get(&db, w.id, late.today).unwrap();
    assert_eq!(
        (w.day.as_deref(), w.group),
        (Some("2026-11-23"), Group::Later)
    );
    assert_eq!(list(&db, late.today).unwrap().len(), 2);
}

#[test]
fn snoozes_ring_in_ten_minutes_an_hour_tonight_or_tomorrow_morning() {
    let (_d, db) = temp();
    let n = now(at("2026-11-16", 3 * 60 * MIN)); // 15:00
    assert_eq!(snooze_at("snooze10", &n), Some(n.ms + 10 * MIN));
    assert_eq!(snooze_at("snooze60", &n), Some(n.ms + 60 * MIN));
    assert_eq!(
        snooze_at("tonight", &n),
        Some(at("2026-11-16", 8 * 60 * MIN).0)
    );
    assert_eq!(
        snooze_at("tomorrow", &n),
        Some(at("2026-11-17", -3 * 60 * MIN).0)
    );
    // After 20:00 there is no tonight.
    let late = now(at("2026-11-16", 9 * 60 * MIN));
    assert_eq!(snooze_at("tonight", &late), None);
    let t = add(&db, fields("开会", "", "", ""), "app", None, &n).unwrap();
    answer(&db, &[t.id], "tomorrow", &n).unwrap();
    assert_eq!(wake(&db).unwrap(), snooze_at("tomorrow", &n));
    assert!(answer(&db, &[t.id], "tonight", &late).is_err());
}

#[test]
fn rows_from_before_keep_their_order_by_day_and_time() {
    let dir = tempfile::tempdir().unwrap();
    {
        let db = Connection::open(dir.path().join("todos.sqlite3")).unwrap();
        db.execute_batch(
            "CREATE TABLE todos(id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, day TEXT, time TEXT, repeat TEXT,
             alert_at INTEGER, snooze_at INTEGER, due_since INTEGER, done_at INTEGER,
             tomatoes INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL,
             source TEXT NOT NULL DEFAULT 'app', request_key TEXT UNIQUE);
             INSERT INTO todos(title,day,time,created_at) VALUES('没日子',NULL,NULL,0),('下午','2026-11-16','16:00',0),('上午','2026-11-16','09:00',0);",
        )
        .unwrap();
    }
    let db = open(dir.path()).unwrap();
    assert_eq!(titles(&db, day("2026-11-16")), ["上午", "下午", "没日子"]);
}
