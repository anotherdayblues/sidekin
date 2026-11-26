//! OpenPets Classic compatible wardrobe, gaze anchor, and idle activity
//! schema validation, normalization, and preference helpers.

use serde::{Deserialize, Serialize};
use std::collections::HashSet;

pub const DEFAULT_OUTFIT_ID: &str = "default";
pub const AUTOMATIC_OUTFIT_CHOICE: &str = "auto";
pub const MAX_PET_OUTFITS: usize = 16;
pub const MAX_OUTFIT_SCHEDULE_RULES: usize = 32;
pub const MAX_OUTFIT_DISPLAY_NAME: usize = 40;
pub const MAX_PET_ACTIVITIES: usize = 16;
pub const ACTIVITY_FRAME_WIDTH: u32 = 192;
pub const ACTIVITY_FRAME_HEIGHT: u32 = 208;
pub const MIN_ACTIVITY_FRAMES: u32 = 4;
pub const MAX_ACTIVITY_FRAMES: u32 = 32;
pub const MIN_ACTIVITY_FPS: u32 = 1;
pub const MAX_ACTIVITY_FPS: u32 = 12;
pub const MIN_ACTIVITY_DURATION_MS: u64 = 1_000;
pub const MAX_ACTIVITY_DURATION_MS: u64 = 12_000;
pub const MAX_ACTIVITY_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_ACTIVITY_TOTAL_BYTES: u64 = 32 * 1024 * 1024;

