// 番茄钟 records (plan/19): one entry per focus session — the day, when it
// started, how many minutes it ran, and whether it was finished — and the
// numbers the 专注 page shows from them (plan/29). The counts are of
// finished ones; the minutes are every minute focused, ended early too
// (time is time); those ended early are listed by their minutes only,
// never as failures.
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;

/// Enough for years of focusing.
const KEEP: usize = 5000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Session {
    /// The local day it ended, YYYY-MM-DD.
    pub day: String,
    /// When it started, in ms since the epoch.
    pub at: i64,
    pub minutes: u32,
    /// Ran to the end (false: ended early).
    pub done: bool,
}

pub fn record(log: &mut Vec<Session>, s: Session) {
    log.push(s);
    let excess = log.len().saturating_sub(KEEP);
    log.drain(..excess);
}

/// Today, the last seven and thirty days and the streaks, from the per-day
/// counts (which go back further than this log) and the minutes in the log.
pub fn summary(
    days: &BTreeMap<String, u32>,
    log: &[Session],
    today: chrono::NaiveDate,
) -> serde_json::Value {
    let key = |d: chrono::NaiveDate| d.format("%Y-%m-%d").to_string();
    let minutes =
        |day: &str| -> u32 { log.iter().filter(|s| s.day == day).map(|s| s.minutes).sum() };
    let span = |n: i64| -> Vec<serde_json::Value> {
        (0..n)
            .rev()
            .map(|back| {
                let day = key(today - chrono::Duration::days(back));
                let count = days.get(&day).copied().unwrap_or(0);
                json!({"day": day, "count": count, "minutes": minutes(&day)})
            })
            .collect()
    };
    let week = span(7);
    // The week's sessions, for what the time went on (the to-dos keep that).
    let first = key(today - chrono::Duration::days(6));
    let mut week_sessions: Vec<_> = log.iter().filter(|s| s.day >= first).collect();
    week_sessions.sort_by_key(|s| s.at);
    let sum = |field: &str| -> u64 { week.iter().map(|d| d[field].as_u64().unwrap_or(0)).sum() };
    let today_key = key(today);
    let mut sessions: Vec<_> = log.iter().filter(|s| s.day == today_key).collect();
    sessions.sort_by_key(|s| s.at);
    json!({
        "sessions": sessions
            .iter()
            .map(|s| json!({"at": s.at, "minutes": s.minutes, "done": s.done}))
            .collect::<Vec<_>>(),
        "today": days.get(&today_key).copied().unwrap_or(0),
        "todayMinutes": minutes(&today_key),
        "week": week,
        "weekCount": sum("count"),
        "weekMinutes": sum("minutes"),
        "weekSessions": week_sessions
            .iter()
            .map(|s| json!({"at": s.at, "minutes": s.minutes}))
            .collect::<Vec<_>>(),
        "month": span(30),
        "streak": streak(days, today),
        "longest": longest(days),
    })
}

/// The most days in a row there ever were with a tomato.
pub fn longest(days: &BTreeMap<String, u32>) -> u32 {
    let mut best = 0;
    let mut run = 0;
    let mut last: Option<chrono::NaiveDate> = None;
    for (d, n) in days {
        let Ok(d) = chrono::NaiveDate::parse_from_str(d, "%Y-%m-%d") else {
            continue;
        };
        if *n == 0 {
            run = 0;
            last = None;
            continue;
        }
        run = match last {
            Some(prev) if prev.succ_opt() == Some(d) => run + 1,
            _ => 1,
        };
        last = Some(d);
        best = best.max(run);
    }
    best
}

