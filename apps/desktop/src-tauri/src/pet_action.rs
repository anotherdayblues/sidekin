//! 宠物用动作表达 (plan/10 §8.2): the actions the brain may pick for the pet,
//! the check on what it picked, and the pace for actions it picks on its own.
//! Picks only ride along with an answer or a task result; the pet window plays
//! them after the answer is done.
use crate::{library, library::Pet, teaching, teaching::Layer};
use serde::Serialize;
use serde_json::{json, Value};
use std::{collections::HashMap, path::Path, sync::Mutex};

/// Built-in actions that read as a gesture. Idle, running left or right and
/// "working" are the pet's own states, not something to do on request.
const GESTURES: [&str; 5] = ["waving", "jumping", "failed", "waiting", "review"];
const SAME_ACTION_GAP_MS: i64 = 5 * 60_000;
const ANY_ACTION_GAP_MS: i64 = 60_000;

#[derive(Serialize, Debug, PartialEq)]
pub struct Choice {
    pub name: String,
    pub label: String,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub sleep: bool,
}

fn builtin_label(name: &str) -> String {
    let contract: Value = serde_json::from_str(include_str!(
        "../../../../skills/make-desktop-pet/references/runtime-contract.json"
    ))
    .unwrap();
    contract["animations"][name]["label"]
        .as_str()
        .unwrap_or(name)
        .to_owned()
}

/// What the pet can be asked to do: the built-in gestures, taught actions
/// that play once, and sleep when the pet has a sleep action. Taught actions
/// that loop are left out, except sleep, which wakes on a click.
fn menu(pet: &Pet, layer: &Layer) -> Vec<Choice> {
    let mut out: Vec<Choice> = GESTURES
        .iter()
        .filter(|n| {
            !layer
                .actions
                .get(**n)
                .is_some_and(|a| a.loop_frames.is_some())
        })
        .map(|n| Choice {
            name: (*n).into(),
            label: layer
                .actions
                .get(*n)
                .map(|a| a.label.clone())
                .unwrap_or_else(|| builtin_label(n)),
            sleep: false,
        })
        .collect();
    for (name, a) in &layer.actions {
        if GESTURES.contains(&name.as_str()) || library::ACTIONS.contains(&name.as_str()) {
            continue;
        }
        if a.loop_frames.is_none() {
            out.push(Choice {
                name: name.clone(),
                label: a.label.clone(),
                sleep: false,
            });
        }
    }
    let taught_sleep = layer
        .actions
        .get("sleep")
        .is_some_and(|a| a.loop_frames.is_some());
    let named_sleep = out.iter().any(|c| c.name == "sleep");
    if !named_sleep && (taught_sleep || pet.sleep_strip.is_some() || pet.id == "lizi") {
        out.push(Choice {
            name: "sleep".into(),
            label: "睡觉".into(),
            sleep: true,
        });
    }
    out
}

/// The list sent to the brain for one pet; empty when it cannot be read.
pub fn choices(root: &Path, pet: &str) -> Vec<Choice> {
    let (Ok(p), Ok(layer)) = (library::pet(root, pet), teaching::layer(root, pet)) else {
        return vec![];
    };
    menu(&p, &layer)
}

/// The action named in `pick`, if it is one of `choices`, with whether it is
/// sleep. A pick the pet cannot do is dropped.
fn checked<'a>(pick: &Value, choices: &'a [Choice]) -> Option<&'a Choice> {
    let name = pick["action"].as_str()?;
    choices.iter().find(|c| c.name == name)
}

#[derive(Default)]
struct Pace {
    last_any: Option<i64>,
    last: HashMap<String, i64>,
}
impl Pace {
    /// Asked-for actions always play. One the pet picks on its own plays at
    /// most once in five minutes, and nothing plays within a minute of the
    /// last action it picked on its own.
    fn allow(&mut self, name: &str, asked: bool, now: i64) -> bool {
        if asked {
            return true;
        }
        let soon = |at: Option<&i64>, gap| at.is_some_and(|t| now - t < gap);
        if soon(self.last_any.as_ref(), ANY_ACTION_GAP_MS)
            || soon(self.last.get(name), SAME_ACTION_GAP_MS)
        {
            return false;
        }
        self.last_any = Some(now);
        self.last.insert(name.into(), now);
        true
    }
}
static PACE: Mutex<Option<Pace>> = Mutex::new(None);

