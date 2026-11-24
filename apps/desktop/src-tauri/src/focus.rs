// 番茄钟 (plan/19, plan/20): the timer, its records and settings. Times are
// wall-clock deadlines, so sleep or a locked screen keeps counting. Windows
// hear "focus-changed" on every change and count down on their own; the
// pet's reactions are actions every pet already has; the clock, the light
// and the confetti are drawn by the windows (no generated art).
use crate::companion::Companion;
use crate::focus_log::{self, Session};
use serde::{Deserialize, Serialize};
use serde_json::json;
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

const MINUTE: i64 = 60_000;
/// A deadline missed by more than this was missed while nobody was there.
const AWAY: i64 = MINUTE;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    pub focus_minutes: u32,
    pub break_minutes: u32,
    pub long_break_minutes: u32,
    /// A long break after this many tomatoes in a row.
    pub long_every: u32,
    /// A soft sound when a tomato is done.
    pub chime: bool,
    /// "off", "noise", "rain" or "pages".
    pub ambient: String,
    /// 0–100.
    pub volume: u32,
    /// A finished tomato goes straight into its break.
    pub auto_break: bool,
    /// A finished break goes straight into the next tomato.
    pub auto_next: bool,
    /// Reminders that come due during a tomato wait for the break.
    pub hold_reminders: bool,
    /// The clock's light takes the pet's hue (系统原生 skin).
    pub pet_tint: bool,
}
impl Default for Settings {
    fn default() -> Self {
        Settings {
            focus_minutes: 25,
            break_minutes: 5,
            long_break_minutes: 15,
            long_every: 4,
            chime: true,
            ambient: "off".into(),
            volume: 40,
            auto_break: false,
            auto_next: false,
            hold_reminders: false,
            pet_tint: true,
        }
    }
}
impl Settings {
    /// Keeps every value in a sensible range.
    pub fn clean(mut self) -> Self {
        self.focus_minutes = self.focus_minutes.clamp(1, 180);
        self.break_minutes = self.break_minutes.clamp(1, 60);
        self.long_break_minutes = self.long_break_minutes.clamp(1, 90);
        self.long_every = self.long_every.clamp(2, 12);
        self.volume = self.volume.min(100);
        if !["off", "noise", "rain", "pages"].contains(&self.ambient.as_str()) {
            self.ambient = "off".into();
        }
        self
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
struct Store {
    settings: Settings,
    /// Tomatoes done per day, YYYY-MM-DD.
    days: BTreeMap<String, u32>,
    /// Every session, finished or ended early (focus_log.rs).
    #[serde(skip_serializing_if = "Vec::is_empty")]
    log: Vec<Session>,
    /// The timer as it was, so a restart carries on.
    timer: Option<Timer>,
}

/// Where the timer is.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Copy)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    Idle,
    Focus,
    /// A tomato is done; the user picks what comes next.
    Done,
    Break,
    /// The break is over; the user picks what comes next.
    Rested,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Timer {
    pub phase: Phase,
    /// When the running phase ends, in ms since the epoch.
    pub ends_at: i64,
    /// How long the running phase is, in ms.
    pub length: i64,
    /// Time left while paused.
    pub paused_left: Option<i64>,
    /// Tomatoes done since the last long break.
    pub round: u32,
    pub long_break: bool,
}
impl Default for Timer {
    fn default() -> Self {
        Timer {
            phase: Phase::Idle,
            ends_at: 0,
            length: 0,
            paused_left: None,
            round: 0,
            long_break: false,
        }
    }
}

/// What the timer did on a step, for the windows to react to.
#[derive(Debug, PartialEq, Eq, Clone, Copy)]
pub enum Moment {
    Started,
    Finished,
    /// Finished while nobody was there (asleep, or the app closed): counted,
    /// but no cheering at a screen that just woke up.
    FinishedAway,
    GaveUp,
    BreakStarted,
    BreakOver,
    Ended,
    Paused,
    Resumed,
}

impl Timer {
    pub fn start(&mut self, now: i64, minutes: u32) -> Moment {
        if !matches!(self.phase, Phase::Done | Phase::Break | Phase::Rested) {
            self.round = 0;
        }
        self.run(Phase::Focus, now, minutes);
        Moment::Started
    }
    fn run(&mut self, phase: Phase, now: i64, minutes: u32) {
        self.phase = phase;
        self.length = minutes as i64 * MINUTE;
        self.ends_at = now + self.length;
        self.paused_left = None;
    }
    /// From 完成: a break, long after every `long_every` tomatoes.
    pub fn rest(&mut self, now: i64, s: &Settings) -> Option<Moment> {
        if self.phase != Phase::Done {
            return None;
        }
        self.long_break = self.round > 0 && self.round % s.long_every == 0;
        let minutes = if self.long_break {
            s.long_break_minutes
        } else {
            s.break_minutes
        };
        self.run(Phase::Break, now, minutes);
        Some(Moment::BreakStarted)
    }
    pub fn pause(&mut self, now: i64) -> Option<Moment> {
        if !matches!(self.phase, Phase::Focus | Phase::Break) || self.paused_left.is_some() {
            return None;
        }
        self.paused_left = Some((self.ends_at - now).max(0));
        Some(Moment::Paused)
    }
    pub fn resume(&mut self, now: i64) -> Option<Moment> {
        let left = self.paused_left.take()?;
        self.ends_at = now + left;
        Some(Moment::Resumed)
    }
    /// 结束: giving up during a tomato, or simply finishing otherwise.
    pub fn stop(&mut self) -> Option<Moment> {
        let moment = match self.phase {
            Phase::Idle => return None,
            Phase::Focus => Moment::GaveUp,
            _ => Moment::Ended,
        };
        *self = Timer::default();
        Some(moment)
    }
    /// Time passing: a tomato or a break that ran out. With the settings'
    /// auto steps it goes on into the break or the next tomato by itself.
    pub fn tick(&mut self, now: i64, s: &Settings) -> Option<Moment> {
        if self.paused_left.is_some() || now < self.ends_at {
            return None;
        }
        match self.phase {
            Phase::Focus => {
                let away = now - self.ends_at > AWAY;
                self.phase = Phase::Done;
                self.round += 1;
                if s.auto_break {
                    self.rest(now, s);
                }
                Some(if away {
                    Moment::FinishedAway
                } else {
                    Moment::Finished
                })
            }
            Phase::Break => {
                self.phase = Phase::Rested;
                if s.auto_next {
                    self.start(now, s.focus_minutes);
                }
                Some(Moment::BreakOver)
            }
            _ => None,
        }
    }
    pub fn running(&self) -> bool {
        matches!(self.phase, Phase::Focus)
    }
}

/// The session a step ended, from the timer just before it: minutes and
/// whether it ran to the end. Under a minute ended early is not a session.
fn ended(before: &Timer, moment: Option<Moment>, now: i64) -> Option<(u32, bool)> {
    match moment? {
        Moment::Finished | Moment::FinishedAway => Some(((before.length / MINUTE) as u32, true)),
        Moment::GaveUp => {
            let left = before.paused_left.unwrap_or((before.ends_at - now).max(0));
            let minutes = ((before.length - left) / MINUTE) as u32;
            (minutes >= 1).then_some((minutes, false))
        }
        _ => None,
    }
}

#[derive(Default)]
pub struct Focus {
    timer: Mutex<Timer>,
}

static FILE: Mutex<()> = Mutex::new(());

fn path(dir: &Path) -> PathBuf {
    dir.join("focus.json")
}
fn load(dir: &Path) -> Store {
    let _guard = FILE.lock().unwrap_or_else(|e| e.into_inner());
    std::fs::read(path(dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn save(dir: &Path, store: &Store) {
    let _guard = FILE.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(text) = serde_json::to_vec_pretty(store) {
        let _ = std::fs::write(path(dir), text);
    }
}
fn dir(app: &AppHandle) -> PathBuf {
    app.state::<Companion>().dir.clone()
}
fn now() -> i64 {
    crate::chat::now()
}
fn today() -> chrono::NaiveDate {
    chrono::Local::now().date_naive()
}

/// Whether reminders due now should wait: a tomato runs and the user asked
/// for them to wait for the break.
pub fn holds_reminders(app: &AppHandle) -> bool {
    active(app) && load(&dir(app)).settings.hold_reminders
}

/// Whether any timer is on, a break included: the clock shows then.
pub fn on(app: &AppHandle) -> bool {
    app.try_state::<Focus>()
        .is_some_and(|f| f.timer.lock().unwrap().phase != Phase::Idle)
}

/// Whether a tomato is running: the pet keeps quiet then.
pub fn active(app: &AppHandle) -> bool {
    app.try_state::<Focus>()
        .is_some_and(|f| f.timer.lock().unwrap().running())
}

/// What the windows draw: the timer, today's tomatoes and the settings.
fn snapshot(app: &AppHandle) -> serde_json::Value {
    let timer = app.state::<Focus>().timer.lock().unwrap().clone();
    let store = load(&dir(app));
    let mut out = focus_log::summary(&store.days, &store.log, today());
    let timer_part = json!({
        "phase": timer.phase,
        "endsAt": timer.ends_at,
        "length": timer.length,
        "pausedLeft": timer.paused_left,
        "round": timer.round,
        "longBreak": timer.long_break,
        "settings": store.settings,
        "now": now(),
    });
    for (k, v) in timer_part.as_object().into_iter().flatten() {
        out[k] = v.clone();
    }
    out
}

/// Which bubble prompt (if any) should open after a timer step.
fn bubble_ask(moment: Option<Moment>, phase: Phase) -> Option<&'static str> {
    match (moment, phase) {
        (Some(Moment::Finished), Phase::Done) => Some("done"),
        (Some(Moment::FinishedAway), Phase::Done) => Some("done-away"),
        (Some(Moment::BreakOver), Phase::Rested) => Some("rested"),
        (Some(Moment::Finished), Phase::Break) => Some("auto-break"),
        (Some(Moment::BreakOver), Phase::Focus) => Some("auto-next"),
        _ => None,
    }
}

/// Tells every window, and lets the pet and the bubble react.
/// `ended` is the session that just ended, if one did (others, like the
/// to-dos, note what it was spent on).
fn changed(app: &AppHandle, moment: Option<Moment>, ended: Option<&Session>) {
    crate::focus_clock::sync(app, on(app));
    let _ = crate::chat::place(app);
    let state = snapshot(app);
    let _ = app.emit(
        "focus-changed",
        json!({
            "state": state,
            "moment": moment.map(|m| format!("{m:?}")),
            "ended": ended.map(|s| json!({"at": s.at, "minutes": s.minutes, "done": s.done})),
        }),
    );
    // The pet window reacts (jump, droop, wave, or what the user taught it).
    // Done and rested ask the user what comes next; auto steps leave a short
    // heads-up in the bubble so the switch is never silent.
    let phase = app.state::<Focus>().timer.lock().unwrap().phase;
    if let Some(phase) = bubble_ask(moment, phase) {
        let intent = json!({"mode":"focus","focus":phase,"at":now()});
        let visible = app
            .get_webview_window("bubble")
            .is_some_and(|w| w.is_visible().unwrap_or(false));
        if visible {
            let _ = app.emit_to("bubble", "bubble-focus", phase);
        } else {
            let _ = crate::chat::show(app, intent, false);
        }
    }
}

fn step(
    app: &AppHandle,
    f: impl FnOnce(&mut Timer, i64, &Settings) -> Option<Moment>,
) -> serde_json::Value {
    let settings = load(&dir(app)).settings;
    let at = now();
    let (before, moment) = {
        let focus = app.state::<Focus>();
        let mut timer = focus.timer.lock().unwrap();
        let before = timer.clone();
        (before, f(&mut timer, at, &settings))
    };
    let timer = app.state::<Focus>().timer.lock().unwrap().clone();
    let dir = dir(app);
    let mut store = load(&dir);
    store.timer = (timer.phase != Phase::Idle).then_some(timer);
    let day = today().format("%Y-%m-%d").to_string();
    let session = ended(&before, moment, at).map(|(minutes, done)| Session {
        day: day.clone(),
        at: before.ends_at - before.length,
        minutes,
        done,
    });
    if let Some(s) = &session {
        focus_log::record(&mut store.log, s.clone());
    }
    if matches!(moment, Some(Moment::Finished | Moment::FinishedAway)) {
        *store.days.entry(day).or_default() += 1;
        crate::tips::used(app, "focus");
    }
    save(&dir, &store);
    if moment.is_some() {
        changed(app, moment, session.as_ref());
    }
    snapshot(app)
}

/// Picks up the timer from before a restart, then checks the deadline once
/// a second, for as long as the app runs.
pub fn watch(app: AppHandle) {
    if let Some(saved) = load(&dir(&app)).timer {
        *app.state::<Focus>().timer.lock().unwrap() = saved;
    }
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let due = app.state::<Focus>().timer.lock().unwrap().clone();
        if due.phase != Phase::Idle && due.paused_left.is_none() && now() >= due.ends_at {
            step(&app, |t, now, s| t.tick(now, s));
        }
    });
}

/// The 番茄钟 tool in a conversation (plan/19 §9.8): the same steps as the
/// buttons, and a short account for the model of where the timer is.
pub fn from_brain(
    app: &AppHandle,
    action: &str,
    minutes: Option<u32>,
) -> Result<serde_json::Value, String> {
    let before = app.state::<Focus>().timer.lock().unwrap().phase;
    match action {
        "start" => {
            focus_start(app.clone(), minutes);
        }
        "pause" => {
            focus_pause(app.clone());
        }
        "resume" => {
            focus_resume(app.clone());
        }
        "stop" => {
            focus_stop(app.clone());
        }
        "rest" => {
            focus_rest(app.clone());
        }
        "status" => {}
        _ => return Err("未知计时操作".into()),
    }
    let timer = app.state::<Focus>().timer.lock().unwrap().clone();
    let settings = load(&dir(app)).settings;
    Ok(account(&timer, &settings, before, now(), today_count(app)))
}
fn today_count(app: &AppHandle) -> u32 {
    load(&dir(app))
        .days
        .get(&today().format("%Y-%m-%d").to_string())
        .copied()
        .unwrap_or(0)
}
/// What the model hears back: the phase, minutes left, which tomato of the
/// set, today's count, and whether the step did anything.
fn account(t: &Timer, s: &Settings, before: Phase, now: i64, today: u32) -> serde_json::Value {
    let left = t.paused_left.unwrap_or((t.ends_at - now).max(0));
    let running = matches!(t.phase, Phase::Focus | Phase::Break);
    let n = s.long_every.max(1);
    let k = if t.phase == Phase::Focus {
        t.round % n + 1
    } else {
        (t.round.max(1) - 1) % n + 1
    };
    json!({
        "phase": t.phase,
        "changed": t.phase != before || running && t.paused_left.is_some(),
        "paused": t.paused_left.is_some(),
        "minutesLeft": if running { Some((left as f64 / MINUTE as f64 * 10.).round() / 10.) } else { None },
        // Said the way a person would: 第 1 轮，一组 4 轮.
        "round": if t.phase == Phase::Idle { None } else { Some(format!("第 {k} 轮，一组 {n} 轮")) },
        "doneToday": today,
    })
}

#[tauri::command]
pub fn focus_state(app: AppHandle) -> serde_json::Value {
    snapshot(&app)
}
/// 陪我专注: `minutes`, or the usual length.
#[tauri::command]
pub fn focus_start(app: AppHandle, minutes: Option<u32>) -> serde_json::Value {
    step(&app, |t, now, s| {
        Some(t.start(now, minutes.unwrap_or(s.focus_minutes).clamp(1, 180)))
    })
}
#[tauri::command]
pub fn focus_rest(app: AppHandle) -> serde_json::Value {
    step(&app, |t, now, s| t.rest(now, s))
}
#[tauri::command]
pub fn focus_pause(app: AppHandle) -> serde_json::Value {
    step(&app, |t, now, _| t.pause(now))
}
#[tauri::command]
pub fn focus_resume(app: AppHandle) -> serde_json::Value {
    step(&app, |t, now, _| t.resume(now))
}
#[tauri::command]
pub fn focus_stop(app: AppHandle) -> serde_json::Value {
    step(&app, |t, _, _| t.stop())
}
#[tauri::command]
pub fn focus_settings(app: AppHandle, settings: Settings) -> serde_json::Value {
    let dir = dir(&app);
    let mut store = load(&dir);
    store.settings = settings.clean();
    save(&dir, &store);
    changed(&app, None, None);
    snapshot(&app)
}

#[cfg(test)]
#[path = "focus_tests.rs"]
mod tests;
