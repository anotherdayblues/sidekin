//! Tests for focus.rs: the timer, the steps and what is recorded.
use super::*;
const M: i64 = MINUTE;

#[test]
fn a_tomato_runs_to_done_then_a_break_then_rested() {
    let s = Settings::default();
    let mut t = Timer::default();
    assert_eq!(t.start(0, 25), Moment::Started);
    assert!(t.running());
    assert_eq!(t.tick(24 * M, &Settings::default()), None);
    assert_eq!(t.tick(25 * M, &Settings::default()), Some(Moment::Finished));
    assert_eq!((t.phase, t.round), (Phase::Done, 1));
    assert_eq!(t.rest(25 * M, &s), Some(Moment::BreakStarted));
    assert_eq!(
        (t.phase, t.long_break, t.ends_at),
        (Phase::Break, false, 30 * M)
    );
    assert_eq!(
        t.tick(30 * M, &Settings::default()),
        Some(Moment::BreakOver)
    );
    assert_eq!(t.phase, Phase::Rested);
}
#[test]
fn every_fourth_tomato_earns_a_long_break() {
    let s = Settings::default();
    let mut t = Timer::default();
    let mut now = 0;
    for i in 1..=4 {
        t.start(now, 25);
        now += 25 * M;
        t.tick(now, &Settings::default());
        t.rest(now, &s);
        assert_eq!(t.long_break, i == 4, "tomato {i}");
        now = t.ends_at;
        t.tick(now, &Settings::default());
    }
    assert_eq!(t.ends_at - (now - 15 * M), 15 * M);
}
#[test]
fn pausing_keeps_the_time_left() {
    let mut t = Timer::default();
    t.start(0, 25);
    assert_eq!(t.pause(10 * M), Some(Moment::Paused));
    assert_eq!(
        t.tick(99 * M, &Settings::default()),
        None,
        "a paused tomato never ends"
    );
    assert_eq!(t.resume(100 * M), Some(Moment::Resumed));
    assert_eq!(t.ends_at, 115 * M);
    assert_eq!(t.pause(0), Some(Moment::Paused));
    assert_eq!(t.pause(0), None);
}
#[test]
fn stopping_mid_tomato_is_giving_up_otherwise_just_ending() {
    let mut t = Timer::default();
    t.start(0, 25);
    assert_eq!(t.stop(), Some(Moment::GaveUp));
    assert_eq!(t.phase, Phase::Idle);
    t.start(0, 25);
    t.tick(25 * M, &Settings::default());
    assert_eq!(t.stop(), Some(Moment::Ended));
    assert_eq!(t.stop(), None);
}
#[test]
fn starting_fresh_resets_the_round_but_another_one_keeps_it() {
    let s = Settings::default();
    let mut t = Timer::default();
    t.start(0, 25);
    t.tick(25 * M, &Settings::default());
    t.start(25 * M, 25);
    t.tick(50 * M, &Settings::default());
    assert_eq!(t.round, 2);
    t.rest(50 * M, &s);
    t.stop();
    t.start(0, 25);
    assert_eq!(t.round, 0);
}
#[test]
fn a_finished_tomato_is_a_session_and_giving_up_after_a_minute_is_one_too() {
    let mut t = Timer::default();
    t.start(0, 25);
    let before = t.clone();
    assert_eq!(
        ended(&before, Some(Moment::Finished), 25 * M),
        Some((25, true))
    );
    // Ended after ten minutes, or while paused with five left.
    assert_eq!(
        ended(&before, Some(Moment::GaveUp), 10 * M),
        Some((10, false))
    );
    let mut paused = before.clone();
    paused.pause(20 * M);
    assert_eq!(
        ended(&paused, Some(Moment::GaveUp), 99 * M),
        Some((20, false))
    );
    // Changed one's mind at once: not a session.
    assert_eq!(ended(&before, Some(Moment::GaveUp), 30_000), None);
    assert_eq!(ended(&before, Some(Moment::Paused), 10 * M), None);
}
#[test]
fn auto_steps_go_on_into_the_break_and_the_next_tomato() {
    let s = Settings {
        auto_break: true,
        auto_next: true,
        ..Default::default()
    };
    let mut t = Timer::default();
    t.start(0, 25);
    assert_eq!(t.tick(25 * M, &s), Some(Moment::Finished));
    assert_eq!((t.phase, t.round, t.ends_at), (Phase::Break, 1, 30 * M));
    assert_eq!(t.tick(30 * M, &s), Some(Moment::BreakOver));
    assert_eq!((t.phase, t.round, t.ends_at), (Phase::Focus, 1, 55 * M));
}
#[test]
fn a_deadline_missed_while_away_is_counted_without_cheering() {
    let s = Settings::default();
    let mut t = Timer::default();
    t.start(0, 25);
    assert_eq!(
        t.tick(25 * M + 30_000, &s),
        Some(Moment::Finished),
        "a late tick is still here"
    );
    t.start(0, 25);
    assert_eq!(t.tick(90 * M, &s), Some(Moment::FinishedAway));
    assert_eq!((t.phase, t.round), (Phase::Done, 2));
}
#[test]
fn the_timer_survives_a_save_and_load() {
    let mut t = Timer::default();
    t.start(1_000, 25);
    t.pause(2_000);
    let store = Store {
        timer: Some(t.clone()),
        ..Default::default()
    };
    let back: Store = serde_json::from_slice(&serde_json::to_vec(&store).unwrap()).unwrap();
    assert_eq!(back.timer, Some(t));
    let old: Store = serde_json::from_str(r#"{"days":{}}"#).unwrap();
    assert_eq!(old.timer, None);
    // Settings saved before the newer switches read as all off.
    let old: Store = serde_json::from_str(r#"{"settings":{"focusMinutes":30}}"#).unwrap();
    assert_eq!(old.settings.focus_minutes, 30);
    assert!(!old.settings.auto_break && !old.settings.auto_next && !old.settings.hold_reminders);
    // The clock taking the pet's hue is on unless turned off.
    assert!(old.settings.pet_tint);
}
#[test]
fn the_model_hears_the_phase_time_left_and_which_tomato() {
    let s = Settings::default();
    let mut t = Timer::default();
    t.start(0, 25);
    let a = account(&t, &s, Phase::Idle, 5 * M, 2);
    assert_eq!(a["phase"], "focus");
    assert_eq!(a["minutesLeft"], 20.0);
    assert_eq!(a["round"], "第 1 轮，一组 4 轮");
    assert_eq!(a["changed"], true);
    assert_eq!(a["doneToday"], 2);
    t.tick(25 * M, &s);
    let a = account(&t, &s, Phase::Focus, 25 * M, 3);
    assert_eq!(
        (a["phase"].as_str(), a["round"].as_str()),
        (Some("done"), Some("第 1 轮，一组 4 轮"))
    );
    assert!(a["minutesLeft"].is_null());
    t.stop();
    assert!(account(&t, &s, Phase::Idle, 0, 3)["round"].is_null());
}
#[test]
fn settings_stay_in_range() {
    let s = Settings {
        focus_minutes: 0,
        long_every: 1,
        volume: 300,
        ambient: "jazz".into(),
        ..Default::default()
    }
    .clean();
    assert_eq!(
        (s.focus_minutes, s.long_every, s.volume, s.ambient.as_str()),
        (1, 2, 100, "off")
    );
}
#[test]
fn bubble_prompts_cover_manual_confirmations_and_auto_steps() {
    assert_eq!(bubble_ask(Some(Moment::Finished), Phase::Done), Some("done"));
    assert_eq!(
        bubble_ask(Some(Moment::FinishedAway), Phase::Done),
        Some("done-away")
    );
    assert_eq!(
        bubble_ask(Some(Moment::BreakOver), Phase::Rested),
        Some("rested")
    );
    assert_eq!(
        bubble_ask(Some(Moment::Finished), Phase::Break),
        Some("auto-break")
    );
    assert_eq!(
        bubble_ask(Some(Moment::BreakOver), Phase::Focus),
        Some("auto-next")
    );
    assert_eq!(bubble_ask(Some(Moment::Started), Phase::Focus), None);
    assert_eq!(bubble_ask(Some(Moment::Paused), Phase::Focus), None);
}