pub const WEEKDAYS: [&str; 7] = ["sun", "mon", "tue", "wed", "thu", "fri", "sat"];
const DAYS_IN_MONTH: [u8; 12] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GazeAnchor {
    pub x: f64,
    pub y: f64,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutfitTimeRange {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutfitDateRange {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutfitScheduleWhen {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub time: Option<OutfitTimeRange>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub days: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub dates: Option<OutfitDateRange>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutfitScheduleRule {
    pub outfit: String,
    pub when: OutfitScheduleWhen,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub enabled: Option<bool>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetOutfit {
    pub id: String,
    pub display_name: String,
    pub spritesheet_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sleep_strip: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetWardrobe {
    pub outfits: Vec<PetOutfit>,
    #[serde(default)]
    pub schedule: Vec<OutfitScheduleRule>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetActivityAnimation {
    pub outfit_id: String,
    pub spritesheet_path: String,
    pub frame_count: u32,
    pub fps: u32,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PetActivity {
    pub id: String,
    pub display_name: String,
    pub outfit_id: String,
    pub spritesheet_path: String,
    pub frame_count: u32,
    pub fps: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outfit_variants: Option<Vec<PetActivityAnimation>>,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct PetWardrobePreference {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub outfit: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule: Option<Vec<OutfitScheduleRule>>,
}

/// Outfit descriptor inside an incremental `outfit.json` inbox delivery.
/// `displayName` and `spritesheetPath` may be omitted for a sleep-only patch
/// targeting an already-installed outfit.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutfitPackageOutfit {
    pub id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub display_name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spritesheet_path: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sleep_strip: Option<String>,
}

/// Incremental `outfit.json` inbox delivery manifest for adding or updating a
/// single outfit (with optional creator schedule rule, per-outfit sleepStrip,
/// and outfit-specific activities) on an existing installed pet without touching
/// its base atlas, base sleep strip, or custom layer.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct OutfitPackageManifest {
    pub pet_id: String,
    pub outfit: OutfitPackageOutfit,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub schedule_rule: Option<OutfitScheduleRule>,
    #[serde(default)]
    pub activities: Vec<PetActivity>,
}

pub fn validate_outfit_id(id: &str) -> Result<(), String> {
    if !is_safe_id(id) || id == DEFAULT_OUTFIT_ID || id == AUTOMATIC_OUTFIT_CHOICE {
        return Err(format!("Pet wardrobe outfit id is invalid: {id}"));
    }
    Ok(())
}

pub fn validate_outfit_sleep_strip(
    outfit_id: &str,
    sleep_strip: &Option<String>,
) -> Result<Option<String>, String> {
    let Some(path) = sleep_strip else {
        return Ok(None);
    };
    let expected_png = format!("outfits/{outfit_id}-sleep.png");
    let expected_webp = format!("outfits/{outfit_id}-sleep.webp");
    if path != &expected_png && path != &expected_webp {
        return Err(format!(
            "Pet wardrobe outfit sleepStrip must be {expected_png} or {expected_webp}"
        ));
    }
    Ok(Some(path.clone()))
}

pub fn validate_single_outfit(entry: &PetOutfit) -> Result<PetOutfit, String> {
    validate_outfit_id(&entry.id)?;
    let name = entry.display_name.trim();
    if name.is_empty() || name.chars().count() > MAX_OUTFIT_DISPLAY_NAME {
        return Err(format!(
            "Pet wardrobe outfit displayName is invalid: {}",
            entry.id
        ));
    }
    let expected_webp = format!("outfits/{}.webp", entry.id);
    let expected_png = format!("outfits/{}.png", entry.id);
    if entry.spritesheet_path != expected_webp && entry.spritesheet_path != expected_png {
        return Err(format!(
            "Pet wardrobe outfit spritesheetPath must be {expected_webp} or {expected_png}"
        ));
    }
    let sleep_strip = validate_outfit_sleep_strip(&entry.id, &entry.sleep_strip)?;
    Ok(PetOutfit {
        id: entry.id.clone(),
        display_name: name.to_owned(),
        spritesheet_path: entry.spritesheet_path.clone(),
        sleep_strip,
    })
}

/// Validates a single activity animation entry used by incremental `outfit.json` delivery.
/// When `as_variant` is true, expects `activities/{id}.{outfitId}.{webp|png}`;
/// otherwise expects `activities/{id}.{webp|png}`.
pub fn validate_outfit_activity_entry(
    activity: &PetActivity,
    target_outfit_id: &str,
    as_variant: bool,
) -> Result<PetActivity, String> {
    if !is_safe_id(&activity.id) {
        return Err(format!("Pet activity id is invalid: {}", activity.id));
    }
    let name = activity.display_name.trim();
    if name.is_empty() || name.chars().count() > MAX_OUTFIT_DISPLAY_NAME {
        return Err(format!(
            "Pet activity displayName must be 1..={MAX_OUTFIT_DISPLAY_NAME} chars: {}",
            activity.id
        ));
    }
    if activity.outfit_id != target_outfit_id {
        return Err(format!(
            "Outfit package activity '{}' must target outfit '{}'",
            activity.id, target_outfit_id
        ));
    }
    if activity
        .outfit_variants
        .as_ref()
        .is_some_and(|v| !v.is_empty())
    {
        return Err(format!(
            "Outfit package activity '{}' must only target outfit '{}'",
            activity.id, target_outfit_id
        ));
    }
    let mut available = HashSet::new();
    available.insert(target_outfit_id);
    let mut seen = HashSet::new();
    let validated = validate_activity_animation(
        &activity.id,
        &activity.outfit_id,
        &activity.spritesheet_path,
        activity.frame_count,
        activity.fps,
        !as_variant,
        &available,
        &mut seen,
    )?;
    Ok(PetActivity {
        id: activity.id.clone(),
        display_name: name.to_owned(),
        outfit_id: validated.outfit_id,
        spritesheet_path: validated.spritesheet_path,
        frame_count: validated.frame_count,
        fps: validated.fps,
        outfit_variants: None,
    })
}

pub fn is_safe_id(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.is_empty() || bytes.len() > 32 {
        return false;
    }
    let first = bytes[0];
    if !(first.is_ascii_lowercase() || first.is_ascii_digit()) {
        return false;
    }
    bytes[1..]
        .iter()
        .all(|&b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

pub fn validate_gaze_anchor(anchor: &GazeAnchor) -> Result<GazeAnchor, String> {
    if !anchor.x.is_finite()
        || !anchor.y.is_finite()
        || !(0.0..=1.0).contains(&anchor.x)
        || !(0.0..=1.0).contains(&anchor.y)
    {
        return Err("gazeAnchor must contain finite normalized x and y in [0, 1]".into());
    }
    Ok(anchor.clone())
}

fn parse_clock_minutes(value: &str) -> Option<u16> {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b':' {
        return None;
    }
    let h: u16 = value[0..2].parse().ok()?;
    let m: u16 = value[3..5].parse().ok()?;
    if h > 23 || m > 59 {
        return None;
    }
    Some(h * 60 + m)
}

fn parse_month_day(value: &str) -> Option<u16> {
    let bytes = value.as_bytes();
    if bytes.len() != 5 || bytes[2] != b'-' {
        return None;
    }
    let month: usize = value[0..2].parse().ok()?;
    let day: u8 = value[3..5].parse().ok()?;
    if !(1..=12).contains(&month) || day < 1 || day > DAYS_IN_MONTH[month - 1] {
        return None;
    }
    Some((month as u16) * 100 + day as u16)
}

pub fn validate_schedule_rule(
    rule: &OutfitScheduleRule,
    outfit_ids: &HashSet<&str>,
) -> Result<OutfitScheduleRule, String> {
    if !is_safe_id(&rule.outfit)
        || (rule.outfit != DEFAULT_OUTFIT_ID && !outfit_ids.contains(rule.outfit.as_str()))
    {
        return Err(format!(
            "Pet wardrobe schedule references an unknown outfit: {}",
            rule.outfit
        ));
    }

    let time = match &rule.when.time {
        Some(t) => {
            if parse_clock_minutes(&t.from).is_none()
                || parse_clock_minutes(&t.to).is_none()
                || t.from == t.to
            {
                return Err(
                    "Outfit schedule time must have different from/to values in HH:MM".into(),
                );
            }
            Some(t.clone())
        }
        None => None,
    };

    let days = match &rule.when.days {
        Some(list) => {
            if list.is_empty() || list.iter().any(|d| !WEEKDAYS.contains(&d.as_str())) {
                return Err("Outfit schedule days must be a non-empty list of sun..sat".into());
            }
            let ordered: Vec<String> = WEEKDAYS
                .iter()
                .filter(|&&day| list.iter().any(|d| d == day))
                .map(|&day| day.to_owned())
                .collect();
            Some(ordered)
        }
        None => None,
    };

    let dates = match &rule.when.dates {
        Some(d) => {
            if parse_month_day(&d.from).is_none() || parse_month_day(&d.to).is_none() {
                return Err("Outfit schedule dates must have from/to values in MM-DD".into());
            }
            Some(d.clone())
        }
        None => None,
    };

    if time.is_none() && days.is_none() && dates.is_none() {
        return Err("Outfit schedule rule needs at least one condition".into());
    }

    Ok(OutfitScheduleRule {
        outfit: rule.outfit.clone(),
        when: OutfitScheduleWhen { time, days, dates },
        enabled: if rule.enabled == Some(false) {
            Some(false)
        } else {
            None
        },
    })
}

pub fn validate_wardrobe(wardrobe: &PetWardrobe) -> Result<PetWardrobe, String> {
    if wardrobe.outfits.is_empty() || wardrobe.outfits.len() > MAX_PET_OUTFITS {
        return Err(format!(
            "Pet wardrobe must list between 1 and {MAX_PET_OUTFITS} outfits"
        ));
    }

    let mut outfits = Vec::with_capacity(wardrobe.outfits.len());
    let mut seen = HashSet::new();
    for entry in &wardrobe.outfits {
        let validated = validate_single_outfit(entry)?;
        if !seen.insert(entry.id.as_str()) {
            return Err(format!(
                "Pet wardrobe outfit id is duplicated: {}",
                entry.id
            ));
        }
        outfits.push(validated);
    }

    if wardrobe.schedule.len() > MAX_OUTFIT_SCHEDULE_RULES {
        return Err(format!(
            "Pet wardrobe schedule must have at most {MAX_OUTFIT_SCHEDULE_RULES} rules"
        ));
    }

    let mut schedule = Vec::with_capacity(wardrobe.schedule.len());
    for rule in &wardrobe.schedule {
        schedule.push(validate_schedule_rule(rule, &seen)?);
    }

    Ok(PetWardrobe { outfits, schedule })
}

fn validate_activity_animation(
    activity_id: &str,
    outfit_id: &str,
    spritesheet_path: &str,
    frame_count: u32,
    fps: u32,
    primary: bool,
    available_outfits: &HashSet<&str>,
    seen_outfits: &mut HashSet<String>,
) -> Result<PetActivityAnimation, String> {
    if !is_safe_id(outfit_id)
        || (outfit_id != DEFAULT_OUTFIT_ID && !available_outfits.contains(outfit_id))
    {
        return Err(format!(
            "Pet activity '{activity_id}' references an unknown outfit: {outfit_id}"
        ));
    }
    if !seen_outfits.insert(outfit_id.to_owned()) {
        return Err(format!(
            "Pet activity '{activity_id}' duplicates outfit: {outfit_id}"
        ));
    }
    let (expected_webp, expected_png) = if primary {
        (
            format!("activities/{activity_id}.webp"),
            format!("activities/{activity_id}.png"),
        )
    } else {
        (
            format!("activities/{activity_id}.{outfit_id}.webp"),
            format!("activities/{activity_id}.{outfit_id}.png"),
        )
    };
    if spritesheet_path != expected_webp && spritesheet_path != expected_png {
        return Err(format!(
            "Pet activity spritesheetPath must be {expected_webp} or {expected_png}"
        ));
    }
    if !(MIN_ACTIVITY_FRAMES..=MAX_ACTIVITY_FRAMES).contains(&frame_count) {
        return Err(format!(
            "Pet activity frameCount must be between {MIN_ACTIVITY_FRAMES} and {MAX_ACTIVITY_FRAMES}"
        ));
    }
    if !(MIN_ACTIVITY_FPS..=MAX_ACTIVITY_FPS).contains(&fps) {
        return Err(format!(
            "Pet activity fps must be between {MIN_ACTIVITY_FPS} and {MAX_ACTIVITY_FPS}"
        ));
    }
    let num = u64::from(frame_count) * 1_000;
    let den = u64::from(fps);
    if num < MIN_ACTIVITY_DURATION_MS * den || num > MAX_ACTIVITY_DURATION_MS * den {
        return Err(format!(
            "Pet activity duration must be between {MIN_ACTIVITY_DURATION_MS} and {MAX_ACTIVITY_DURATION_MS} ms"
        ));
    }
    Ok(PetActivityAnimation {
        outfit_id: outfit_id.to_owned(),
        spritesheet_path: spritesheet_path.to_owned(),
        frame_count,
        fps,
    })
}

pub fn validate_activities(
    activities: &[PetActivity],
    available_outfit_ids: &[String],
) -> Result<Vec<PetActivity>, String> {
    if activities.len() > MAX_PET_ACTIVITIES {
        return Err(format!(
            "Pet activities must have at most {MAX_PET_ACTIVITIES} entries"
        ));
    }
    let available: HashSet<&str> = available_outfit_ids.iter().map(String::as_str).collect();
    let mut seen_ids = HashSet::new();
    let mut out = Vec::with_capacity(activities.len());

    for entry in activities {
        if !is_safe_id(&entry.id) {
            return Err(format!("Pet activity id is invalid: {}", entry.id));
        }
        if !seen_ids.insert(entry.id.as_str()) {
            return Err(format!("Pet activity id is duplicated: {}", entry.id));
        }
        let name = entry.display_name.trim();
        if name.is_empty() || name.chars().count() > MAX_OUTFIT_DISPLAY_NAME {
            return Err(format!(
                "Pet activity displayName must be 1..={MAX_OUTFIT_DISPLAY_NAME} chars: {}",
                entry.id
            ));
        }

        let mut seen_outfits = HashSet::new();
        let primary = validate_activity_animation(
            &entry.id,
            &entry.outfit_id,
            &entry.spritesheet_path,
            entry.frame_count,
            entry.fps,
            true,
            &available,
            &mut seen_outfits,
        )?;

        let variants = match &entry.outfit_variants {
            Some(list) => {
                if list.len() > MAX_PET_OUTFITS {
                    return Err(format!(
                        "Pet activity outfitVariants must have at most {MAX_PET_OUTFITS} entries"
                    ));
                }
                let mut validated = Vec::with_capacity(list.len());
                for variant in list {
                    validated.push(validate_activity_animation(
                        &entry.id,
                        &variant.outfit_id,
                        &variant.spritesheet_path,
                        variant.frame_count,
                        variant.fps,
                        false,
                        &available,
                        &mut seen_outfits,
                    )?);
                }
                if validated.is_empty() {
                    None
                } else {
                    Some(validated)
                }
            }
            None => None,
        };

        out.push(PetActivity {
            id: entry.id.clone(),
            display_name: name.to_owned(),
            outfit_id: primary.outfit_id,
            spritesheet_path: primary.spritesheet_path,
            frame_count: primary.frame_count,
            fps: primary.fps,
            outfit_variants: variants,
        });
    }

    Ok(out)
}

/// Lists `(spritesheet_path, frame_count)` for an activity's primary strip and all outfit variants.
pub fn activity_strip_specs(activity: &PetActivity) -> Vec<(&str, u32)> {
    let mut specs = Vec::with_capacity(
        1 + activity
            .outfit_variants
            .as_ref()
            .map_or(0, std::vec::Vec::len),
    );
    specs.push((activity.spritesheet_path.as_str(), activity.frame_count));
    if let Some(variants) = &activity.outfit_variants {
        for v in variants {
            specs.push((v.spritesheet_path.as_str(), v.frame_count));
        }
    }
    specs
}

/// Validates an activity horizontal spritesheet strip: PNG or WebP, exact
/// `192 * frame_count x 208` dimensions, and decodable RGBA pixels.
pub fn validate_activity_strip(bytes: &[u8], expected_frames: u32) -> Result<&'static str, String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_ACTIVITY_BYTES {
        return Err("Pet activity spritesheet size is invalid".into());
    }
    if !(MIN_ACTIVITY_FRAMES..=MAX_ACTIVITY_FRAMES).contains(&expected_frames) {
        return Err("Pet activity frameCount is out of range".into());
    }
    let format = image::guess_format(bytes)
        .map_err(|_| "Pet activity spritesheet must be PNG or WebP".to_owned())?;
    let ext = match format {
        image::ImageFormat::Png => "png",
        image::ImageFormat::WebP => "webp",
        _ => return Err("Pet activity spritesheet must be PNG or WebP".into()),
    };
    let reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let (w, h) = reader.into_dimensions().map_err(|e| e.to_string())?;
    let expected_w = ACTIVITY_FRAME_WIDTH * expected_frames;
    if (w, h) != (expected_w, ACTIVITY_FRAME_HEIGHT) {
        return Err(format!(
            "Pet activity strip must be {expected_w} x {ACTIVITY_FRAME_HEIGHT}, got {w} x {h}"
        ));
    }
    let _img = image::load_from_memory_with_format(bytes, format)
        .map_err(|e| e.to_string())?
        .into_rgba8();
    Ok(ext)
}

pub fn validate_wardrobe_preference(
    pet: &crate::library::Pet,
    preference: Option<PetWardrobePreference>,
) -> Result<Option<PetWardrobePreference>, String> {
    let Some(pref) = preference else {
        return Ok(None);
    };
    let outfit_ids: HashSet<&str> = pet
        .wardrobe
        .as_ref()
        .map(|w| w.outfits.iter().map(|o| o.id.as_str()).collect())
        .unwrap_or_default();

    let outfit = match pref.outfit.as_deref().map(str::trim) {
        None | Some("") | Some(AUTOMATIC_OUTFIT_CHOICE) => None,
        Some(id) => {
            if !is_safe_id(id) || (id != DEFAULT_OUTFIT_ID && !outfit_ids.contains(id)) {
                return Err(format!("Unknown wardrobe outfit: {id}"));
            }
            Some(id.to_owned())
        }
    };

    let schedule = match pref.schedule {
        Some(rules) => {
            if rules.len() > MAX_OUTFIT_SCHEDULE_RULES {
                return Err(format!(
                    "Outfit schedule must have at most {MAX_OUTFIT_SCHEDULE_RULES} rules"
                ));
            }
            let mut validated = Vec::with_capacity(rules.len());
            for rule in &rules {
                validated.push(validate_schedule_rule(rule, &outfit_ids)?);
            }
            Some(validated)
        }
        None => None,
    };

    if outfit.is_none() && schedule.is_none() {
        Ok(None)
    } else {
        Ok(Some(PetWardrobePreference { outfit, schedule }))
    }
}

pub fn validate_activity_preference(
    pet: &crate::library::Pet,
    enabled: Option<Vec<String>>,
) -> Result<Option<Vec<String>>, String> {
    let Some(list) = enabled else {
        return Ok(None);
    };
    let known: HashSet<&str> = pet
        .activities
        .as_ref()
        .map(|items| items.iter().map(|a| a.id.as_str()).collect())
        .unwrap_or_default();
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(list.len());
    for id in list {
        if !is_safe_id(&id) || !known.contains(id.as_str()) {
            return Err(format!("Unknown pet activity: {id}"));
        }
        if seen.insert(id.clone()) {
            out.push(id);
        }
    }
    Ok(Some(out))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::library;
    use std::io::Write;
    use std::path::Path;

    fn make_atlas_png(version: u8, populate_neutral_pose: bool, populate_extra_unused: bool) -> Vec<u8> {
        let h = if version == 2 { 2288 } else { 1872 };
        let mut img = image::RgbaImage::new(1536, h);
        let frames = [6u32, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
        for row in 0..(h / 208) {
            for col in 0..frames[row as usize] {
                img.put_pixel(col * 192 + 10, row * 208 + 10, image::Rgba([255, 140, 60, 255]));
            }
        }
        if populate_neutral_pose && version == 2 {
            // V2 neutral pose cell: (row 0, col 6)
            img.put_pixel(6 * 192 + 20, 20, image::Rgba([80, 160, 240, 255]));
        }
        if populate_extra_unused {
            // Faint alpha bleed in an unused cell (row 3, col 7)
            img.put_pixel(7 * 192 + 5, 3 * 208 + 5, image::Rgba([10, 20, 30, 5]));
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    fn make_strip_png(frames: u32) -> Vec<u8> {
        let mut img = image::RgbaImage::new(192 * frames, 208);
        for f in 0..frames {
            img.put_pixel(f * 192 + 4, 4, image::Rgba([200, 100, 50, 255]));
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    #[test]
    fn openpets_v2_with_neutral_pose_and_unused_alpha_bleed_imports_cleanly() {
        let root = tempfile::tempdir().unwrap();
        let pkg = tempfile::tempdir().unwrap();
        let sheet = make_atlas_png(2, true, true);
        std::fs::write(pkg.path().join("spritesheet.png"), &sheet).unwrap();
        std::fs::write(
            pkg.path().join("pet.json"),
            br#"{
                "id": "neutral-cat",
                "displayName": "Neutral Pose Cat With A Longer Display Name",
                "description": "OpenPets v2 test",
                "spriteVersionNumber": 2,
                "spritesheetPath": "spritesheet.png",
                "gazeAnchor": { "x": 0.5, "y": 0.42 }
            }"#,
        )
        .unwrap();

        let imported = library::import(root.path(), pkg.path()).unwrap().pet;
        assert_eq!(imported.id, "neutral-cat");
        assert_eq!(imported.display_name.chars().count(), library::NAME_MAX);
        assert_eq!(imported.gaze_anchor, Some(GazeAnchor { x: 0.5, y: 0.42 }));
        assert!(imported.wardrobe.is_none());
        assert!(imported.activities.is_none());
    }

    #[test]
    fn openpets_v2_still_rejects_empty_active_frame_and_bad_gaze_anchor() {
        let root = tempfile::tempdir().unwrap();
        let pkg = tempfile::tempdir().unwrap();
        // Missing active pixel in row 0 col 0
        let img = image::RgbaImage::new(1536, 2288);
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
        std::fs::write(pkg.path().join("spritesheet.png"), buf.into_inner()).unwrap();
        std::fs::write(
            pkg.path().join("pet.json"),
            br#"{"id":"empty-cat","displayName":"Empty","spriteVersionNumber":2,"spritesheetPath":"spritesheet.png"}"#,
        )
        .unwrap();
        assert!(library::import(root.path(), pkg.path()).is_err());

        // Invalid gaze anchor (> 1.0)
        assert!(validate_gaze_anchor(&GazeAnchor { x: 1.5, y: 0.5 }).is_err());
        assert!(validate_gaze_anchor(&GazeAnchor { x: f64::NAN, y: 0.5 }).is_err());
    }

    #[test]
    fn wardrobe_five_outfits_and_activities_import_serve_export_and_preserve_custom() {
        let root = tempfile::tempdir().unwrap();
        let stage = tempfile::tempdir().unwrap();
        let zip_path = stage.path().join("wrapped-wardrobe.zip");

        let base_sheet = make_atlas_png(2, true, false);
        let outfit_sheet = make_atlas_png(2, true, false);
        let stretch_default = make_strip_png(8);
        let stretch_pajamas = make_strip_png(8);
        let wave_default = make_strip_png(6);

        let manifest = serde_json::json!({
            "id": "hoodie-synth",
            "displayName": "Hoodie Synth",
            "description": "Wardrobe + Activities pack",
            "spriteVersionNumber": 2,
            "spritesheetPath": "spritesheet.png",
            "gazeAnchor": { "x": 0.5, "y": 0.4 },
            "wardrobe": {
                "outfits": [
                    { "id": "pajamas", "displayName": "Pajamas", "spritesheetPath": "outfits/pajamas.png" },
                    { "id": "weekend", "displayName": "Weekend", "spritesheetPath": "outfits/weekend.png" },
                    { "id": "summer", "displayName": "Summer", "spritesheetPath": "outfits/summer.png" },
                    { "id": "halloween", "displayName": "Halloween", "spritesheetPath": "outfits/halloween.png" },
                    { "id": "holidays", "displayName": "Holidays", "spritesheetPath": "outfits/holidays.png" }
                ],
                "schedule": [
                    { "outfit": "holidays", "when": { "dates": { "from": "12-15", "to": "01-02" } } },
                    { "outfit": "pajamas", "when": { "time": { "from": "22:00", "to": "07:00" } } },
                    { "outfit": "weekend", "when": { "days": ["sat", "sun"] } }
                ]
            },
            "activities": [
                {
                    "id": "stretch",
                    "displayName": "Stretch",
                    "outfitId": "default",
                    "spritesheetPath": "activities/stretch.png",
                    "frameCount": 8,
                    "fps": 4,
                    "outfitVariants": [
                        {
                            "outfitId": "pajamas",
                            "spritesheetPath": "activities/stretch.pajamas.png",
                            "frameCount": 8,
                            "fps": 4
                        }
                    ]
                },
                {
                    "id": "wave-hello",
                    "displayName": "Wave Hello",
                    "outfitId": "default",
                    "spritesheetPath": "activities/wave-hello.png",
                    "frameCount": 6,
                    "fps": 4
                }
            ]
        });

        // Wrap everything inside a single top-level wrapper folder + __MACOSX noise
        {
            let mut zip = zip::ZipWriter::new(std::fs::File::create(&zip_path).unwrap());
            let opts = zip::write::SimpleFileOptions::default();
            zip.start_file("__MACOSX/hoodie-synth/._pet.json", opts).unwrap();
            zip.write_all(b"junk").unwrap();
            zip.start_file("hoodie-synth/pet.json", opts).unwrap();
            zip.write_all(&serde_json::to_vec_pretty(&manifest).unwrap()).unwrap();
            zip.start_file("hoodie-synth/spritesheet.png", opts).unwrap();
            zip.write_all(&base_sheet).unwrap();
            for oid in ["pajamas", "weekend", "summer", "halloween", "holidays"] {
                zip.start_file(format!("hoodie-synth/outfits/{oid}.png"), opts).unwrap();
                zip.write_all(&outfit_sheet).unwrap();
            }
            zip.start_file("hoodie-synth/activities/stretch.png", opts).unwrap();
            zip.write_all(&stretch_default).unwrap();
            zip.start_file("hoodie-synth/activities/stretch.pajamas.png", opts).unwrap();
            zip.write_all(&stretch_pajamas).unwrap();
            zip.start_file("hoodie-synth/activities/wave-hello.png", opts).unwrap();
            zip.write_all(&wave_default).unwrap();
            zip.finish().unwrap();
        }

        let imported = library::import(root.path(), &zip_path).unwrap();
        assert!(!imported.updated);
        let pet = imported.pet;
        assert_eq!(pet.wardrobe.as_ref().unwrap().outfits.len(), 5);
        // Days are normalized into canonical sun..sat order
        assert_eq!(
            pet.wardrobe.as_ref().unwrap().schedule[2].when.days.as_deref(),
            Some(&["sun".to_owned(), "sat".to_owned()][..])
        );
        assert_eq!(pet.activities.as_ref().unwrap().len(), 2);

        // Asset allowlist & outfit thumbnail resolution
        assert!(library::outfit_sheet_path(root.path(), "hoodie-synth", "pajamas").unwrap().is_file());
        assert!(library::outfit_sheet_path(root.path(), "hoodie-synth", "unknown").is_err());
        assert!(library::outfit_thumbnail(root.path(), "hoodie-synth", "pajamas").unwrap().is_file());
        assert!(library::outfit_thumbnail(root.path(), "hoodie-synth", "default").unwrap().is_file());
        assert!(library::pet_asset_path(root.path(), "hoodie-synth", "activities/stretch.pajamas.png").unwrap().is_file());
        assert!(library::pet_asset_path(root.path(), "hoodie-synth", "pet.json").is_err());
        assert!(library::pet_asset_path(root.path(), "hoodie-synth", "../settings.json").is_err());

        // Preference validation
        let pref = validate_wardrobe_preference(
            &pet,
            Some(PetWardrobePreference {
                outfit: Some("pajamas".into()),
                schedule: None,
            }),
        )
        .unwrap();
        assert_eq!(pref.as_ref().unwrap().outfit.as_deref(), Some("pajamas"));
        assert!(validate_wardrobe_preference(
            &pet,
            Some(PetWardrobePreference {
                outfit: Some("auto".into()),
                schedule: None,
            }),
        )
        .unwrap()
        .is_none());
        assert!(validate_wardrobe_preference(
            &pet,
            Some(PetWardrobePreference {
                outfit: Some("nonexistent".into()),
                schedule: None,
            }),
        )
        .is_err());
        assert_eq!(
            validate_activity_preference(&pet, Some(vec!["stretch".into(), "stretch".into()])).unwrap(),
            Some(vec!["stretch".into()])
        );
        assert_eq!(
            validate_activity_preference(&pet, Some(vec![])).unwrap(),
            Some(vec![])
        );
        assert!(validate_activity_preference(&pet, Some(vec!["bogus".into()])).is_err());

        // Preserve existing custom/ and teaching.json across re-import
        let pet_dir = root.path().join("pets/hoodie-synth");
        std::fs::create_dir_all(pet_dir.join("custom")).unwrap();
        std::fs::write(pet_dir.join("custom/action-library.json"), b"{\"keep\":true}").unwrap();
        std::fs::write(pet_dir.join("teaching.json"), b"{\"keep\":true}").unwrap();
        let updated = library::import(root.path(), &zip_path).unwrap();
        assert!(updated.updated);
        assert_eq!(
            std::fs::read_to_string(pet_dir.join("custom/action-library.json")).unwrap(),
            "{\"keep\":true}"
        );
        assert_eq!(
            std::fs::read_to_string(pet_dir.join("teaching.json")).unwrap(),
            "{\"keep\":true}"
        );

        // Export -> re-import into fresh library round-trip
        let exported_zip = stage.path().join("exported.zip");
        library::export(root.path(), "hoodie-synth", &exported_zip).unwrap();
        let fresh_root = tempfile::tempdir().unwrap();
        let reimported = library::import(fresh_root.path(), &exported_zip).unwrap().pet;
        assert_eq!(reimported.wardrobe.as_ref().unwrap().outfits.len(), 5);
        assert_eq!(reimported.activities.as_ref().unwrap().len(), 2);
        assert!(library::pet_asset_path(fresh_root.path(), "hoodie-synth", "activities/stretch.pajamas.png").is_ok());
    }

    #[test]
    fn activity_validation_enforces_frame_fps_duration_and_dimension_bounds() {
        let outfits = vec!["pajamas".to_owned()];
        // Duration too short: 4 frames @ 12 fps = 333ms < 1000ms
        let short = PetActivity {
            id: "fast".into(),
            display_name: "Fast".into(),
            outfit_id: "default".into(),
            spritesheet_path: "activities/fast.webp".into(),
            frame_count: 4,
            fps: 12,
            outfit_variants: None,
        };
        assert!(validate_activities(&[short], &outfits).is_err());

        // Duration too long: 13 frames @ 1 fps = 13000ms > 12000ms
        let long = PetActivity {
            id: "slow".into(),
            display_name: "Slow".into(),
            outfit_id: "default".into(),
            spritesheet_path: "activities/slow.webp".into(),
            frame_count: 13,
            fps: 1,
            outfit_variants: None,
        };
        assert!(validate_activities(&[long], &outfits).is_err());

        // Unknown outfit in variant
        let bad_outfit = PetActivity {
            id: "stretch".into(),
            display_name: "Stretch".into(),
            outfit_id: "default".into(),
            spritesheet_path: "activities/stretch.webp".into(),
            frame_count: 8,
            fps: 4,
            outfit_variants: Some(vec![PetActivityAnimation {
                outfit_id: "missing".into(),
                spritesheet_path: "activities/stretch.missing.webp".into(),
                frame_count: 8,
                fps: 4,
            }]),
        };
        assert!(validate_activities(&[bad_outfit], &outfits).is_err());

        // Wrong strip dimensions: 4-frame PNG passed when expecting 6 frames
        let strip4 = make_strip_png(4);
        assert!(validate_activity_strip(&strip4, 4).is_ok());
        assert!(validate_activity_strip(&strip4, 6).is_err());
    }

    #[test]
    fn existing_suiby_lizi_and_mika_unchanged_without_new_optional_fields() {
        let root = tempfile::tempdir().unwrap();
        let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples");

        // Plain pet (mika) has zero optional wardrobe/activity/gazeAnchor fields.
        let mika = library::import(root.path(), &examples.join("mika")).unwrap().pet;
        assert!(mika.gaze_anchor.is_none());
        assert!(mika.wardrobe.is_none());
        assert!(mika.activities.is_none());
        let mika_json = serde_json::to_value(&mika).unwrap();
        assert!(mika_json.get("gazeAnchor").is_none());
        assert!(mika_json.get("wardrobe").is_none());
        assert!(mika_json.get("activities").is_none());

        // Built-in lizi ships with its moon-pajamas outfit + sleepStrip and no activities/schedule.
        let lizi = library::import(root.path(), &examples.join("lizi")).unwrap().pet;
        assert!(lizi.gaze_anchor.is_none());
        assert!(lizi.activities.is_none());
        let wardrobe = lizi.wardrobe.as_ref().expect("lizi ships with moon-pajamas");
        assert_eq!(wardrobe.outfits.len(), 1);
        assert_eq!(wardrobe.outfits[0].id, library::LIZI_PAJAMAS_ID);
        assert_eq!(
            wardrobe.outfits[0].sleep_strip.as_deref(),
            Some("outfits/moon-pajamas-sleep.png")
        );
        assert!(wardrobe.schedule.is_empty());
    }

    #[test]
    fn real_hoodie_cat_test_packs_import_when_present() {
        let packs_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../runs/test-packs");
        if !packs_dir.is_dir() {
            return;
        }
        let root = tempfile::tempdir().unwrap();
        for (file, expected_outfits, expected_activities) in [
            ("hoodie-cat-base-v2.zip", 0usize, 0usize),
            ("hoodie-cat-wardrobe.zip", 5, 0),
            ("hoodie-cat-full-demo.zip", 5, 2),
        ] {
            let path = packs_dir.join(file);
            if !path.is_file() {
                continue;
            }
            let imported = library::import(root.path(), &path)
                .unwrap_or_else(|e| panic!("Failed to import {file}: {e}"));
            let pet = imported.pet;
            assert_eq!(
                pet.wardrobe.as_ref().map_or(0, |w| w.outfits.len()),
                expected_outfits,
                "{file}"
            );
            assert_eq!(
                pet.activities.as_ref().map_or(0, Vec::len),
                expected_activities,
                "{file}"
            );
            if expected_outfits > 0 {
                let first_outfit = &pet.wardrobe.as_ref().unwrap().outfits[0].id;
                assert!(library::outfit_thumbnail(root.path(), &pet.id, first_outfit).unwrap().is_file());
                assert!(library::outfit_sheet_path(root.path(), &pet.id, first_outfit).unwrap().is_file());
            }
            if expected_activities > 0 {
                let first_act = &pet.activities.as_ref().unwrap()[0];
                assert!(library::pet_asset_path(root.path(), &pet.id, &first_act.spritesheet_path).unwrap().is_file());
            }
        }
    }
}

