//! When a learned action plays (plan/29): on a double-click, now and then
//! at random, or at a time of day. A "plan rule" plays one learned action
//! once on one of these; the studio's settings for an action read and write
//! only those. Base actions keep their own situations and are never
//! scheduled. Rules taught earlier in other ways keep running, shown apart,
//! and can only be removed.
use super::*;

#[derive(Clone, Debug, Default, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Plan {
    #[serde(default)]
    pub double: bool,
    /// Now and then at random, about this many times an hour.
    #[serde(default)]
    pub random: Option<f64>,
    #[serde(default)]
    pub clock: Option<At>,
}
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct At {
    /// HH:MM, every day (or Monday to Friday).
    pub at: String,
    #[serde(default)]
    pub weekdays: bool,
}

const WEEKDAYS: [u8; 5] = [1, 2, 3, 4, 5];

/// A learned action: not a base one, and not sleep (every pet has sleep).
pub fn learned(name: &str, actions: &BTreeMap<String, CustomAction>) -> bool {
    name != "sleep" && !ACTIONS.contains(&name) && actions.contains_key(name)
}

/// The learned action a plan rule plays, if the rule is one.
pub fn plan_action<'a>(r: &'a Rule, actions: &BTreeMap<String, CustomAction>) -> Option<&'a str> {
    if !r.enabled || r.chance.is_some() || r.cooldown_minutes.is_some() || r.steps.len() != 1 {
        return None;
    }
    let s = &r.steps[0];
    let name = s.play.as_deref()?;
    if s.wait.is_some() || s.repeat.is_some_and(|n| n != 1) || !learned(name, actions) {
        return None;
    }
    let ok = match &r.when {
        Trigger::Event { event } => event == "double-click",
        Trigger::Random { .. } => true,
        Trigger::Clock {
            at,
            days,
            window_minutes,
        } => {
            !at.starts_with('*')
                && window_minutes.is_none()
                && days.as_ref().is_none_or(|d| d[..] == WEEKDAYS)
        }
        _ => false,
    };
    ok.then_some(name)
}

/// What a new teaching may add: only plan rules (plan/29).
pub fn check_new_rules(rules: &[Rule], after: &Layer) -> Result<(), String> {
    for r in rules {
        if plan_action(r, &after.actions).is_none() {
            return Err(crate::locale::tf("host.ruleNotPlan", &[("id", &r.id)]));
        }
    }
    Ok(())
}

fn unique_id(rules: &[Rule], kind: &str, action: &str) -> String {
    let taken = |id: &str| rules.iter().any(|r| r.id == id);
    let first = format!("{kind}-{action}");
    if valid_name(&first) && !taken(&first) {
        return first;
    }
    (2..)
        .map(|n| format!("{kind}-{n}"))
        .find(|id| !taken(id))
        .unwrap()
}

