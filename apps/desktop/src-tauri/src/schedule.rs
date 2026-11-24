use crate::locale::t;
use chrono::{DateTime, Datelike, Days, Duration, LocalResult, NaiveDateTime, TimeZone, Utc};
use chrono_tz::Tz;
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum Schedule {
    Once {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        at: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        after_seconds: Option<u64>,
    },
    Interval {
        seconds: u64,
    },
    Daily {
        hour: u32,
        minute: u32,
        #[serde(default)]
        zone: Option<String>,
    },
    Weekly {
        weekdays: Vec<u32>,
        hour: u32,
        minute: u32,
        #[serde(default)]
        zone: Option<String>,
    },
}
pub type Result<T> = std::result::Result<T, String>;
fn step(seconds: u64) -> Result<i64> {
    i64::try_from(seconds)
        .ok()
        .filter(|s| *s > 0)
        .and_then(|s| s.checked_mul(1000))
        .ok_or(t("host.intervalBad").into())
}
fn wall_time(zone: Tz, local: NaiveDateTime) -> Option<i64> {
    // A skipped wall-clock minute moves to the first valid minute that day.
    // For a repeated hour, deliver only its first occurrence.
    for offset in 0..=180 {
        let t = local.checked_add_signed(Duration::minutes(offset))?;
        if t.date() != local.date() {
            return None;
        }
        match zone.from_local_datetime(&t) {
            LocalResult::Single(v) => return Some(v.timestamp_millis()),
            LocalResult::Ambiguous(a, b) => return Some(a.min(b).timestamp_millis()),
            LocalResult::None => {}
        }
    }
    None
}
impl Schedule {
    pub fn local_zone(&self) -> bool {
        matches!(self,Self::Daily{zone,..}|Self::Weekly{zone,..} if zone.as_deref().unwrap_or("local")=="local")
    }
    pub fn first(&self, now: i64, local: &str) -> Result<i64> {
        match self {
            Self::Once {
                at: Some(at),
                after_seconds: None,
            } => {
                let ms = DateTime::parse_from_rfc3339(at)
                    .map_err(|_| t("host.onceNeeds"))?
                    .timestamp_millis();
                if ms <= now {
                    return Err(t("host.mustBeFuture").into());
                }
                Ok(ms)
            }
            Self::Once {
                at: None,
                after_seconds: Some(seconds),
            }
            | Self::Interval { seconds } => now
                .checked_add(step(*seconds)?)
                .ok_or(t("host.timeRange").into()),
            Self::Once { .. } => Err(t("host.onceEither").into()),
            Self::Daily { hour, minute, zone }
            | Self::Weekly {
                hour, minute, zone, ..
            } => {
                let name = zone.as_deref().unwrap_or("local");
                let zone: Tz = (if name == "local" { local } else { name })
                    .parse()
                    .map_err(|_| t("host.zoneBad"))?;
                let today = Utc
                    .timestamp_millis_opt(now)
                    .single()
                    .ok_or(t("host.timeBad"))?
                    .with_timezone(&zone)
                    .date_naive();
                if *hour >= 24 || *minute >= 60 {
                    return Err(t("host.clockBad").into());
                }
                if let Self::Weekly { weekdays, .. } = self {
                    if weekdays.is_empty() || weekdays.iter().any(|n| !(1..=7).contains(n)) {
                        return Err(t("host.weekdayRange").into());
                    }
                }
                for offset in 0..=14 {
                    let day = today
                        .checked_add_days(Days::new(offset))
                        .ok_or(t("host.dateRange"))?;
                    if let Self::Weekly { weekdays, .. } = self {
                        if !weekdays.contains(&day.weekday().number_from_monday()) {
                            continue;
                        }
                    }
                    if let Some(ms) = wall_time(zone, day.and_hms_opt(*hour, *minute, 0).unwrap()) {
                        if ms > now {
                            return Ok(ms);
                        }
                    }
                }
                Err(t("host.noNext").into())
            }
        }
    }
    pub fn following(&self, due: i64, now: i64, local: &str) -> Result<Option<i64>> {
        match self {
            Self::Once { .. } => Ok(None),
            Self::Interval { seconds } => {
                let delta = step(*seconds)?;
                let jumps = (now.saturating_sub(due).max(0) / delta) + 1;
                Ok(Some(
                    delta
                        .checked_mul(jumps)
                        .and_then(|d| due.checked_add(d))
                        .ok_or(t("host.timeRange"))?,
                ))
            }
            _ => self.first(now, local).map(Some),
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    fn ms(s: &str) -> i64 {
        DateTime::parse_from_rfc3339(s).unwrap().timestamp_millis()
    }
    #[test]
    fn interval_keeps_phase_and_once_finishes() {
        let s = Schedule::Interval { seconds: 60 };
        assert_eq!(s.following(60000, 190000, "UTC").unwrap(), Some(240000));
        let s = Schedule::Once {
            after_seconds: Some(60),
            at: None,
        };
        assert_eq!(s.first(10, "UTC").unwrap(), 60010);
        assert_eq!(s.following(0, 10, "UTC").unwrap(), None);
    }
    #[test]
    fn dst_gap_and_repeat_fire_once() {
        let mut s = Schedule::Daily {
            hour: 2,
            minute: 30,
            zone: Some("America/New_York".into()),
        };
        assert_eq!(
            s.first(ms("2026-03-08T00:00:00-05:00"), "UTC").unwrap(),
            ms("2026-03-08T03:00:00-04:00")
        );
        s = Schedule::Daily {
            hour: 1,
            minute: 30,
            zone: Some("America/New_York".into()),
        };
        let first = s.first(ms("2026-11-01T00:00:00-04:00"), "UTC").unwrap();
        assert_eq!(first, ms("2026-11-01T01:30:00-04:00"));
        assert_eq!(
            s.following(first, first, "UTC").unwrap(),
            Some(ms("2026-11-02T01:30:00-05:00"))
        );
    }
    #[test]
    fn weekly_and_local_zone() {
        let s = Schedule::Weekly {
            weekdays: vec![1],
            hour: 9,
            minute: 0,
            zone: None,
        };
        let now = ms("2026-11-05T10:00:00Z");
        assert_eq!(
            s.first(now, "Asia/Shanghai").unwrap(),
            ms("2026-11-09T09:00:00+08:00")
        );
        assert_eq!(
            s.first(now, "America/New_York").unwrap(),
            ms("2026-11-09T09:00:00-05:00")
        );
    }
}
