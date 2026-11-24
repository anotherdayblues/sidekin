//! 伙伴大脑 helps with 待办 (plan/31): a pasted paragraph into to-dos, or
//! one to-do into steps. The brain answers in JSON (prompts todo-split and
//! todo-break); what comes back is checked here and shown to the user, who
//! picks what to add. Nothing is added from here.
use super::when;
use chrono::{Datelike, NaiveDate};
use serde::{Deserialize, Serialize};

/// Most drafts kept from one answer, and most characters sent.
const DRAFTS_MAX: usize = 8;
pub const INPUT_MAX: usize = 4000;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
#[serde(default)]
pub struct Draft {
    pub title: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub day: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub time: Option<String>,
    /// What done looks like, for a step; shown, not kept.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub note: Option<String>,
}

/// What the brain reads: today first, so it can work out "下周一".
pub fn input(text: &str, today: NaiveDate) -> String {
    const WEEK: [&str; 7] = ["周一", "周二", "周三", "周四", "周五", "周六", "周日"];
    let text: String = text.trim().chars().take(INPUT_MAX).collect();
    format!(
        "今天：{} {}\n{}",
        when::day_text(today),
        WEEK[today.weekday().num_days_from_monday() as usize],
        text
    )
}

/// The drafts in an answer: the JSON list in it, each with a title; a day
/// or time that does not read is dropped rather than guessed.
pub fn drafts(answer: &str) -> Vec<Draft> {
    let (Some(start), Some(end)) = (answer.find('['), answer.rfind(']')) else {
        return vec![];
    };
    if end < start {
        return vec![];
    }
    let Ok(list) = serde_json::from_str::<Vec<Draft>>(&answer[start..=end]) else {
        return vec![];
    };
    let clean = |s: Option<String>| s.map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    list.into_iter()
        .filter_map(|d| {
            let title: String = d.title.split_whitespace().collect::<Vec<_>>().join(" ");
            if title.is_empty() || title.chars().count() > super::store::TITLE_MAX {
                return None;
            }
            let day = clean(d.day).filter(|s| when::day(s).is_some());
            let time = clean(d.time)
                .and_then(|s| when::time(&s))
                .map(|t| t.format("%H:%M").to_string());
            Some(Draft {
                title,
                day,
                time,
                note: clean(d.note),
            })
        })
        .take(DRAFTS_MAX)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn today_and_its_weekday_come_first() {
        let today = when::day("2026-11-17").unwrap();
        assert_eq!(input("  报价单  ", today), "今天：2026-11-17 周二\n报价单");
        assert_eq!(
            input(&"字".repeat(5000), today).chars().count(),
            17 + INPUT_MAX
        );
    }

    #[test]
    fn the_list_is_read_out_of_the_answer_and_bad_fields_dropped() {
        let answer = r#"好的：
```json
[{"title":"  把报价单  发给客户 ","day":"2026-11-23"},
 {"title":"和客户开会","day":"2026-11-18","time":"14:00"},
 {"title":"过一遍演示稿","day":"下周三","time":"下午"},
 {"title":""},
 {"title":"列清单","note":"写下来就算完成"}]
```"#;
        let d = drafts(answer);
        assert_eq!(d.len(), 4);
        assert_eq!(d[0].title, "把报价单 发给客户");
        assert_eq!(
            (d[1].day.as_deref(), d[1].time.as_deref()),
            (Some("2026-11-18"), Some("14:00"))
        );
        // Not a date or a time: left out, not guessed.
        assert_eq!((d[2].day.clone(), d[2].time.clone()), (None, None));
        assert_eq!(d[3].note.as_deref(), Some("写下来就算完成"));
    }

    #[test]
    fn nothing_usable_is_an_empty_list() {
        assert!(drafts("没有要做的事").is_empty());
        assert!(drafts("[not json]").is_empty());
        assert!(drafts("] [").is_empty());
        let many = format!("[{}]", vec![r#"{"title":"x"}"#; 12].join(","));
        assert_eq!(drafts(&many).len(), DRAFTS_MAX);
    }
}