/// Sets when a learned action plays. Double-click belongs to one action at
/// a time: giving it to this one takes it from any other.
pub fn set_plan(root: &Path, pet: &str, action: &str, plan: &Plan) -> Result<(), String> {
    library::pet(root, pet)?;
    let mut out = layer(root, pet)?;
    if !learned(action, &out.actions) {
        return Err(crate::locale::t("host.noSuchAction"));
    }
    let label = out.actions[action].label.clone();
    let actions = out.actions.clone();
    out.rules
        .retain(|r| plan_action(r, &actions) != Some(action));
    if plan.double {
        out.rules
            .retain(|r| !matches!(&r.when, Trigger::Event { event } if event == "double-click"));
    }
    let mut add = Vec::new();
    if plan.double {
        add.push((
            "double",
            Trigger::Event {
                event: "double-click".into(),
            },
        ));
    }
    if let Some(per_hour) = plan.random {
        if !(per_hour.is_finite() && per_hour > 0.0 && per_hour <= 100.0) {
            return Err(crate::locale::t("host.planRandom"));
        }
        add.push(("random", Trigger::Random { weight: per_hour }));
    }
    if let Some(c) = &plan.clock {
        if c.at.starts_with('*') || !clock_ok(&c.at) {
            return Err(crate::locale::t("host.planTime"));
        }
        add.push((
            "daily",
            Trigger::Clock {
                at: c.at.clone(),
                days: c.weekdays.then(|| WEEKDAYS.to_vec()),
                window_minutes: None,
            },
        ));
    }
    for (kind, when) in add {
        let id = unique_id(&out.rules, kind, action);
        out.rules.push(Rule {
            id,
            label: label.clone(),
            enabled: true,
            when,
            steps: vec![Step {
                play: Some(action.into()),
                repeat: None,
                wait: None,
            }],
            chance: None,
            cooldown_minutes: None,
        });
    }
    check_layer(&out, &limits())?;
    save_version(
        root,
        pet,
        &out,
        crate::locale::tf("host.planSaved", &[("label", &label)]),
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn strip(frames: u32) -> Vec<u8> {
        let mut img = image::RgbaImage::new(192 * frames, 208);
        for f in 0..frames {
            img.put_pixel(f * 192 + 90, 150, image::Rgba([180, 120, 80, 255]));
        }
        let mut bytes = std::io::Cursor::new(Vec::new());
        img.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    }
    /// A pet that learned 转圈 and 打哈欠, and an old rule of another kind.
    fn setup(rules: serde_json::Value) -> (tempfile::TempDir, String, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let mika = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/mika");
        library::import(root.path(), &mika).unwrap();
        let pet = library::list(root.path()).unwrap()[0].id.clone();
        let teach = root.path().join("teach");
        fs::create_dir_all(teach.join("actions")).unwrap();
        fs::write(teach.join("actions/spin.png"), strip(3)).unwrap();
        fs::write(teach.join("actions/yawn.png"), strip(3)).unwrap();
        let a = |label: &str, image: &str| json!({"label": label, "image": image, "durations": [120, 120, 300]});
        let t = json!({
            "kind": "pet-teaching", "schemaVersion": 1, "petId": pet,
            "summary": "学转圈和打哈欠",
            "actions": {"spin": a("转圈", "actions/spin.png"), "yawn": a("打哈欠", "actions/yawn.png")},
            "rules": rules,
        });
        fs::write(teach.join("teaching.json"), t.to_string()).unwrap();
        (root, pet, teach)
    }
    fn plan_rules(root: &Path, pet: &str) -> Vec<(String, Trigger)> {
        let l = layer(root, pet).unwrap();
        l.rules
            .iter()
            .filter_map(|r| plan_action(r, &l.actions).map(|a| (a.to_owned(), r.when.clone())))
            .collect()
    }

    #[test]
    fn a_learned_action_gets_double_click_random_and_a_time() {
        let (dir, pet, teach) = setup(json!([]));
        let root = dir.path();
        let d = intake(root, &teach).unwrap();
        accept(root, &d.id).unwrap();
        let plan = Plan {
            double: true,
            random: Some(20.0),
            clock: Some(At {
                at: "09:00".into(),
                weekdays: true,
            }),
        };
        set_plan(root, &pet, "spin", &plan).unwrap();
        let rules = plan_rules(root, &pet);
        assert_eq!(rules.len(), 3);
        assert!(rules.iter().all(|(a, _)| a == "spin"));
        // How often it comes up is its own: times an hour.
        assert!(rules
            .iter()
            .any(|(_, w)| matches!(w, Trigger::Random { weight } if *weight == 20.0)));
        let never = Plan {
            random: Some(0.0),
            ..Plan::default()
        };
        assert!(set_plan(root, &pet, "spin", &never).is_err());
        assert!(rules.iter().any(|(_, w)| matches!(w,
            Trigger::Clock { at, days: Some(d), .. } if at == "09:00" && d[..] == WEEKDAYS)));
        // Setting it again replaces, never piles up.
        set_plan(
            root,
            &pet,
            "spin",
            &Plan {
                random: Some(20.0),
                ..Plan::default()
            },
        )
        .unwrap();
        assert_eq!(plan_rules(root, &pet).len(), 1);
        // Each change is a saved version the user can go back to.
        assert_eq!(history(root, &pet).unwrap().current, 3);
    }

    #[test]
    fn double_click_moves_to_the_last_action_given_it() {
        let (dir, pet, teach) = setup(json!([]));
        let root = dir.path();
        let d = intake(root, &teach).unwrap();
        accept(root, &d.id).unwrap();
        let double = Plan {
            double: true,
            ..Plan::default()
        };
        set_plan(root, &pet, "spin", &double).unwrap();
        set_plan(root, &pet, "yawn", &double).unwrap();
        let rules = plan_rules(root, &pet);
        assert_eq!(rules.len(), 1);
        assert_eq!(rules[0].0, "yawn");
    }

    #[test]
    fn base_actions_and_sleep_get_no_plan_and_old_rules_stay() {
        let (dir, pet, teach) = setup(json!([]));
        let root = dir.path();
        let d = intake(root, &teach).unwrap();
        accept(root, &d.id).unwrap();
        // An old rule of another kind, saved before plan/29.
        let mut l = layer(root, &pet).unwrap();
        l.rules.push(
            serde_json::from_value(json!({"id":"old","label":"单击转圈",
            "when":{"type":"event","event":"click"},"do":[{"play":"spin"}]}))
            .unwrap(),
        );
        save_version(root, &pet, &l, "旧规则".into()).unwrap();
        for name in ["waving", "sleep", "nope"] {
            assert!(set_plan(
                root,
                &pet,
                name,
                &Plan {
                    random: Some(20.0),
                    ..Plan::default()
                }
            )
            .is_err());
        }
        assert!(set_plan(
            root,
            &pet,
            "spin",
            &Plan {
                clock: Some(At {
                    at: "*:00".into(),
                    weekdays: false
                }),
                ..Plan::default()
            }
        )
        .is_err());
        set_plan(
            root,
            &pet,
            "spin",
            &Plan {
                random: Some(20.0),
                ..Plan::default()
            },
        )
        .unwrap();
        assert!(layer(root, &pet)
            .unwrap()
            .rules
            .iter()
            .any(|r| r.id == "old"));
    }

    #[test]
    fn a_teaching_may_only_add_plan_rules() {
        let ok = json!([{"id":"tea","label":"三点转圈","when":{"type":"clock","at":"15:00"},"do":[{"play":"spin"}]}]);
        let (dir, _, teach) = setup(ok);
        assert!(intake(dir.path(), &teach).is_ok());
        for bad in [
            json!({"type":"event","event":"click"}),
            json!({"type":"every","minutes":60}),
            json!({"type":"clock","at":"*:00"}),
        ] {
            let rules = json!([{"id":"x","label":"x","when":bad,"do":[{"play":"spin"}]}]);
            let (dir, _, teach) = setup(rules);
            assert!(intake(dir.path(), &teach).is_err());
        }
        // A base action is never scheduled, and a rule plays one action.
        for steps in [
            json!([{"play":"waving"}]),
            json!([{"play":"spin"},{"play":"yawn"}]),
        ] {
            let rules =
                json!([{"id":"x","label":"x","when":{"type":"random","weight":1},"do":steps}]);
            let (dir, _, teach) = setup(rules);
            assert!(intake(dir.path(), &teach).is_err());
        }
    }
}
