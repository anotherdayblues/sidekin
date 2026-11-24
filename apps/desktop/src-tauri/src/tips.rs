// 上手引导的记录和决定 (plan/17 3.2, 4). Features report "used" here, and a
// moment after the user did something related asks whether the pet may
// teach one thing now. The rules: each tip once, never what the user
// already uses, at most one a day, never while it is answering, and never
// after 不用教我了. Features call this module; it calls none of them.
use crate::companion::Companion;
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeSet;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

/// Everything the pet can teach, in the skill book's order. Each id names a
/// feature, the tip that teaches it, and its demo when it has one.
pub const FEATURES: [&str; 17] = [
    "chat-shortcut",
    "panel",
    "focus",
    "copy-translate",
    "menu-translate",
    "snip",
    "file-transfer",
    "phone",
    "memory",
    "clipboard",
    "reminder",
    "library",
    "web",
    "teach",
    "make-pet",
    "menu",
    "todo",
];
/// The one-off hint for a user who skipped the guide (plan/17 3.1).
pub const DOUBLE_CLICK: &str = "double-click";
/// Tips that wait until 随伴 has been used for some days: the right-click
/// menu, teaching a trick, making a new pet.
fn wait_days(id: &str) -> i64 {
    match id {
        "menu" | "teach" => 3,
        "make-pet" => 5,
        "focus" => 2,
        "phone" => 3,
        _ => 0,
    }
}

#[derive(Serialize, Deserialize, Default, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Record {
    /// The three-step guide has opened on its own once.
    pub guide_shown: bool,
    /// Features the user has used.
    pub used: BTreeSet<String>,
    /// Features the user has read about in 它会的事 (plan/17 3.3): learned
    /// counts as much as used.
    pub learned: BTreeSet<String>,
    /// Tips the pet has said.
    pub told: BTreeSet<String>,
    /// 不用教我了.
    pub off: bool,
    /// The day the last tip was said, YYYY-MM-DD.
    pub last_day: String,
    /// The first day 随伴 ran, for the right-click menu tip.
    pub first_day: String,
    /// Single clicks on the pet before a model is set up.
    pub pet_clicks: u32,
    /// Hashes of files attached in chat, to notice one coming back.
    pub files: Vec<u64>,
}

impl Record {
    /// Whether tip `id` may be said on `today`.
    pub fn may_say(&self, id: &str, today: &str, answering: bool) -> bool {
        !self.off
            && !answering
            && !self.told.contains(id)
            && !self.used.contains(id)
            && !self.learned.contains(id)
            && self.last_day != today
            && days_between(&self.first_day, today) >= wait_days(id)
    }
    /// The first of `candidates` that may be said, marked as said.
    pub fn pick(&mut self, candidates: &[&str], today: &str, answering: bool) -> Option<String> {
        let id = candidates
            .iter()
            .find(|id| self.may_say(id, today, answering))?;
        self.told.insert(id.to_string());
        self.last_day = today.into();
        Some(id.to_string())
    }
    /// A third click on the pet before a model is set up gets the hint, once.
    pub fn pet_click(&mut self) -> bool {
        self.pet_clicks = self.pet_clicks.saturating_add(1);
        if self.pet_clicks >= 3 && !self.off && self.told.insert(DOUBLE_CLICK.into()) {
            return true;
        }
        false
    }
    /// Remembers an attached file; true when it was attached before.
    pub fn attached_again(&mut self, hash: u64) -> bool {
        if self.files.contains(&hash) {
            return true;
        }
        self.files.push(hash);
        // Only recent files matter.
        if self.files.len() > 50 {
            self.files.remove(0);
        }
        false
    }
}

/// A file attached in chat, by its name and content.
pub fn file_hash(file: &crate::attachments::AttachedFile) -> u64 {
    use sha2::{Digest, Sha256};
    let digest = Sha256::new()
        .chain_update(file.name.as_bytes())
        .chain_update([0])
        .chain_update(file.text.as_bytes())
        .finalize();
    u64::from_le_bytes(digest[..8].try_into().unwrap())
}

fn days_between(from: &str, to: &str) -> i64 {
    let day = |s: &str| chrono::NaiveDate::parse_from_str(s, "%Y-%m-%d").ok();
    match (day(from), day(to)) {
        (Some(a), Some(b)) => (b - a).num_days(),
        _ => 0,
    }
}

fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}

