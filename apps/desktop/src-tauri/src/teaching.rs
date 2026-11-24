//! Custom actions and rules taught after a pet is made.
//!
//! The base pet package stays untouched. Each pet gets a separate custom
//! layer under `pets/<id>/custom/`: content-addressed images in `assets/` and
//! one `action-library.json` holding saved pictures and the current selection.
//! Legacy numbered snapshots are read once and kept as migration evidence.
//! A teaching delivered through the inbox
//! (see inbox.rs) becomes a draft until the user accepts or discards it.
use crate::library::{self, ACTIONS};
#[path = "teaching_archive.rs"]
pub mod archive;
#[path = "teaching_plan.rs"]
pub mod plan;
#[path = "teaching_replacements.rs"]
mod replacements;
use replacements::{check_replacements, check_source_version, replaceable_base};
#[cfg(test)]
#[path = "teaching_history_tests.rs"]
mod history_regression;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};

const CONTRACT: &str =
    include_str!("../../../../skills/teach-desktop-pet/references/teaching-contract.json");

struct Limits {
    max_frames: usize,
    min_frame_ms: u32,
    max_frame_ms: u32,
    max_actions: usize,
    max_rules: usize,
    max_steps: usize,
    max_repeat: u32,
    max_wait_ms: u32,
    max_image_bytes: u64,
    max_label: usize,
    max_summary: usize,
    max_minutes: f64,
    events: Vec<String>,
}
fn limits() -> Limits {
    let c: serde_json::Value = serde_json::from_str(CONTRACT).expect("teaching contract");
    let l = &c["limits"];
    let n = |k: &str| l[k].as_u64().expect(k);
    Limits {
        max_frames: n("maxFrames") as usize,
        min_frame_ms: n("minFrameMs") as u32,
        max_frame_ms: n("maxFrameMs") as u32,
        max_actions: n("maxActions") as usize,
        max_rules: n("maxRules") as usize,
        max_steps: n("maxSteps") as usize,
        max_repeat: n("maxRepeat") as u32,
        max_wait_ms: n("maxWaitMs") as u32,
        max_image_bytes: n("maxImageBytes"),
        max_label: n("maxLabel") as usize,
        max_summary: n("maxSummary") as usize,
        max_minutes: n("maxMinutes") as f64,
        events: c["events"]
            .as_object()
            .expect("events")
            .keys()
            .cloned()
            .collect(),
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CustomAction {
    pub label: String,
    pub image: String,
    pub durations: Vec<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_frames: Option<[usize; 2]>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "kebab-case", deny_unknown_fields)]
pub enum Trigger {
    #[serde(rename_all = "camelCase")]
    Clock {
        at: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        days: Option<Vec<u8>>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        window_minutes: Option<f64>,
    },
    Every {
        minutes: f64,
    },
    Random {
        weight: f64,
    },
    Event {
        event: String,
    },
    PetIdle {
        minutes: f64,
        #[serde(
            default,
            rename = "includeDefaultSleep",
            skip_serializing_if = "Option::is_none"
        )]
        include_default_sleep: Option<bool>,
    },
    Idle {
        minutes: f64,
    },
    Active {
        minutes: f64,
    },
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct Step {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub play: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub repeat: Option<u32>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wait: Option<u32>,
}
fn yes() -> bool {
    true
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Rule {
    pub id: String,
    pub label: String,
    #[serde(default = "yes")]
    pub enabled: bool,
    pub when: Trigger,
    #[serde(rename = "do")]
    pub steps: Vec<Step>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub chance: Option<f64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cooldown_minutes: Option<f64>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Layer {
    #[serde(default)]
    pub actions: BTreeMap<String, CustomAction>,
    #[serde(default)]
    pub rules: Vec<Rule>,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Removals {
    #[serde(default)]
    actions: Vec<String>,
    #[serde(default)]
    rules: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Teaching {
    kind: String,
    schema_version: u32,
    pet_id: String,
    summary: String,
    #[serde(default)]
    replace_actions: Vec<String>,
    #[serde(default)]
    base_version: Option<u32>,
    #[serde(default)]
    actions: BTreeMap<String, CustomAction>,
    #[serde(default)]
    rules: Vec<Rule>,
    #[serde(default)]
    remove: Removals,
    /// Free-form notes from the maker (prompts, chroma key); kept, not used.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    notes: Option<serde_json::Value>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Version {
    pub version: u32,
    pub summary: String,
    pub accepted_at: u64,
}
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct History {
    /// 0 means no custom layer is active.
    pub current: u32,
    pub versions: Vec<Version>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Custom {
    pub history: History,
    pub layer: Layer,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Draft {
    pub id: String,
    pub pet_id: String,
    pub summary: String,
    pub received_at: u64,
    pub added_actions: Vec<String>,
    pub added_rules: Vec<String>,
    pub removed_actions: Vec<String>,
    pub removed_rules: Vec<String>,
    /// The custom layer as it would be after accepting.
    pub preview: Layer,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0)
}
fn valid_name(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 40
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
}
fn read_json<T: serde::de::DeserializeOwned>(path: &Path) -> Result<T, String> {
    let bytes = fs::read(path).map_err(|e| format!("{}：{e}", path.display()))?;
    serde_json::from_slice(&bytes).map_err(|e| format!("{} 格式有误：{e}", path.display()))
}
fn custom_dir(root: &Path, pet: &str) -> PathBuf {
    root.join("pets").join(pet).join("custom")
}
fn legacy_history(root: &Path, pet: &str) -> Result<History, String> {
    let dir = custom_dir(root, pet);
    match fs::read(dir.join("history.json")) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|_| crate::locale::t("host.trickHistoryBad").into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            match fs::read_dir(dir.join("versions")) {
                Ok(entries) => {
                    for entry in entries {
                        let path = entry
                            .map_err(|_| crate::locale::t("host.trickVersionRead"))?
                            .path();
                        if path
                            .extension()
                            .and_then(|e| e.to_str())
                            .is_some_and(|e| e.eq_ignore_ascii_case("json"))
                        {
                            return Err(crate::locale::t("host.trickHistoryMissing").into());
                        }
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(_) => return Err(crate::locale::t("host.trickVersionRead").into()),
            }
            Ok(History::default())
        }
        Err(_) => Err(crate::locale::t("host.trickHistoryRead").into()),
    }
}
pub fn history(root: &Path, pet: &str) -> Result<History, String> {
    let (revision, _) = archive::current(root, pet)?;
    Ok(History {
        current: revision,
        versions: vec![],
    })
}
pub fn layer(root: &Path, pet: &str) -> Result<Layer, String> {
    Ok(archive::current(root, pet)?.1)
}
pub fn custom(root: &Path, pet: &str) -> Result<Custom, String> {
    let (revision, layer) = archive::current(root, pet)?;
    Ok(Custom {
        history: History {
            current: revision,
            versions: vec![],
        },
        layer,
    })
}

/// Validate a strip image: PNG/WebP, `frames` cells of 192x208, none empty.
pub(crate) fn validate_strip(bytes: &[u8], frames: usize) -> Result<&'static str, String> {
    let format = image::guess_format(bytes).map_err(|_| crate::locale::t("host.trickImageType"))?;
    let ext = match format {
        image::ImageFormat::Png => "png",
        image::ImageFormat::WebP => "webp",
        _ => return Err(crate::locale::t("host.trickImageType").into()),
    };
    let img = image::load_from_memory_with_format(bytes, format)
        .map_err(|e| e.to_string())?
        .into_rgba8();
    let (w, h) = img.dimensions();
    if (w, h) != (192 * frames as u32, 208) {
        return Err(format!(
            "{frames} 帧的动作图应为 {} × 208，实际为 {w} × {h}",
            192 * frames
        ));
    }
    for f in 0..frames as u32 {
        let filled = (0..208).any(|y| (f * 192..(f + 1) * 192).any(|x| img.get_pixel(x, y)[3] > 0));
        if !filled {
            return Err(crate::locale::tf(
                "host.trickEmptyFrame",
                &[("n", &(f + 1))],
            ));
        }
    }
    Ok(ext)
}
fn check_action(name: &str, a: &CustomAction, l: &Limits) -> Result<(), String> {
    if !valid_name(name) || (ACTIONS.contains(&name) && !replaceable_base(name)) {
        return Err(crate::locale::tf(
            "host.trickActionName",
            &[("name", &name)],
        ));
    }
    if a.label.trim().is_empty() || a.label.chars().count() > l.max_label {
        return Err(crate::locale::tf(
            "host.trickActionLabel",
            &[("name", &name), ("max", &l.max_label)],
        ));
    }
    if a.durations.is_empty() || a.durations.len() > l.max_frames {
        return Err(crate::locale::tf(
            "host.trickActionFrames",
            &[("name", &name), ("max", &l.max_frames)],
        ));
    }
    if replaceable_base(name) && a.loop_frames.is_some() {
        return Err(crate::locale::t("host.replaceProtected"));
    }
    if let Some([first, last]) = a.loop_frames {
        if first < 2 || first >= last || last >= a.durations.len() {
            return Err(crate::locale::tf("host.trickLoop", &[("name", &name)]));
        }
    }
    if a.durations
        .iter()
        .any(|d| *d < l.min_frame_ms || *d > l.max_frame_ms)
    {
        return Err(format!(
            "动作 {name} 每帧时长应在 {}–{} 毫秒",
            l.min_frame_ms, l.max_frame_ms
        ));
    }
    Ok(())
}
fn minutes_ok(v: f64, l: &Limits) -> bool {
    v.is_finite() && v > 0.0 && v <= l.max_minutes
}
fn clock_ok(at: &str) -> bool {
    let Some((h, m)) = at.split_once(':') else {
        return false;
    };
    let hour = h == "*" || (h.len() == 2 && h.parse::<u8>().is_ok_and(|v| v < 24));
    hour && m.len() == 2 && m.parse::<u8>().is_ok_and(|v| v < 60)
}
fn check_rule(
    r: &Rule,
    actions: &BTreeMap<String, CustomAction>,
    l: &Limits,
) -> Result<(), String> {
    let id = &r.id;
    if !valid_name(id) {
        return Err(crate::locale::tf("host.ruleIdBad", &[("id", &id)]));
    }
    if r.label.trim().is_empty() || r.label.chars().count() > l.max_label {
        return Err(crate::locale::tf(
            "host.ruleLabel",
            &[("id", &id), ("max", &l.max_label)],
        ));
    }
    let when_ok = match &r.when {
        Trigger::Clock {
            at,
            days,
            window_minutes,
        } => {
            clock_ok(at)
                && days
                    .as_ref()
                    .is_none_or(|d| !d.is_empty() && d.iter().all(|v| *v < 7))
                && window_minutes.is_none_or(|w| w.is_finite() && (1.0..=720.0).contains(&w))
        }
        Trigger::PetIdle { minutes, .. }
        | Trigger::Every { minutes }
        | Trigger::Idle { minutes }
        | Trigger::Active { minutes } => minutes_ok(*minutes, l),
        Trigger::Random { weight } => weight.is_finite() && *weight > 0.0 && *weight <= 100.0,
        Trigger::Event { event } => l.events.contains(event),
    };
    if !when_ok {
        return Err(crate::locale::tf("host.ruleWhen", &[("id", &id)]));
    }
    if r.steps.is_empty() || r.steps.len() > l.max_steps {
        return Err(crate::locale::tf(
            "host.ruleSteps",
            &[("id", &id), ("max", &l.max_steps)],
        ));
    }
    for s in &r.steps {
        match (&s.play, s.wait) {
            (Some(name), None) => {
                if !ACTIONS.contains(&name.as_str()) && !actions.contains_key(name) {
                    return Err(crate::locale::tf(
                        "host.ruleMissingAction",
                        &[("id", &id), ("name", &name)],
                    ));
                }
                if s.repeat.is_some_and(|n| n == 0 || n > l.max_repeat) {
                    return Err(crate::locale::tf(
                        "host.ruleRepeat",
                        &[("id", &id), ("max", &l.max_repeat)],
                    ));
                }
            }
            (None, Some(ms)) if s.repeat.is_none() && ms > 0 && ms <= l.max_wait_ms => {}
            _ => return Err(crate::locale::tf("host.ruleStepKind", &[("id", &id)])),
        }
    }
    if let Trigger::Event { event } = &r.when {
        if event == "drag" && r.steps[0].play.is_none() {
            return Err(crate::locale::tf("host.ruleDragFirst", &[("id", &id)]));
        }
    }
    if r.chance
        .is_some_and(|c| !(c.is_finite() && c > 0.0 && c <= 1.0))
    {
        return Err(crate::locale::tf("host.ruleChance", &[("id", &id)]));
    }
    if r.cooldown_minutes
        .is_some_and(|c| !(c.is_finite() && c >= 0.0 && c <= l.max_minutes))
    {
        return Err(crate::locale::tf("host.ruleCooldown", &[("id", &id)]));
    }
    Ok(())
}
fn check_layer(layer: &Layer, l: &Limits) -> Result<(), String> {
    if layer.actions.len() > l.max_actions || layer.rules.len() > l.max_rules {
        return Err(format!(
            "最多 {} 个自定义动作、{} 条规则",
            l.max_actions, l.max_rules
        ));
    }
    for (name, a) in &layer.actions {
        check_action(name, a, l)?;
    }
    let mut seen = std::collections::HashSet::new();
    for r in &layer.rules {
        if !seen.insert(&r.id) {
            return Err(crate::locale::tf("host.ruleIdDup", &[("id", &r.id)]));
        }
        check_rule(r, &layer.actions, l)?;
    }
    Ok(())
}
/// Apply a teaching on top of a layer. Same-named actions and rules replace.
fn merge(base: &Layer, t: &Teaching) -> Result<Layer, String> {
    check_replacements(base, t)?;
    let mut out = base.clone();
    for name in &t.remove.actions {
        if out.actions.remove(name).is_none() {
            return Err(crate::locale::tf(
                "host.removeMissingAction",
                &[("name", &name)],
            ));
        }
    }
    for id in &t.remove.rules {
        let before = out.rules.len();
        out.rules.retain(|r| &r.id != id);
        if out.rules.len() == before {
            return Err(crate::locale::tf("host.removeMissingRule", &[("id", &id)]));
        }
    }
    for (name, a) in &t.actions {
        out.actions.insert(name.clone(), a.clone());
    }
    for r in &t.rules {
        match out.rules.iter_mut().find(|x| x.id == r.id) {
            Some(slot) => *slot = r.clone(),
            None => out.rules.push(r.clone()),
        }
    }
    check_layer(&out, &limits())?;
    Ok(out)
}

/// Copy a teaching folder into `drafts/<id>/` after checking every file.
pub fn intake(root: &Path, source: &Path) -> Result<Draft, String> {
    let l = limits();
    let source = source.canonicalize().map_err(|e| e.to_string())?;
    let raw =
        fs::read(source.join("teaching.json")).map_err(|_| crate::locale::t("host.trickNoJson"))?;
    if raw.len() > 256 * 1024 {
        return Err(crate::locale::t("host.trickJsonBig").into());
    }
    let t: Teaching = serde_json::from_slice(&raw)
        .map_err(|e| crate::locale::tf("host.trickJsonFormat", &[("e", &e)]))?;
    if t.kind != "pet-teaching" || t.schema_version != 1 {
        return Err(crate::locale::t("host.trickNotOurs").into());
    }
    if t.summary.trim().is_empty() || t.summary.chars().count() > l.max_summary {
        return Err(crate::locale::t("host.trickSummary").into());
    }
    library::pet(root, &t.pet_id)
        .map_err(|_| crate::locale::tf("host.trickNoPet", &[("id", &t.pet_id)]))?;
    if t.actions.is_empty()
        && t.rules.is_empty()
        && t.remove.actions.is_empty()
        && t.remove.rules.is_empty()
    {
        return Err(crate::locale::t("host.trickNoChange").into());
    }
    check_source_version(root, &t)?;
    let draft_id = format!("{}-{}", now(), &format!("{:x}", Sha256::digest(&raw))[..8]);
    let staging = root.join("drafts").join(format!(".{draft_id}"));
    fs::create_dir_all(staging.join("actions")).map_err(|e| e.to_string())?;
    let result = (|| {
        let mut t = t.clone();
        for (name, a) in t.actions.iter_mut() {
            check_action(name, a, &l)?;
            library::relative(&a.image)?;
            let path = source
                .join(&a.image)
                .canonicalize()
                .map_err(|e| format!("{}：{e}", a.image))?;
            if !path.starts_with(&source) {
                return Err(crate::locale::t("host.trickImageInside").into());
            }
            let bytes = library::bounded(&path, l.max_image_bytes)?;
            let ext = validate_strip(&bytes, a.durations.len())?;
            a.image = format!("actions/{name}.{ext}");
            fs::write(staging.join(&a.image), bytes).map_err(|e| e.to_string())?;
        }
        let after = merge(&layer(root, &t.pet_id)?, &t)?;
        plan::check_new_rules(&t.rules, &after)?;
        library::write_json(&staging.join("teaching.json"), &t)?;
        let mut meta = serde_json::Map::new();
        meta.insert("receivedAt".into(), now().into());
        library::write_json(&staging.join("received.json"), &meta)?;
        fs::rename(&staging, root.join("drafts").join(&draft_id)).map_err(|e| e.to_string())
    })();
    if let Err(e) = result {
        let _ = fs::remove_dir_all(&staging);
        return Err(e);
    }
    archive::remember_draft(root, &draft_id)?;
    draft(root, &draft_id)
}
fn load_draft(root: &Path, id: &str) -> Result<(Teaching, u64), String> {
    if id.starts_with('.') || id.contains('/') || id.contains('\\') || id.contains("..") {
        return Err(crate::locale::t("host.draftId").into());
    }
    let dir = root.join("drafts").join(id);
    let t: Teaching = read_json(&dir.join("teaching.json"))?;
    let meta: serde_json::Value = read_json(&dir.join("received.json")).unwrap_or_default();
    Ok((t, meta["receivedAt"].as_u64().unwrap_or(0)))
}
pub fn draft(root: &Path, id: &str) -> Result<Draft, String> {
    let (t, received_at) = load_draft(root, id)?;
    let base = layer(root, &t.pet_id)?;
    let preview = merge(&base, &t)?;
    Ok(Draft {
        id: id.into(),
        pet_id: t.pet_id.clone(),
        summary: t.summary.clone(),
        received_at,
        added_actions: t.actions.keys().cloned().collect(),
        added_rules: t.rules.iter().map(|r| r.id.clone()).collect(),
        removed_actions: t.remove.actions.clone(),
        removed_rules: t.remove.rules.clone(),
        preview,
    })
}
pub fn drafts(root: &Path) -> Vec<Draft> {
    let mut out: Vec<Draft> = fs::read_dir(root.join("drafts"))
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|e| e.file_name().to_str().map(str::to_string))
        .filter(|n| !n.starts_with('.'))
        .filter_map(|n| draft(root, &n).ok())
        .collect();
    out.sort_by_key(|d| d.received_at);
    out
}
/// Drop every pending draft for a pet that is being removed.
pub fn discard_for(root: &Path, pet: &str) {
    for d in drafts(root).into_iter().filter(|d| d.pet_id == pet) {
        let _ = discard(root, &d.id);
    }
}
pub fn discard(root: &Path, id: &str) -> Result<(), String> {
    archive::remember_draft(root, id)?;
    fs::remove_dir_all(root.join("drafts").join(id)).map_err(|e| e.to_string())
}
pub fn accept(root: &Path, id: &str) -> Result<Version, String> {
    let (mut t, _) = load_draft(root, id)?;
    check_source_version(root, &t)?;
    let base = layer(root, &t.pet_id)?;
    check_replacements(&base, &t)?;
    let draft_dir = root.join("drafts").join(id);
    let dir = custom_dir(root, &t.pet_id);
    fs::create_dir_all(dir.join("assets")).map_err(|e| e.to_string())?;
    fs::create_dir_all(dir.join("versions")).map_err(|e| e.to_string())?;
    for a in t.actions.values_mut() {
        let bytes = fs::read(draft_dir.join(&a.image)).map_err(|e| e.to_string())?;
        let ext = Path::new(&a.image)
            .extension()
            .and_then(|s| s.to_str())
            .unwrap_or("png");
        let name = format!(
            "assets/{}.{ext}",
            &format!("{:x}", Sha256::digest(&bytes))[..16]
        );
        if !dir.join(&name).exists() {
            fs::write(dir.join(&name), &bytes).map_err(|e| e.to_string())?;
        }
        a.image = name;
    }
    let layer = merge(&base, &t)?;
    let version = save_version(root, &t.pet_id, &layer, t.summary.clone())?;
    fs::remove_dir_all(draft_dir).map_err(|e| e.to_string())?;
    Ok(version)
}
/// Update the current layer in place; saved action pictures are deduplicated.
fn save_version(root: &Path, pet: &str, layer: &Layer, summary: String) -> Result<Version, String> {
    archive::save_current(root, pet, layer, summary)
}
/// Save a new version without some learned actions or rules. Rules that
/// play a removed action go with it, so the pet never plays a missing clip.
pub fn forget(
    root: &Path,
    pet: &str,
    actions: &[String],
    rules: &[String],
) -> Result<Version, String> {
    library::pet(root, pet)?;
    let mut out = layer(root, pet)?;
    let mut gone = Vec::new();
    for name in actions {
        let a = out
            .actions
            .remove(name)
            .ok_or(crate::locale::t("host.noSuchAction"))?;
        gone.push(crate::locale::tf(
            "studio.actionNamed",
            &[("label", &a.label)],
        ));
    }
    for id in rules {
        if !out.rules.iter().any(|r| &r.id == id) {
            return Err(crate::locale::t("host.noSuchRule").into());
        }
    }
    out.rules.retain(|r| {
        let plays = r.steps.iter().any(|s| {
            s.play
                .as_ref()
                .is_some_and(|p| actions.contains(p) && !ACTIONS.contains(&p.as_str()))
        });
        if plays || rules.contains(&r.id) {
            gone.push(crate::locale::tf(
                "studio.ruleNamed",
                &[("label", &r.label)],
            ));
        }
        !(plays || rules.contains(&r.id))
    });
    if gone.is_empty() {
        return Err(crate::locale::t("host.nothingToRemove").into());
    }
    check_layer(&out, &limits())?;
    save_version(
        root,
        pet,
        &out,
        crate::locale::tf(
            "studio.removedList",
            &[("list", &gone.join(&crate::locale::t("reminders.dayJoiner")))],
        ),
    )
}
/// The layer saved as one version, for comparing before going back to it.
pub fn version_layer(root: &Path, pet: &str, version: u32) -> Result<Layer, String> {
    library::pet(root, pet)?;
    if version == 0 {
        return Ok(Layer::default());
    }
    let h = legacy_history(root, pet)?;
    if !h.versions.iter().any(|v| v.version == version) {
        return Err(crate::locale::t("host.noSuchVersion"));
    }
    read_json(&custom_dir(root, pet).join(format!("versions/{version}.json")))
}
/// Compatibility with old clients; the current UI restores one saved action at a time.
pub fn revert(root: &Path, pet: &str, version: u32) -> Result<(), String> {
    let old = version_layer(root, pet, version)?;
    archive::save_current(root, pet, &old, String::new())?;
    Ok(())
}
/// Image file for a custom action: from a draft when given, else accepted.
pub fn image_path(
    root: &Path,
    pet: &str,
    draft_id: Option<&str>,
    action: &str,
) -> Result<PathBuf, String> {
    let (layer, dir) = match draft_id {
        Some(id) => {
            let (t, _) = load_draft(root, id)?;
            if t.pet_id != pet {
                return Err(crate::locale::t("host.draftOtherPet").into());
            }
            (
                Layer {
                    actions: t.actions,
                    rules: vec![],
                },
                root.join("drafts").join(id),
            )
        }
        None => (layer(root, pet)?, custom_dir(root, pet)),
    };
    let a = layer
        .actions
        .get(action)
        .ok_or(crate::locale::t("host.noSuchAction"))?;
    library::relative(&a.image)?;
    Ok(dir.join(&a.image))
}
#[cfg(test)]
mod tests {
    use super::*;
    fn strip(frames: u32) -> Vec<u8> {
        let mut img = image::RgbaImage::new(192 * frames, 208);
        for f in 0..frames {
            img.put_pixel(f * 192 + 90, 150, image::Rgba([180, 120, 80, 255]));
        }
        let mut bytes = std::io::Cursor::new(Vec::new());
        img.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        bytes.into_inner()
    }
    fn setup() -> (tempfile::TempDir, PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let mika = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/mika");
        library::import(root.path(), &mika).unwrap();
        let pet = library::list(root.path()).unwrap()[0].id.clone();
        let teach = root.path().join("teach");
        fs::create_dir_all(teach.join("actions")).unwrap();
        fs::write(teach.join("actions/yawn.png"), strip(3)).unwrap();
        let t = serde_json::json!({
            "kind": "pet-teaching", "schemaVersion": 1, "petId": pet,
            "summary": "晚上十一点打哈欠",
            "actions": {"yawn": {"label": "打哈欠", "image": "actions/yawn.png", "durations": [120, 120, 300]}},
            "rules": [{"id": "night-yawn", "label": "晚上打哈欠",
                       "when": {"type": "clock", "at": "23:00"},
                       "do": [{"play": "yawn"}]}]
        });
        fs::write(teach.join("teaching.json"), t.to_string()).unwrap();
        (root, teach)
    }
    #[test]
    fn sustained_action_survives_accept_and_revert_for_another_pet() {
        let (dir, teach) = setup();
        let root = dir.path();
        let path = teach.join("teaching.json");
        let mut doc: serde_json::Value = read_json(&path).unwrap();
        let action = &mut doc["actions"]["yawn"];
        action["durations"] = serde_json::json!([120, 140, 160, 180]);
        action["loopFrames"] = serde_json::json!([2, 4]);
        fs::write(teach.join("actions/yawn.png"), strip(4)).unwrap();
        fs::write(&path, doc.to_string()).unwrap();
        assert!(intake(root, &teach).is_err());
        doc["actions"]["yawn"]["loopFrames"] = serde_json::json!([2, 3]);
        fs::write(&path, doc.to_string()).unwrap();
        let d = intake(root, &teach).unwrap();
        accept(root, &d.id).unwrap();
        assert_eq!(
            layer(root, &d.pet_id).unwrap().actions["yawn"].loop_frames,
            Some([2, 3])
        );
        revert(root, &d.pet_id, 0).unwrap();
        assert!(layer(root, &d.pet_id).unwrap().actions.is_empty());
    }
    #[test]
    fn editing_clock_time_is_independent_of_selecting_saved_pictures() {
        let (root, teach) = setup();
        let draft = intake(root.path(), &teach).unwrap();
        accept(root.path(), &draft.id).unwrap();
        let at = |at: &str| plan::Plan {
            clock: Some(plan::At {
                at: at.into(),
                weekdays: false,
            }),
            ..plan::Plan::default()
        };
        plan::set_plan(root.path(), &draft.pet_id, "yawn", &at("21:15")).unwrap();
        assert!(plan::set_plan(root.path(), &draft.pet_id, "yawn", &at("25:15")).is_err());
        let latest = layer(root.path(), &draft.pet_id).unwrap();
        assert!(matches!(&latest.rules[0].when, Trigger::Clock {at,..} if at == "21:15"));
        let saved = archive::list(root.path(), &draft.pet_id)
            .unwrap()
            .into_iter()
            .find(|i| i.name == "yawn")
            .unwrap();
        archive::select(root.path(), &draft.pet_id, &saved.id).unwrap();
        assert!(
            matches!(&layer(root.path(), &draft.pet_id).unwrap().rules[0].when, Trigger::Clock {at,..} if at == "21:15")
        );
    }
    #[test]
    fn draft_accept_and_undo() {
        let (root, teach) = setup();
        let root = root.path();
        let d = intake(root, &teach).unwrap();
        assert_eq!(d.added_actions, vec!["yawn"]);
        assert_eq!(drafts(root).len(), 1);
        // Nothing changes until the user accepts.
        assert!(layer(root, &d.pet_id).unwrap().rules.is_empty());
        let v = accept(root, &d.id).unwrap();
        assert_eq!(v.version, 1);
        assert!(drafts(root).is_empty());
        let l = layer(root, &d.pet_id).unwrap();
        assert_eq!(l.rules[0].steps.len(), 1);
        assert!(image_path(root, &d.pet_id, None, "yawn").unwrap().exists());
        revert(root, &d.pet_id, 0).unwrap();
        assert!(layer(root, &d.pet_id).unwrap().actions.is_empty());
        let saved = archive::list(root, &d.pet_id)
            .unwrap()
            .into_iter()
            .find(|i| i.name == "yawn")
            .unwrap();
        archive::select(root, &d.pet_id, &saved.id).unwrap();
        assert_eq!(layer(root, &d.pet_id).unwrap().actions.len(), 1);
    }
    #[test]
    fn forgetting_an_action_takes_its_rules_and_keeps_the_old_version() {
        let (root, teach) = setup();
        let root = root.path();
        let d = intake(root, &teach).unwrap();
        accept(root, &d.id).unwrap();
        let v = forget(root, &d.pet_id, &["yawn".into()], &[]).unwrap();
        assert_eq!(v.version, 2);
        assert_eq!(v.summary, "去掉动作「打哈欠」、规则「晚上打哈欠」");
        let l = layer(root, &d.pet_id).unwrap();
        assert!(l.actions.is_empty() && l.rules.is_empty());
        // The action remains saved, independently of its removed trigger.
        let saved = archive::list(root, &d.pet_id)
            .unwrap()
            .into_iter()
            .find(|i| i.name == "yawn")
            .unwrap();
        archive::select(root, &d.pet_id, &saved.id).unwrap();
        assert!(image_path(root, &d.pet_id, None, "yawn").unwrap().exists());
        assert!(layer(root, &d.pet_id).unwrap().rules.is_empty());
        let again = intake(root, &teach).unwrap();
        accept(root, &again.id).unwrap();
        forget(root, &d.pet_id, &[], &["night-yawn".into()]).unwrap();
        assert_eq!(layer(root, &d.pet_id).unwrap().actions.len(), 1);
        assert!(forget(root, &d.pet_id, &[], &["night-yawn".into()]).is_err());
    }
    #[test]
    fn rejects_bad_teachings() {
        let (root, teach) = setup();
        let root = root.path();
        let path = teach.join("teaching.json");
        let good: serde_json::Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        let cases: Vec<(&str, serde_json::Value)> = vec![
            ("/actions/yawn/durations", serde_json::json!([120, 120])),
            ("/rules/0/do/0/play", "missing".into()),
            ("/rules/0/when/at", "25:00".into()),
            ("/actions/yawn/image", "../x.png".into()),
            (
                "/rules/0/when",
                serde_json::json!({"type": "event", "event": "shake"}),
            ),
        ];
        for (pointer, value) in cases {
            let mut bad = good.clone();
            *bad.pointer_mut(pointer).unwrap() = value;
            fs::write(&path, bad.to_string()).unwrap();
            assert!(
                intake(root, &teach).is_err(),
                "{pointer} should be rejected"
            );
        }
        assert!(drafts(root).is_empty());
        assert!(fs::read_dir(root.join("drafts")).unwrap().next().is_none());
    }
    #[test]
    fn hourly_and_daily_clock_formats() {
        assert!(clock_ok("23:00") && clock_ok("*:30") && clock_ok("07:05"));
        assert!(!clock_ok("7:05") && !clock_ok("24:00") && !clock_ok("*:60"));
    }
}