/// What to tell the pet window after an answer: the pick, when it is one of
/// this pet's actions and within the pace. Sleep only when the user asked.
pub fn after_answer(root: &Path, pet: &str, pick: &Value, now: i64) -> Option<Value> {
    let choices = choices(root, pet);
    let choice = checked(pick, &choices)?;
    let asked = pick["reason"] == "asked";
    if choice.sleep && !asked {
        return None;
    }
    let mut pace = PACE.lock().unwrap();
    if !pace
        .get_or_insert_with(Pace::default)
        .allow(&choice.name, asked, now)
    {
        return None;
    }
    Some(json!({"action": choice.name, "sleep": choice.sleep}))
}

/// What a due reminder plays instead of the default jump: the action its task
/// picked, when the pet showing now has it.
pub fn for_reminder(root: &Path, pet: &str, action: &str) -> Option<Value> {
    let choices = choices(root, pet);
    let choice = checked(&json!({"action": action}), &choices)?;
    Some(json!({"action": choice.name, "sleep": choice.sleep}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::teaching::CustomAction;

    fn pet(id: &str, sleep_strip: bool) -> Pet {
        let mut v = json!({"id": id, "displayName": "测试", "spritesheetPath": "spritesheet.webp"});
        if sleep_strip {
            v["sleepStrip"] = json!("sleep.png");
        }
        serde_json::from_value(v).unwrap()
    }
    fn action(label: &str, looping: bool) -> CustomAction {
        CustomAction {
            label: label.into(),
            image: "a.png".into(),
            durations: vec![100],
            loop_frames: looping.then_some([0, 0]),
        }
    }
    fn names(c: &[Choice]) -> Vec<&str> {
        c.iter().map(|c| c.name.as_str()).collect()
    }

    #[test]
    fn gestures_and_taught_one_shot_actions_are_offered_loops_are_not() {
        let mut layer = Layer::default();
        layer.actions.insert("dance".into(), action("跳舞", false));
        layer.actions.insert("read".into(), action("看书", true));
        let c = menu(&pet("mimi", false), &layer);
        assert_eq!(
            names(&c),
            ["waving", "jumping", "failed", "waiting", "review", "dance"]
        );
        assert_eq!(c[1].label, "跳跃");
        assert_eq!(c[5].label, "跳舞");
    }

    #[test]
    fn sleep_is_offered_only_when_the_pet_can_sleep() {
        assert!(!names(&menu(&pet("mimi", false), &Layer::default())).contains(&"sleep"));
        for p in [pet("mimi", true), pet("lizi", false)] {
            let c = menu(&p, &Layer::default());
            assert_eq!(
                c.last().unwrap(),
                &Choice {
                    name: "sleep".into(),
                    label: "睡觉".into(),
                    sleep: true
                }
            );
        }
        let mut layer = Layer::default();
        layer.actions.insert("sleep".into(), action("打盹", true));
        assert_eq!(
            menu(&pet("mimi", false), &layer).last().unwrap().name,
            "sleep"
        );
        // A taught "sleep" that plays once is an ordinary action, listed once.
        let mut layer = Layer::default();
        layer
            .actions
            .insert("sleep".into(), action("趴一下", false));
        let c = menu(&pet("mimi", true), &layer);
        assert_eq!(c.iter().filter(|c| c.name == "sleep").count(), 1);
        assert!(!c.last().unwrap().sleep);
    }

    #[test]
    fn a_taught_gesture_keeps_its_label_and_a_looping_one_is_dropped() {
        let mut layer = Layer::default();
        layer
            .actions
            .insert("waving".into(), action("认真挥手", false));
        layer
            .actions
            .insert("jumping".into(), action("一直跳", true));
        let c = menu(&pet("mimi", false), &layer);
        assert_eq!(c[0].label, "认真挥手");
        assert!(!names(&c).contains(&"jumping"));
    }

    #[test]
    fn picks_outside_the_list_are_dropped() {
        let c = menu(&pet("mimi", false), &Layer::default());
        assert!(checked(&json!({"action": "fly"}), &c).is_none());
        assert!(checked(&json!({}), &c).is_none());
        assert_eq!(
            checked(&json!({"action": "waving"}), &c).unwrap().name,
            "waving"
        );
    }

    #[test]
    fn asked_actions_always_play_and_own_ones_keep_their_pace() {
        let mut p = Pace::default();
        assert!(p.allow("jumping", false, 0));
        assert!(
            !p.allow("waving", false, 59_000),
            "any action within a minute"
        );
        assert!(p.allow("waving", false, 60_000));
        assert!(
            !p.allow("jumping", false, 120_000),
            "same action within five minutes"
        );
        assert!(p.allow("jumping", false, 300_000));
        assert!(p.allow("jumping", true, 300_001), "asked: no limit");
        assert!(p.allow("jumping", true, 300_002));
        assert!(
            !p.allow("review", false, 300_003),
            "still within a minute of its own last one"
        );
    }
}