/// Days in a row with at least one tomato, counting back from today (or
/// from yesterday, when today has none yet).
pub fn streak(days: &BTreeMap<String, u32>, today: chrono::NaiveDate) -> u32 {
    let has = |d: chrono::NaiveDate| {
        days.get(&d.format("%Y-%m-%d").to_string())
            .copied()
            .unwrap_or(0)
            > 0
    };
    let mut day = if has(today) {
        today
    } else {
        today.pred_opt().unwrap_or(today)
    };
    let mut n = 0;
    while has(day) {
        n += 1;
        day = match day.pred_opt() {
            Some(d) => d,
            None => break,
        };
    }
    n
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(s: &str) -> chrono::NaiveDate {
        chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").unwrap()
    }
    fn session(d: &str, minutes: u32, done: bool) -> Session {
        Session {
            day: d.into(),
            at: 0,
            minutes,
            done,
        }
    }

    #[test]
    fn the_streak_counts_days_in_a_row_up_to_today_or_yesterday() {
        let days: BTreeMap<String, u32> = [("2026-11-12", 2), ("2026-11-13", 1), ("2026-11-14", 3)]
            .into_iter()
            .map(|(d, n)| (d.to_string(), n))
            .collect();
        assert_eq!(streak(&days, day("2026-11-14")), 3);
        assert_eq!(streak(&days, day("2026-11-15")), 3, "today not started yet");
        assert_eq!(streak(&days, day("2026-11-16")), 0);
        let mut gap = days.clone();
        gap.insert("2026-11-13".into(), 0);
        assert_eq!(streak(&gap, day("2026-11-14")), 1);
    }

    #[test]
    fn the_longest_streak_is_the_longest_run_ever() {
        let days: BTreeMap<String, u32> = [
            ("2026-10-01", 1),
            ("2026-10-02", 2),
            ("2026-10-03", 1),
            ("2026-10-04", 0),
            ("2026-10-05", 1),
            ("2026-11-14", 1),
            ("2026-11-15", 1),
        ]
        .into_iter()
        .map(|(d, n)| (d.to_string(), n))
        .collect();
        assert_eq!(longest(&days), 3);
        assert_eq!(longest(&BTreeMap::new()), 0);
    }

    #[test]
    fn counts_are_of_finished_ones_minutes_of_every_one_and_today_lists_every_session() {
        let days: BTreeMap<String, u32> = [("2026-11-10", 1), ("2026-11-16", 2)]
            .into_iter()
            .map(|(d, n)| (d.to_string(), n))
            .collect();
        let log = vec![
            session("2026-11-10", 25, true),
            session("2026-11-16", 25, true),
            session("2026-11-16", 12, false),
            session("2026-11-16", 45, true),
            // Older than the week.
            session("2026-11-01", 25, true),
        ];
        let s = summary(&days, &log, day("2026-11-16"));
        assert_eq!(s["today"], 2);
        // Ended early, its 12 minutes still count as time.
        assert_eq!(s["todayMinutes"], 82);
        assert_eq!(s["weekCount"], 3);
        assert_eq!(s["weekMinutes"], 107);
        assert_eq!(s["weekSessions"].as_array().unwrap().len(), 4);
        assert_eq!(s["month"].as_array().unwrap().len(), 30);
        assert_eq!(s["month"][29]["minutes"], 82);
        assert_eq!(s["month"][14]["minutes"], 25, "the 1st, a fortnight back");
        assert_eq!(s["week"].as_array().unwrap().len(), 7);
        assert_eq!(s["week"][0]["day"], "2026-11-10");
        assert_eq!(s["week"][0]["minutes"], 25);
        assert_eq!(s["week"][6]["count"], 2);
        // Today's list, ended-early one included, by its minutes.
        let today = s["sessions"].as_array().unwrap();
        assert_eq!(today.len(), 3);
        assert_eq!(today[1]["minutes"], 12);
        assert_eq!(today[1]["done"], false);
    }

    #[test]
    fn the_log_keeps_only_the_newest() {
        let mut log = vec![];
        for n in 0..KEEP + 3 {
            record(&mut log, session("d", n as u32, true));
        }
        assert_eq!(log.len(), KEEP);
        assert_eq!(log[0].minutes, 3);
    }
}