fn path(dir: &Path) -> PathBuf {
    dir.join("tips.json")
}

static LOCK: Mutex<()> = Mutex::new(());

/// Reads the record, lets `f` change it, and saves it when it changed.
pub fn with<R>(dir: &Path, f: impl FnOnce(&mut Record) -> R) -> R {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let file = path(dir);
    let mut record: Record = std::fs::read(&file)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default();
    let before = record.clone();
    if record.first_day.is_empty() {
        record.first_day = today();
    }
    let out = f(&mut record);
    if record != before {
        if let Ok(text) = serde_json::to_vec_pretty(&record) {
            let _ = std::fs::write(&file, text);
        }
    }
    out
}

fn dir(app: &AppHandle) -> PathBuf {
    app.state::<Companion>().dir.clone()
}

fn changed(app: &AppHandle, record: &Record) {
    let _ = app.emit_to("studio", "tips-changed", record);
}

/// The user used `feature`: it lights up in the skill book and is never taught.
pub fn used(app: &AppHandle, feature: &str) {
    let record = with(&dir(app), |r| {
        r.used.insert(feature.into());
        r.clone()
    });
    changed(app, &record);
}

/// The settings that turn features off; a feature that is off is not taught.
pub struct Switches {
    pub translation: bool,
    pub copy_twice: bool,
    pub vision: bool,
    pub memory: bool,
    pub reminders: bool,
}
/// Whether the user has `feature` turned on. The skill book reads the same
/// switches (skillBook.ts `switchedOn`).
pub fn switched_on(s: &Switches, feature: &str) -> bool {
    match feature {
        "copy-translate" => s.translation && s.copy_twice,
        "menu-translate" => s.translation,
        "snip" => s.vision,
        "memory" => s.memory,
        "reminder" => s.reminders,
        _ => true,
    }
}

/// Something that happens during a turn and is worth a tip after it.
static NOTICED: Mutex<Vec<&'static str>> = Mutex::new(Vec::new());
pub fn noticed(id: &'static str) {
    NOTICED.lock().unwrap_or_else(|e| e.into_inner()).push(id);
}

/// What the user just did in a chat turn.
pub struct Turn<'a> {
    pub text: &'a str,
    pub image: bool,
    pub files: &'a [u64],
    pub search_ready: bool,
}

