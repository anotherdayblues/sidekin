//! 待办的日子和时间 (plan/27): which group a to-do is in, when its alert
//! goes off, and where a repeating one goes once it is done.
use chrono::{Datelike, Duration, LocalResult, NaiveDate, NaiveTime, TimeZone, Weekday};
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Repeat {
    Daily,
    /// Monday to Friday.
    Weekdays,
    /// The same weekday as its day.
    Weekly,
}
impl Repeat {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "daily" => Some(Self::Daily),
            "weekdays" => Some(Self::Weekdays),
            "weekly" => Some(Self::Weekly),
            _ => None,
        }
    }
    pub fn name(self) -> &'static str {
        match self {
            Self::Daily => "daily",
            Self::Weekdays => "weekdays",
            Self::Weekly => "weekly",
        }
    }
}

pub fn day(s: &str) -> Option<NaiveDate> {
    NaiveDate::parse_from_str(s, "%Y-%m-%d").ok()
}
pub fn time(s: &str) -> Option<NaiveTime> {
    NaiveTime::parse_from_str(s, "%H:%M").ok()
}
pub fn day_text(d: NaiveDate) -> String {
    d.format("%Y-%m-%d").to_string()
}

/// 今天 and 以后 (plan/30): one not done from an earlier day carries on in
/// 今天, quietly (Things); nothing is 已过期.
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Group {
    /// Today's, and the ones carried on from an earlier day.
    Today,
    /// A later day, or no day at all (以后).
    Later,
    Done,
}
pub fn group(day: Option<NaiveDate>, done: bool, today: NaiveDate) -> Group {
    match (done, day) {
        (true, _) => Group::Done,
        (false, Some(d)) if d <= today => Group::Today,
        _ => Group::Later,
    }
}

/// The moment `day` at `time` comes in `zone`. A wall-clock time skipped by
/// a clock change moves to the first minute after it; a repeated one is
/// its first occurrence.
pub fn alert_at<Z: TimeZone>(zone: &Z, day: NaiveDate, time: NaiveTime) -> Option<i64> {
    for offset in 0..=180 {
        let t = day.and_time(time) + Duration::minutes(offset);
        if t.date() != day {
            return None;
        }
        match zone.from_local_datetime(&t) {
            LocalResult::Single(v) => return Some(v.timestamp_millis()),
            LocalResult::Ambiguous(a, b) => {
                return Some(a.timestamp_millis().min(b.timestamp_millis()))
            }
            LocalResult::None => {}
        }
    }
    None
}

/// Where a repeating to-do goes once done: the next run after both its own
/// day and today. One that was missed for days comes back once, not once
/// for every missed day (Super Productivity's "don't let overdue pile up";
/// Tasks.org keeps one row per series the same way).
pub fn next_day(repeat: Repeat, day: NaiveDate, today: NaiveDate) -> NaiveDate {
    let base = day.max(today);
    match repeat {
        Repeat::Daily => base + Duration::days(1),
        Repeat::Weekdays => {
            let mut d = base + Duration::days(1);
            while matches!(d.weekday(), Weekday::Sat | Weekday::Sun) {
                d += Duration::days(1);
            }
            d
        }
        Repeat::Weekly => {
            let mut d = day + Duration::days(7);
            while d <= base {
                d += Duration::days(7);
            }
            d
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::FixedOffset;

    fn d(s: &str) -> NaiveDate {
        day(s).unwrap()
    }

    #[test]
    fn groups_by_day_and_done() {
        let today = d("2026-11-16");
        assert_eq!(group(Some(d("2026-11-15")), false, today), Group::Today);
        assert_eq!(group(Some(today), false, today), Group::Today);
        assert_eq!(group(Some(d("2026-11-17")), false, today), Group::Later);
        assert_eq!(group(None, false, today), Group::Later);
        assert_eq!(group(Some(d("2026-11-15")), true, today), Group::Done);
    }

    #[test]
    fn a_repeating_one_moves_past_today_once() {
        let today = d("2026-11-16"); // a Monday
                                     // Done on its day: the next run.
        assert_eq!(next_day(Repeat::Daily, today, today), d("2026-11-17"));
        assert_eq!(next_day(Repeat::Weekly, today, today), d("2026-11-23"));
        // Friday's weekday one goes to Monday.
        let friday = d("2026-11-20");
        assert_eq!(next_day(Repeat::Weekdays, friday, friday), d("2026-11-23"));
        // Missed for three days, done today: tomorrow, not the day after
        // the missed one.
        assert_eq!(
            next_day(Repeat::Daily, d("2026-11-13"), today),
            d("2026-11-17")
        );
        // Weekly, missed last Wednesday: next Wednesday, keeping its weekday.
        assert_eq!(
            next_day(Repeat::Weekly, d("2026-11-11"), today),
            d("2026-11-18")
        );
        // Done ahead of its day: the run after that day.
        assert_eq!(
            next_day(Repeat::Daily, d("2026-11-18"), today),
            d("2026-11-19")
        );
    }

    #[test]
    fn the_alert_is_that_wall_clock_time() {
        let beijing = FixedOffset::east_opt(8 * 3600).unwrap();
        let at = alert_at(&beijing, d("2026-11-16"), time("15:00").unwrap()).unwrap();
        assert_eq!(at, 1_794_812_400_000);
        assert!(time("25:00").is_none() && day("2026-13-01").is_none());
        assert_eq!(Repeat::parse("weekdays"), Some(Repeat::Weekdays));
        assert_eq!(Repeat::parse("monthly"), None);
    }
}