/// The tips a finished turn could lead to, most specific first.
pub fn candidates(turn: &Turn, noticed: &[&'static str], again: bool) -> Vec<&'static str> {
    let mut out: Vec<&'static str> = noticed.to_vec();
    if turn.image {
        out.push("snip");
    }
    if again {
        out.push("library");
    }
    if !turn.files.is_empty() {
        out.push("file-transfer");
    }
    let lower = turn.text.to_lowercase();
    if lower.contains("翻译") || lower.contains("translat") {
        out.push("copy-translate");
    }
    // Photos or files on the phone: 从手机传 is worth a mention.
    let phone =
        regex::Regex::new(r"手机.*(照片|图片|文件|传)|(照片|图片|文件).*手机|from (my )?phone")
            .unwrap();
    if phone.is_match(&lower) {
        out.push("phone");
    }
    // Work or study coming up: the timer is worth a mention.
    let busy = regex::Regex::new(r"专注|学习|复习|写作业|赶稿|deadline|focus|study").unwrap();
    if busy.is_match(&lower) {
        out.push("focus");
    }
    let fresh = regex::Regex::new(r"天气|新闻|最新|今天.*(发生|消息)|weather|news|latest").unwrap();
    if !turn.search_ready && fresh.is_match(&lower) {
        out.push("web");
    }
    out.extend([
        "chat-shortcut",
        "panel",
        "focus",
        "teach",
        "make-pet",
        "menu",
    ]);
    out
}

/// After a chat turn finished well: maybe teach one thing.
pub fn after_turn(app: &AppHandle, turn: Turn) {
    let noticed = std::mem::take(&mut *NOTICED.lock().unwrap_or_else(|e| e.into_inner()));
    let companion = app.state::<Companion>();
    let (switches, has_chat_shortcut) = {
        let s = companion.settings.lock().unwrap();
        (
            Switches {
                translation: s.translation,
                copy_twice: s.copy_twice,
                vision: s.vision,
                memory: s.memory,
                reminders: s.reminders,
            },
            !s.chat_shortcut.trim().is_empty(),
        )
    };
    // While a tomato runs the pet keeps quiet (plan/19).
    let answering = crate::chat::answering(app) || crate::focus::active(app);
    let today = today();
    let (tip, record) = with(&dir(app), |r| {
        let mut again = false;
        for hash in turn.files {
            again |= r.attached_again(*hash);
        }
        let list: Vec<_> = candidates(&turn, &noticed, again)
            .into_iter()
            .filter(|id| (*id != "chat-shortcut" || has_chat_shortcut) && switched_on(&switches, id))
            .collect();
        let tip = r.pick(&list, &today, answering);
        // What happened in the turn counts as used once its tip had its chance.
        for id in &noticed {
            r.used.insert(id.to_string());
        }
        (tip, r.clone())
    });
    if let Some(tip) = tip {
        say(app, &tip);
    }
    changed(app, &record);
}

/// The pet says tip `id` under whatever its bubble shows, or opens it.
pub fn say(app: &AppHandle, id: &str) {
    let visible = app
        .get_webview_window("bubble")
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    if visible {
        let _ = app.emit_to("bubble", "bubble-tip", id);
    } else {
        let _ = crate::chat::show(
            app,
            json!({"mode":"tip","tip":id,"at":crate::chat::now()}),
            false,
        );
    }
}

#[tauri::command]
pub fn tips_state(app: AppHandle) -> Record {
    with(&dir(&app), |r| r.clone())
}

#[tauri::command]
pub fn tips_used(app: AppHandle, feature: String) -> Result<(), String> {
    if !FEATURES.contains(&feature.as_str()) {
        return Err(format!("unknown feature {feature}"));
    }
    used(&app, &feature);
    Ok(())
}

/// The user read about `feature` in 它会的事.
#[tauri::command]
pub fn tips_learned(app: AppHandle, feature: String) -> Result<(), String> {
    if !FEATURES.contains(&feature.as_str()) {
        return Err(format!("unknown feature {feature}"));
    }
    let record = with(&dir(&app), |r| {
        r.learned.insert(feature);
        r.clone()
    });
    changed(&app, &record);
    Ok(())
}

/// 不用教我了, or teaching back on from settings.
#[tauri::command]
pub fn tips_off(app: AppHandle, off: bool) {
    let record = with(&dir(&app), |r| {
        r.off = off;
        r.clone()
    });
    changed(&app, &record);
}

/// The guide opened; it will not open on its own again.
#[tauri::command]
pub fn tips_guide_shown(app: AppHandle) {
    with(&dir(&app), |r| r.guide_shown = true);
}

/// A single click on the pet before a model is set up.
#[tauri::command]
pub fn tips_pet_click(app: AppHandle) {
    if with(&dir(&app), Record::pet_click) {
        say(&app, DOUBLE_CLICK);
    }
}

/// On the first launch, the pet waves and opens a welcoming self-intro bubble
/// instead of throwing the full settings window in the user's face. Clicking
/// "开始设置我" inside the bubble opens the focused three-step guide.
/// Someone who already set up a model before this existed skips it.
pub fn first_launch(app: &AppHandle) {
    // QA runs start with the guide already seen, so it never covers a check.
    if cfg!(feature = "acceptance") {
        with(&dir(app), |r| r.guide_shown = true);
        return;
    }
    let set_up = app.state::<Companion>().settings.lock().unwrap().enabled;
    let first = with(&dir(app), |r| {
        let first = !r.guide_shown && !set_up;
        r.guide_shown = true;
        first
    });
    if !first {
        return;
    }
    let _ = app.emit_to("pet", "play-action", "waving");
    say(app, "hello");
}

#[cfg(test)]
mod tests {
    use super::*;
    const DAY: &str = "2026-11-13";
    const NEXT: &str = "2026-11-14";

    fn fresh() -> Record {
        Record {
            first_day: DAY.into(),
            ..Default::default()
        }
    }

    #[test]
    fn each_tip_is_said_once() {
        let mut r = fresh();
        assert_eq!(
            r.pick(&["chat-shortcut"], DAY, false).as_deref(),
            Some("chat-shortcut")
        );
        assert_eq!(r.pick(&["chat-shortcut"], NEXT, false), None);
    }
    #[test]
    fn at_most_one_a_day() {
        let mut r = fresh();
        assert!(r.pick(&["snip"], DAY, false).is_some());
        assert_eq!(r.pick(&["memory"], DAY, false), None);
        assert_eq!(r.pick(&["memory"], NEXT, false).as_deref(), Some("memory"));
    }
    #[test]
    fn what_the_user_already_uses_is_never_taught() {
        let mut r = fresh();
        r.used.insert("chat-shortcut".into());
        assert_eq!(
            r.pick(&["chat-shortcut", "snip"], DAY, false).as_deref(),
            Some("snip")
        );
    }
    #[test]
    fn nothing_while_answering_and_nothing_once_off() {
        let mut r = fresh();
        assert_eq!(r.pick(&["snip"], DAY, true), None);
        assert!(
            !r.told.contains("snip"),
            "a skipped moment does not use the tip up"
        );
        r.off = true;
        assert_eq!(r.pick(&["snip"], DAY, false), None);
    }
    #[test]
    fn what_the_user_read_about_is_never_taught() {
        let mut r = fresh();
        r.learned.insert("snip".into());
        assert_eq!(
            r.pick(&["snip", "memory"], DAY, false).as_deref(),
            Some("memory")
        );
    }
    #[test]
    fn a_feature_turned_off_is_not_taught() {
        let on = Switches {
            translation: true,
            copy_twice: true,
            vision: true,
            memory: true,
            reminders: true,
        };
        assert!(switched_on(&on, "copy-translate"));
        let off = Switches {
            copy_twice: false,
            vision: false,
            ..on
        };
        assert!(!switched_on(&off, "copy-translate"));
        assert!(switched_on(&off, "menu-translate"));
        assert!(!switched_on(&off, "snip"));
        assert!(switched_on(&off, "chat-shortcut"));
    }
    #[test]
    fn the_menu_and_teaching_wait_three_days_a_new_pet_five() {
        let mut r = fresh();
        assert_eq!(
            r.pick(&["menu", "teach", "make-pet"], "2026-11-15", false),
            None
        );
        assert_eq!(
            r.pick(&["make-pet", "teach"], "2026-11-16", false)
                .as_deref(),
            Some("teach")
        );
        assert_eq!(r.pick(&["make-pet"], "2026-11-17", false), None);
        assert_eq!(
            r.pick(&["make-pet"], "2026-11-18", false).as_deref(),
            Some("make-pet")
        );
    }
    #[test]
    fn the_double_click_hint_comes_on_the_third_click_only() {
        let mut r = fresh();
        assert!(!r.pet_click());
        assert!(!r.pet_click());
        assert!(r.pet_click());
        assert!(!r.pet_click());
    }
    #[test]
    fn a_file_coming_back_is_noticed() {
        let mut r = fresh();
        assert!(!r.attached_again(7));
        assert!(r.attached_again(7));
    }
    #[test]
    fn a_turn_leads_to_the_most_specific_tip_first() {
        let turn = |text, image| Turn {
            text,
            image,
            files: &[],
            search_ready: false,
        };
        assert_eq!(
            candidates(&turn("帮我翻译这段", false), &[], false)[0],
            "copy-translate"
        );
        assert_eq!(candidates(&turn("看看这个", true), &[], false)[0], "snip");
        assert_eq!(
            candidates(&turn("今天天气怎么样", false), &[], false)[0],
            "web"
        );
        assert_eq!(
            candidates(&turn("hi", false), &["memory"], true)[..2],
            ["memory", "library"]
        );
        assert_eq!(
            candidates(&turn("hi", false), &[], false),
            [
                "chat-shortcut",
                "panel",
                "focus",
                "teach",
                "make-pet",
                "menu"
            ]
        );
        assert_eq!(
            candidates(&turn("明天要复习", false), &[], false)[0],
            "focus"
        );
        assert_eq!(
            candidates(&turn("手机里的照片怎么弄到电脑上", false), &[], false)[0],
            "phone"
        );
        let files = Turn {
            text: "看看",
            image: false,
            files: &[1],
            search_ready: true,
        };
        assert_eq!(candidates(&files, &[], false)[0], "file-transfer");
        let ready = Turn {
            text: "weather?",
            image: false,
            files: &[],
            search_ready: true,
        };
        assert!(!candidates(&ready, &[], false).contains(&"web"));
    }
    #[test]
    fn the_record_survives_a_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        with(dir.path(), |r| {
            r.used.insert("snip".into());
        });
        let r = with(dir.path(), |r| r.clone());
        assert!(r.used.contains("snip"));
        assert!(!r.first_day.is_empty());
    }
}
