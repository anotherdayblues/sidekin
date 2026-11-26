use crate::locale::t;
use serde::{Deserialize, Serialize};
#[cfg(test)]
#[path = "library_write_tests.rs"]
mod write_regression;
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path},
};
const MAX_IMAGE: u64 = 32 * 1024 * 1024;
const MAX_SLEEP: u64 = 4 * 1024 * 1024;
const MAX_ZIP: u64 = 100 * 1024 * 1024;
const MAX_MANIFEST: u64 = 128 * 1024;
const MAX_ZIP_UNCOMPRESSED: u64 = 160 * 1024 * 1024;
pub const LIZI_ID: &str = "lizi";
pub const LIZI_DEFAULT_NAME: &str = "栗子";
pub const LIZI_DEFAULT_DESC: &str = "一只温暖的原创橘白小猫，安静陪伴，也会好奇地四处走走。";
pub const LIZI_PAJAMAS_ID: &str = "moon-pajamas";
pub const LIZI_PAJAMAS_NAME: &str = "月牙睡衣";
pub const ACTIONS: [&str; 9] = [
    "idle",
    "running-right",
    "running-left",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "review",
];
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Pet {
    pub id: String,
    pub display_name: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "v1")]
    pub sprite_version_number: u8,
    pub spritesheet_path: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub sleep_strip: Option<String>,
    #[serde(default)]
    pub revision: String,
    #[serde(default)]
    pub behavior: Option<serde_json::Value>,
    #[serde(default)]
    pub fingerprint: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub gaze_anchor: Option<crate::wardrobe::GazeAnchor>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wardrobe: Option<crate::wardrobe::PetWardrobe>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub activities: Option<Vec<crate::wardrobe::PetActivity>>,
}
fn v1() -> u8 {
    1
}
pub fn localize_lizi_name(id: &str, name: &str, locale_id: &str) -> String {
    if id == LIZI_ID && name == LIZI_DEFAULT_NAME {
        crate::locale::t_in(locale_id, "pet.lizi.name")
    } else {
        name.to_owned()
    }
}
pub fn localize_lizi_desc(id: &str, desc: &str, locale_id: &str) -> String {
    if id == LIZI_ID && desc == LIZI_DEFAULT_DESC {
        crate::locale::t_in(locale_id, "pet.lizi.desc")
    } else {
        desc.to_owned()
    }
}
impl Pet {
    pub fn localized_in(mut self, locale_id: &str) -> Self {
        self.display_name = localize_lizi_name(&self.id, &self.display_name, locale_id);
        self.description = localize_lizi_desc(&self.id, &self.description, locale_id);
        if self.id == LIZI_ID {
            if let Some(wardrobe) = self.wardrobe.as_mut() {
                for outfit in &mut wardrobe.outfits {
                    if outfit.id == LIZI_PAJAMAS_ID && outfit.display_name == LIZI_PAJAMAS_NAME {
                        outfit.display_name =
                            crate::locale::t_in(locale_id, "pet.lizi.outfit.moonPajamas");
                    }
                }
            }
        }
        self
    }
    pub fn localized(self) -> Self {
        self.localized_in(crate::locale::current())
    }
}
#[derive(Serialize, Debug)]
pub struct ImportResult {
    pub pet: Pet,
    pub updated: bool,
}
#[derive(Serialize, Debug)]
#[serde(rename_all = "camelCase")]
pub struct OutfitInstallResult {
    pub pet_id: String,
    pub outfit_id: String,
    pub display_name: String,
    pub updated: bool,
}
fn valid_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'-' || c == b'_')
}
pub fn relative(path: &str) -> Result<(), String> {
    if path.is_empty()
        || path.contains('\\')
        || Path::new(path)
            .components()
            .any(|c| !matches!(c, Component::Normal(_)))
    {
        Err(t("host.pkgAssetPath").into())
    } else {
        Ok(())
    }
}
pub fn bounded(path: &Path, max: u64) -> Result<Vec<u8>, String> {
    let f = fs::File::open(path).map_err(|e| e.to_string())?;
    if f.metadata().map_err(|e| e.to_string())?.len() > max {
        return Err(t("host.pkgFileSize").into());
    }
    let mut b = Vec::new();
    f.take(max + 1)
        .read_to_end(&mut b)
        .map_err(|e| e.to_string())?;
    if b.len() as u64 > max {
        return Err(t("host.pkgFileSize").into());
    }
    Ok(b)
}
static JSON_WRITES: std::sync::Mutex<()> = std::sync::Mutex::new(());
pub fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    publish_json(path, value, false)
}
/// Version files are immutable: publish only if the destination is unused.
pub fn write_new_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    publish_json(path, value, true)
}
fn publish_json<T: Serialize>(path: &Path, value: &T, new: bool) -> Result<(), String> {
    let _write = JSON_WRITES.lock().map_err(|_| "文件写入锁不可用")?;
    let dir = path.parent().ok_or("文件位置无效")?;
    let mut tmp = tempfile::NamedTempFile::new_in(dir).map_err(|e| e.to_string())?;
    tmp.write_all(&serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    if new {
        tmp.persist_noclobber(path)
            .map_err(|_| t("host.pkgVersionFile").to_owned())?;
    } else {
        tmp.persist(path).map_err(|e| e.to_string())?;
    }
    Ok(())
}
fn check_declared_paths(p: &Pet) -> Result<(), String> {
    relative(&p.spritesheet_path)?;
    if let Some(path) = &p.sleep_strip {
        relative(path)?;
    }
    if let Some(wardrobe) = &p.wardrobe {
        for outfit in &wardrobe.outfits {
            relative(&outfit.spritesheet_path)?;
            if let Some(sleep) = &outfit.sleep_strip {
                relative(sleep)?;
            }
        }
    }
    if let Some(activities) = &p.activities {
        for activity in activities {
            for (path, _) in crate::wardrobe::activity_strip_specs(activity) {
                relative(path)?;
            }
        }
    }
    Ok(())
}
fn read_pet(root: &Path, id: &str) -> Result<Pet, String> {
    if !valid_id(id) {
        return Err(t("host.petIdBad").into());
    }
    let p: Pet = serde_json::from_slice(&bounded(
        &root.join("pets").join(id).join("pet.json"),
        MAX_MANIFEST,
    )?)
    .map_err(|e| e.to_string())?;
    check_declared_paths(&p)?;
    Ok(p)
}
pub fn pet(root: &Path, id: &str) -> Result<Pet, String> {
    read_pet(root, id).map(Pet::localized)
}
/// Permanently delete a pet: its package, taught actions and history.
pub fn remove(root: &Path, id: &str) -> Result<Pet, String> {
    let p = read_pet(root, id)?;
    fs::remove_dir_all(root.join("pets").join(id)).map_err(|e| e.to_string())?;
    Ok(p.localized())
}
pub fn list(root: &Path) -> Result<Vec<Pet>, String> {
    let mut result = Vec::new();
    for e in fs::read_dir(root.join("pets")).map_err(|e| e.to_string())? {
        let e = e.map_err(|e| e.to_string())?;
        if let Some(id) = e.file_name().to_str() {
            if let Ok(p) = pet(root, id) {
                result.push(p);
            }
        }
    }
    result.sort_by(|a, b| a.display_name.cmp(&b.display_name));
    Ok(result)
}
fn parse(bytes: &[u8]) -> Result<Pet, String> {
    let mut v: serde_json::Value = serde_json::from_slice(bytes).map_err(|_| t("host.pkgJson"))?;
    if v.get("spritesheetPath").is_none() {
        v["spritesheetPath"] = "spritesheet.webp".into();
    }
    if v.get("id").is_none() {
        v["id"] = "imported-pet".into();
    }
    if v.get("displayName").is_none() {
        v["displayName"] = t("host.newPetName").into();
    }
    let p: Pet =
        serde_json::from_value(v).map_err(|e| crate::locale::tf("host.pkgFormat", &[("e", &e)]))?;
    if !valid_id(&p.id) || p.display_name.trim().is_empty() {
        return Err(t("host.pkgIdName").into());
    }
    // A long name from a maker is cut, not refused; the user can rename it.
    let mut p = p;
    p.display_name = p.display_name.trim().chars().take(NAME_MAX).collect();
    relative(&p.spritesheet_path)?;
    if let Some(path) = &p.sleep_strip {
        relative(path)?;
    }
    if ![1, 2].contains(&p.sprite_version_number) {
        return Err(t("host.pkgVersion").into());
    }
    if p.behavior.as_ref().is_some_and(|v| !v.is_object()) {
        return Err(t("host.pkgBehavior").into());
    }
    if let Some(anchor) = &p.gaze_anchor {
        p.gaze_anchor = Some(crate::wardrobe::validate_gaze_anchor(anchor)?);
    }
    if let Some(wardrobe) = &p.wardrobe {
        p.wardrobe = Some(crate::wardrobe::validate_wardrobe(wardrobe)?);
    }
    if let Some(activities) = &p.activities {
        let outfit_ids: Vec<String> = p
            .wardrobe
            .as_ref()
            .map(|w| w.outfits.iter().map(|o| o.id.clone()).collect())
            .unwrap_or_default();
        let validated = crate::wardrobe::validate_activities(activities, &outfit_ids)?;
        p.activities = if validated.is_empty() {
            None
        } else {
            Some(validated)
        };
    }
    check_declared_paths(&p)?;
    Ok(p)
}
struct Package {
    pet: Pet,
    sheet: Vec<u8>,
    sleep: Option<Vec<u8>>,
    outfits: Vec<(String, Vec<u8>)>,
    outfit_sleeps: Vec<(String, Vec<u8>)>,
    activities: Vec<(String, u32, Vec<u8>)>,
}
fn read_zip_member(
    archive: &mut zip::ZipArchive<std::io::Cursor<Vec<u8>>>,
    base: &Path,
    rel: &str,
    max_entry: u64,
    total_read: &mut u64,
    missing_err: impl FnOnce() -> String,
    size_err: impl FnOnce() -> String,
) -> Result<Vec<u8>, String> {
    let member = base.join(rel).to_string_lossy().replace('\\', "/");
    let entry = archive.by_name(&member).map_err(|_| missing_err())?;
    if entry.size() > max_entry {
        return Err(size_err());
    }
    let mut buf = Vec::new();
    entry
        .take(max_entry + 1)
        .read_to_end(&mut buf)
        .map_err(|e| e.to_string())?;
    if buf.len() as u64 > max_entry {
        return Err(size_err());
    }
    *total_read = total_read.saturating_add(buf.len() as u64);
    if *total_read > MAX_ZIP_UNCOMPRESSED {
        return Err(t("host.pkgFileSize").into());
    }
    Ok(buf)
}
fn resolve_folder_manifest(path: &Path) -> Result<std::path::PathBuf, String> {
    if !path.is_dir() {
        return Ok(path.to_path_buf());
    }
    let direct = path.join("pet.json");
    if direct.is_file() {
        return Ok(direct);
    }
    // Support a single top-level wrapper folder (ignoring dotfiles and __MACOSX).
    let mut subdirs = Vec::new();
    for entry in fs::read_dir(path).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || name == "__MACOSX" {
            continue;
        }
        let child = entry.path();
        if child.is_dir() {
            subdirs.push(child);
        }
    }
    if subdirs.len() == 1 && subdirs[0].join("pet.json").is_file() {
        return Ok(subdirs[0].join("pet.json"));
    }
    Ok(direct)
}
fn read_folder_member(root: &Path, rel: &str, max: u64, outside_err: &str) -> Result<Vec<u8>, String> {
    let resolved = root.join(rel).canonicalize().map_err(|e| e.to_string())?;
    if !resolved.starts_with(root) {
        return Err(outside_err.to_owned());
    }
    bounded(&resolved, max)
}
fn read_package(path: &Path) -> Result<Package, String> {
    if path
        .extension()
        .is_some_and(|s| s.eq_ignore_ascii_case("zip"))
    {
        let bytes = bounded(path, MAX_ZIP)?;
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
        let manifests: Vec<String> = archive
            .file_names()
            .filter(|s| {
                !s.starts_with("__MACOSX/")
                    && (*s == "pet.json" || (s.matches('/').count() == 1 && s.ends_with("/pet.json")))
            })
            .map(str::to_string)
            .collect();
        if manifests.len() != 1 {
            return Err(t("host.pkgOneJson").into());
        }
        let name = &manifests[0];
        relative(name)?;
        let mut total_read: u64 = 0;
        let raw = read_zip_member(
            &mut archive,
            Path::new(""),
            name,
            MAX_MANIFEST,
            &mut total_read,
            || t("host.pkgOneJson").into(),
            || t("host.pkgJsonBig").into(),
        )?;
        let pet = parse(&raw)?;
        let base = Path::new(name).parent().unwrap_or(Path::new(""));
        let sheet = read_zip_member(
            &mut archive,
            base,
            &pet.spritesheet_path,
            MAX_IMAGE,
            &mut total_read,
            || t("host.pkgNoSheet").into(),
            || t("host.pkgSheetBig").into(),
        )?;
        let sleep = if let Some(file) = &pet.sleep_strip {
            Some(read_zip_member(
                &mut archive,
                base,
                file,
                4 * 1024 * 1024,
                &mut total_read,
                || t("host.pkgNoSleep").into(),
                || t("host.pkgSleepBig").into(),
            )?)
        } else {
            None
        };
        let mut outfits = Vec::new();
        let mut outfit_sleeps = Vec::new();
        if let Some(wardrobe) = &pet.wardrobe {
            for outfit in &wardrobe.outfits {
                let data = read_zip_member(
                    &mut archive,
                    base,
                    &outfit.spritesheet_path,
                    MAX_IMAGE,
                    &mut total_read,
                    || format!("Missing outfit spritesheet: {}", outfit.spritesheet_path),
                    || t("host.pkgSheetBig").into(),
                )?;
                outfits.push((outfit.spritesheet_path.clone(), data));
                if let Some(sleep_rel) = &outfit.sleep_strip {
                    let sleep_data = read_zip_member(
                        &mut archive,
                        base,
                        sleep_rel,
                        MAX_SLEEP,
                        &mut total_read,
                        || format!("Missing outfit sleepStrip: {sleep_rel}"),
                        || t("host.pkgSleepBig").into(),
                    )?;
                    outfit_sleeps.push((sleep_rel.clone(), sleep_data));
                }
            }
        }
        let mut activities = Vec::new();
        let mut activity_bytes: u64 = 0;
        if let Some(list) = &pet.activities {
            for activity in list {
                for (rel, frame_count) in crate::wardrobe::activity_strip_specs(activity) {
                    let data = read_zip_member(
                        &mut archive,
                        base,
                        rel,
                        crate::wardrobe::MAX_ACTIVITY_BYTES,
                        &mut total_read,
                        || format!("Missing activity spritesheet: {rel}"),
                        || format!("Activity spritesheet exceeds size limit: {rel}"),
                    )?;
                    activity_bytes = activity_bytes.saturating_add(data.len() as u64);
                    if activity_bytes > crate::wardrobe::MAX_ACTIVITY_TOTAL_BYTES {
                        return Err("Pet activities exceed total size limit".into());
                    }
                    activities.push((rel.to_owned(), frame_count, data));
                }
            }
        }
        Ok(Package {
            pet,
            sheet,
            sleep,
            outfits,
            outfit_sleeps,
            activities,
        })
    } else {
        let manifest = resolve_folder_manifest(path)?;
        let root = manifest
            .parent()
            .ok_or(t("host.pkgWhere"))?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let pet = parse(&bounded(&manifest, MAX_MANIFEST)?)?;
        let sheet = read_folder_member(&root, &pet.spritesheet_path, MAX_IMAGE, &t("host.pkgOutside"))?;
        let sleep = if let Some(file) = &pet.sleep_strip {
            Some(read_folder_member(
                &root,
                file,
                MAX_SLEEP,
                &t("host.pkgSleepOutside"),
            )?)
        } else {
            None
        };
        let mut outfits = Vec::new();
        let mut outfit_sleeps = Vec::new();
        if let Some(wardrobe) = &pet.wardrobe {
            for outfit in &wardrobe.outfits {
                let data = read_folder_member(
                    &root,
                    &outfit.spritesheet_path,
                    MAX_IMAGE,
                    &t("host.pkgOutside"),
                )?;
                outfits.push((outfit.spritesheet_path.clone(), data));
                if let Some(sleep_rel) = &outfit.sleep_strip {
                    let sleep_data = read_folder_member(
                        &root,
                        sleep_rel,
                        MAX_SLEEP,
                        &t("host.pkgSleepOutside"),
                    )?;
                    outfit_sleeps.push((sleep_rel.clone(), sleep_data));
                }
            }
        }
        let mut activities = Vec::new();
        let mut activity_bytes: u64 = 0;
        if let Some(list) = &pet.activities {
            for activity in list {
                for (rel, frame_count) in crate::wardrobe::activity_strip_specs(activity) {
                    let data = read_folder_member(
                        &root,
                        rel,
                        crate::wardrobe::MAX_ACTIVITY_BYTES,
                        &t("host.pkgOutside"),
                    )?;
                    activity_bytes = activity_bytes.saturating_add(data.len() as u64);
                    if activity_bytes > crate::wardrobe::MAX_ACTIVITY_TOTAL_BYTES {
                        return Err("Pet activities exceed total size limit".into());
                    }
                    activities.push((rel.to_owned(), frame_count, data));
                }
            }
        }
        Ok(Package {
            pet,
            sheet,
            sleep,
            outfits,
            outfit_sleeps,
            activities,
        })
    }
}
fn validate(bytes: &[u8], version: u8) -> Result<(&'static str, image::RgbaImage), String> {
    if bytes.is_empty() || bytes.len() as u64 > MAX_IMAGE {
        return Err(t("host.pkgSheetSize").into());
    }
    let format = image::guess_format(bytes).map_err(|_| t("host.pkgSheetType"))?;
    let ext = match format {
        image::ImageFormat::Png => "png",
        image::ImageFormat::WebP => "webp",
        _ => return Err(t("host.pkgSheetType").into()),
    };
    let reader = image::ImageReader::with_format(std::io::Cursor::new(bytes), format);
    let (w, h) = reader.into_dimensions().map_err(|e| e.to_string())?;
    let expected = if version == 2 { 2288 } else { 1872 };
    if (w, h) != (1536, expected) {
        return Err(format!(
            "v{version} 图集应为 1536 × {expected}，实际为 {w} × {h}"
        ));
    }
    let img = image::load_from_memory_with_format(bytes, format)
        .map_err(|e| e.to_string())?
        .into_rgba8();
    // Active frames per row stay strictly validated. V2 neutral pose cell
    // (row 0, col 6) and other unused cells are permitted gracefully so real
    // OpenPets community packs with neutral poses or faint alpha bleed import cleanly.
    let frames = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
    for row in 0..h / 208 {
        for col in 0..frames[row as usize] {
            let mut occupied = false;
            'cell: for y in row * 208..(row + 1) * 208 {
                for x in col * 192..(col + 1) * 192 {
                    if img.get_pixel(x, y)[3] > 0 {
                        occupied = true;
                        break 'cell;
                    }
                }
            }
            if !occupied {
                return Err(crate::locale::tf(
                    "host.pkgEmptyFrame",
                    &[("row", &(row + 1)), ("col", &(col + 1))],
                ));
            }
        }
    }
    Ok((ext, image::imageops::crop_imm(&img, 0, 0, 192, 208).to_image()))
}

fn thumbnail_path(dir: &Path, pet: &Pet) -> std::path::PathBuf {
    // Imported sheet names are content-addressed. Hash the stored path so
    // older manifests with a relative subdirectory also get a safe cache key.
    let key = Sha256::digest(pet.spritesheet_path.as_bytes());
    dir.join(format!("thumbnail-{key:x}.png"))
}

fn outfit_thumbnail_path(dir: &Path, rel_path: &str) -> std::path::PathBuf {
    let key = Sha256::digest(rel_path.as_bytes());
    dir.join(format!("thumbnail-outfit-{key:x}.png"))
}

fn cache_thumbnail(path: &Path, cell: &image::RgbaImage) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }
    let mut temp =
        tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    cell.write_to(temp.as_file_mut(), image::ImageFormat::Png)
        .map_err(|e| e.to_string())?;
    temp.persist(path).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn thumbnail(root: &Path, id: &str) -> Result<std::path::PathBuf, String> {
    let pet = read_pet(root, id)?;
    let dir = root.join("pets").join(id);
    let path = thumbnail_path(&dir, &pet);
    if !path.is_file() {
        let bytes = bounded(&dir.join(&pet.spritesheet_path), MAX_IMAGE)?;
        let (_, cell) = validate(&bytes, pet.sprite_version_number)?;
        cache_thumbnail(&path, &cell)?;
    }
    Ok(path)
}

pub fn pet_asset_path(root: &Path, id: &str, rel: &str) -> Result<std::path::PathBuf, String> {
    let pet = read_pet(root, id)?;
    relative(rel)?;
    let mut allowed = rel == pet.spritesheet_path
        || pet.sleep_strip.as_deref() == Some(rel);
    if !allowed {
        if let Some(wardrobe) = &pet.wardrobe {
            allowed = wardrobe.outfits.iter().any(|o| {
                o.spritesheet_path == rel || o.sleep_strip.as_deref() == Some(rel)
            });
        }
    }
    if !allowed {
        if let Some(activities) = &pet.activities {
            allowed = activities.iter().any(|a| {
                crate::wardrobe::activity_strip_specs(a)
                    .iter()
                    .any(|(path, _)| *path == rel)
            });
        }
    }
    if !allowed {
        return Err(t("host.pkgAssetPath").into());
    }
    let dir = root
        .join("pets")
        .join(&pet.id)
        .canonicalize()
        .map_err(|e| e.to_string())?;
    let target = dir.join(rel).canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&dir) || !target.is_file() {
        return Err(t("host.pkgOutside").into());
    }
    Ok(target)
}

pub fn outfit_sheet_path(root: &Path, id: &str, outfit_id: &str) -> Result<std::path::PathBuf, String> {
    let pet = read_pet(root, id)?;
    if outfit_id == crate::wardrobe::DEFAULT_OUTFIT_ID || outfit_id.is_empty() {
        return pet_asset_path(root, id, &pet.spritesheet_path);
    }
    let rel = pet
        .wardrobe
        .as_ref()
        .and_then(|w| w.outfits.iter().find(|o| o.id == outfit_id))
        .map(|o| o.spritesheet_path.as_str())
        .ok_or_else(|| format!("Unknown wardrobe outfit: {outfit_id}"))?;
    pet_asset_path(root, id, rel)
}

/// Resolves the sleep strip for `id` (optionally wearing `outfit_id`): returns
/// the outfit's own `sleepStrip` when declared and present on disk, otherwise
/// falls back seamlessly to the pet's base `sleepStrip`.
pub fn outfit_sleep_path(
    root: &Path,
    id: &str,
    outfit_id: Option<&str>,
) -> Result<std::path::PathBuf, String> {
    let pet = read_pet(root, id)?;
    if let Some(oid) = outfit_id.filter(|s| !s.is_empty() && *s != crate::wardrobe::DEFAULT_OUTFIT_ID)
    {
        if let Some(sleep_rel) = pet
            .wardrobe
            .as_ref()
            .and_then(|w| w.outfits.iter().find(|o| o.id == oid))
            .and_then(|o| o.sleep_strip.as_deref())
        {
            if let Ok(path) = pet_asset_path(root, id, sleep_rel) {
                return Ok(path);
            }
        }
    }
    let base = pet.sleep_strip.as_deref().ok_or(t("host.noSleep"))?;
    pet_asset_path(root, id, base)
}

pub fn outfit_thumbnail(root: &Path, id: &str, outfit_id: &str) -> Result<std::path::PathBuf, String> {
    if outfit_id == crate::wardrobe::DEFAULT_OUTFIT_ID || outfit_id.is_empty() {
        return thumbnail(root, id);
    }
    let pet = read_pet(root, id)?;
    let outfit = pet
        .wardrobe
        .as_ref()
        .and_then(|w| w.outfits.iter().find(|o| o.id == outfit_id))
        .ok_or_else(|| format!("Unknown wardrobe outfit: {outfit_id}"))?;
    let dir = root.join("pets").join(&pet.id);
    let path = outfit_thumbnail_path(&dir, &outfit.spritesheet_path);
    if !path.is_file() {
        let sheet = pet_asset_path(root, id, &outfit.spritesheet_path)?;
        let bytes = bounded(&sheet, MAX_IMAGE)?;
        let (_, cell) = validate(&bytes, pet.sprite_version_number)?;
        cache_thumbnail(&path, &cell)?;
    }
    Ok(path)
}

pub fn import(root: &Path, path: &Path) -> Result<ImportResult, String> {
    let pkg = read_package(path)?;
    store_package(root, pkg)
}

fn bump_outfit_revision(pet: &mut Pet, payload: &[u8]) {
    let tag = format!("{:x}", Sha256::digest(payload));
    let base = pet
        .revision
        .split_once("+outfit-")
        .map_or(pet.revision.as_str(), |(prefix, _)| prefix);
    pet.revision = if base.is_empty() {
        format!("outfit-{}", &tag[..8])
    } else {
        format!("{base}+outfit-{}", &tag[..8])
    };
}

fn write_file_atomic(path: &Path, bytes: &[u8]) -> Result<(), String> {
    let parent = path.parent().ok_or("文件位置无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    tmp.write_all(bytes)
        .and_then(|_| tmp.as_file().sync_all())
        .map_err(|e| e.to_string())?;
    tmp.persist(path).map_err(|e| e.error.to_string())?;
    Ok(())
}

fn read_delivery_file(dir: &Path, rel: &str, max: u64) -> Result<Vec<u8>, String> {
    relative(rel)?;
    // Reject symlinks anywhere along the relative path inside the delivery folder.
    let mut cur = dir.to_path_buf();
    for comp in Path::new(rel).components() {
        cur.push(comp);
        let meta = fs::symlink_metadata(&cur).map_err(|e| e.to_string())?;
        if meta.file_type().is_symlink() {
            return Err(t("host.pkgOutside").into());
        }
    }
    let root = dir.canonicalize().map_err(|e| e.to_string())?;
    let target = cur.canonicalize().map_err(|e| e.to_string())?;
    if !target.starts_with(&root) || !target.is_file() {
        return Err(t("host.pkgOutside").into());
    }
    bounded(&target, max)
}

/// Incrementally installs or updates a single outfit (plus optional creator
/// schedule rule, per-outfit `sleepStrip`, and outfit-specific activities) onto
/// an existing installed pet, or applies a sleep-only patch to an already-installed
/// outfit when `spritesheetPath` is omitted/absent and `sleepStrip` is provided.
/// Never touches the pet's base spritesheet, base `sleepStrip`, `behavior`,
/// `custom/`, `teaching.json`, or other outfits.
pub fn install_outfit(root: &Path, delivery_dir: &Path) -> Result<OutfitInstallResult, String> {
    let manifest_bytes = read_delivery_file(delivery_dir, "outfit.json", MAX_MANIFEST)?;
    let manifest: crate::wardrobe::OutfitPackageManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|e| format!("outfit.json invalid: {e}"))?;

    let mut pet = read_pet(root, &manifest.pet_id)?;
    let prev = pet.clone();
    crate::wardrobe::validate_outfit_id(&manifest.outfit.id)?;
    let validated_sleep_rel =
        crate::wardrobe::validate_outfit_sleep_strip(&manifest.outfit.id, &manifest.outfit.sleep_strip)?;

    let existing_outfit = pet
        .wardrobe
        .as_ref()
        .and_then(|w| w.outfits.iter().find(|o| o.id == manifest.outfit.id))
        .cloned();

    let raw_sheet_path = manifest
        .outfit
        .spritesheet_path
        .as_deref()
        .map(str::trim)
        .filter(|s| !s.is_empty());

    // Reject path traversal even if spritesheetPath is provided during a sleep-only patch.
    if let Some(sheet_rel) = raw_sheet_path {
        let expected_webp = format!("outfits/{}.webp", manifest.outfit.id);
        let expected_png = format!("outfits/{}.png", manifest.outfit.id);
        if sheet_rel != expected_webp && sheet_rel != expected_png {
            return Err(format!(
                "Pet wardrobe outfit spritesheetPath must be {expected_webp} or {expected_png}"
            ));
        }
    }

    let sheet_present_in_dir = raw_sheet_path.is_some_and(|p| delivery_dir.join(p).exists());
    let is_sleep_only_patch =
        validated_sleep_rel.is_some() && existing_outfit.is_some() && !sheet_present_in_dir;

    if is_sleep_only_patch {
        let existing = existing_outfit.unwrap();
        let sleep_rel = validated_sleep_rel.unwrap();
        let sleep_bytes = read_delivery_file(delivery_dir, &sleep_rel, MAX_SLEEP)?;
        crate::teaching::validate_strip(&sleep_bytes, 16)?;

        let dir = root.join("pets").join(&pet.id);
        write_file_atomic(&dir.join(&sleep_rel), &sleep_bytes)?;

        if let Some(wardrobe) = pet.wardrobe.as_mut() {
            if let Some(slot) = wardrobe.outfits.iter_mut().find(|o| o.id == existing.id) {
                slot.sleep_strip = Some(sleep_rel);
            }
        }
        bump_outfit_revision(&mut pet, &sleep_bytes);
        let _ = write_json(&dir.join("pet.prev.json"), &prev);
        write_json(&dir.join("pet.json"), &pet)?;

        return Ok(OutfitInstallResult {
            pet_id: pet.id,
            outfit_id: existing.id,
            display_name: existing.display_name,
            updated: true,
        });
    }

    let display_name = manifest
        .outfit
        .display_name
        .as_deref()
        .unwrap_or("")
        .to_owned();
    let spritesheet_path = raw_sheet_path
        .ok_or_else(|| format!("Missing spritesheetPath for outfit '{}'", manifest.outfit.id))?
        .to_owned();
    let mut outfit = crate::wardrobe::validate_single_outfit(&crate::wardrobe::PetOutfit {
        id: manifest.outfit.id.clone(),
        display_name,
        spritesheet_path,
        sleep_strip: validated_sleep_rel,
    })?;

    // Validate optional scheduleRule (must reference this exact outfit).
    let schedule_rule = match &manifest.schedule_rule {
        Some(rule) => {
            if rule.outfit != outfit.id {
                return Err(format!(
                    "outfit.json scheduleRule.outfit '{}' must match outfit.id '{}'",
                    rule.outfit, outfit.id
                ));
            }
            let mut ids = std::collections::HashSet::new();
            ids.insert(outfit.id.as_str());
            Some(crate::wardrobe::validate_schedule_rule(rule, &ids)?)
        }
        None => None,
    };

    // Read and strictly validate the outfit atlas against the target pet's V1/V2 layout.
    let sheet_bytes = read_delivery_file(delivery_dir, &outfit.spritesheet_path, MAX_IMAGE)?;
    let (_, outfit_cell) = validate(&sheet_bytes, pet.sprite_version_number)?;

    // Read and strictly validate optional per-outfit sleepStrip (16 frames, 3072x208).
    let validated_outfit_sleep = if let Some(sleep_rel) = &outfit.sleep_strip {
        let sleep_bytes = read_delivery_file(delivery_dir, sleep_rel, MAX_SLEEP)?;
        crate::teaching::validate_strip(&sleep_bytes, 16)?;
        Some((sleep_rel.clone(), sleep_bytes))
    } else {
        None
    };

    // Validate and read any outfit-specific activities before modifying disk state.
    let mut validated_activities: Vec<(crate::wardrobe::PetActivity, bool, Vec<u8>)> = Vec::new();
    let mut seen_act_ids = std::collections::HashSet::new();
    let mut activity_bytes: u64 = 0;
    for raw_act in &manifest.activities {
        if !seen_act_ids.insert(raw_act.id.as_str()) {
            return Err(format!("Duplicate activity id in outfit.json: {}", raw_act.id));
        }
        let attaches_as_variant = pet
            .activities
            .as_ref()
            .and_then(|list| list.iter().find(|a| a.id == raw_act.id))
            .is_some_and(|existing| existing.outfit_id != outfit.id);
        let validated =
            crate::wardrobe::validate_outfit_activity_entry(raw_act, &outfit.id, attaches_as_variant)?;
        let strip_bytes = read_delivery_file(
            delivery_dir,
            &validated.spritesheet_path,
            crate::wardrobe::MAX_ACTIVITY_BYTES,
        )?;
        activity_bytes = activity_bytes.saturating_add(strip_bytes.len() as u64);
        if activity_bytes > crate::wardrobe::MAX_ACTIVITY_TOTAL_BYTES {
            return Err("Pet activities exceed total size limit".into());
        }
        crate::wardrobe::validate_activity_strip(&strip_bytes, validated.frame_count)?;
        validated_activities.push((validated, attaches_as_variant, strip_bytes));
    }

    // Preserve an existing outfit's sleepStrip across atlas-only updates when not replaced.
    let dir = root.join("pets").join(&pet.id);
    if outfit.sleep_strip.is_none() {
        if let Some(prev_sleep) = existing_outfit
            .as_ref()
            .and_then(|old| old.sleep_strip.as_ref())
        {
            if relative(prev_sleep).is_ok() && dir.join(prev_sleep).is_file() {
                outfit.sleep_strip = Some(prev_sleep.clone());
            }
        }
    }

    // Apply in-memory manifest upsert and enforce caps before writing any files.
    let wardrobe = pet
        .wardrobe
        .get_or_insert_with(|| crate::wardrobe::PetWardrobe {
            outfits: Vec::new(),
            schedule: Vec::new(),
        });
    let mut previous_outfit_path: Option<String> = None;
    let updated = if let Some(existing) = wardrobe.outfits.iter_mut().find(|o| o.id == outfit.id) {
        previous_outfit_path = Some(existing.spritesheet_path.clone());
        *existing = outfit.clone();
        true
    } else {
        if wardrobe.outfits.len() >= crate::wardrobe::MAX_PET_OUTFITS {
            return Err(format!(
                "Pet wardrobe cannot exceed {} outfits",
                crate::wardrobe::MAX_PET_OUTFITS
            ));
        }
        wardrobe.outfits.push(outfit.clone());
        false
    };

    if let Some(rule) = schedule_rule {
        if updated {
            if let Some(existing_rule) = wardrobe.schedule.iter_mut().find(|r| r.outfit == outfit.id)
            {
                *existing_rule = rule;
            } else {
                if wardrobe.schedule.len() >= crate::wardrobe::MAX_OUTFIT_SCHEDULE_RULES {
                    return Err(format!(
                        "Pet wardrobe schedule cannot exceed {} rules",
                        crate::wardrobe::MAX_OUTFIT_SCHEDULE_RULES
                    ));
                }
                wardrobe.schedule.push(rule);
            }
        } else {
            if wardrobe.schedule.len() >= crate::wardrobe::MAX_OUTFIT_SCHEDULE_RULES {
                return Err(format!(
                    "Pet wardrobe schedule cannot exceed {} rules",
                    crate::wardrobe::MAX_OUTFIT_SCHEDULE_RULES
                ));
            }
            wardrobe.schedule.push(rule);
        }
    }

    if !validated_activities.is_empty() {
        let list = pet.activities.get_or_insert_with(Vec::new);
        for (act, as_variant, _) in &validated_activities {
            if *as_variant {
                let existing = list
                    .iter_mut()
                    .find(|a| a.id == act.id)
                    .ok_or_else(|| format!("Missing parent activity: {}", act.id))?;
                let variant = crate::wardrobe::PetActivityAnimation {
                    outfit_id: act.outfit_id.clone(),
                    spritesheet_path: act.spritesheet_path.clone(),
                    frame_count: act.frame_count,
                    fps: act.fps,
                };
                let variants = existing.outfit_variants.get_or_insert_with(Vec::new);
                if let Some(slot) = variants.iter_mut().find(|v| v.outfit_id == variant.outfit_id) {
                    *slot = variant;
                } else {
                    if variants.len() >= crate::wardrobe::MAX_PET_OUTFITS {
                        return Err(format!(
                            "Pet activity outfitVariants cannot exceed {} entries",
                            crate::wardrobe::MAX_PET_OUTFITS
                        ));
                    }
                    variants.push(variant);
                }
            } else if let Some(existing) = list.iter_mut().find(|a| a.id == act.id) {
                existing.display_name = act.display_name.clone();
                existing.spritesheet_path = act.spritesheet_path.clone();
                existing.frame_count = act.frame_count;
                existing.fps = act.fps;
            } else {
                if list.len() >= crate::wardrobe::MAX_PET_ACTIVITIES {
                    return Err(format!(
                        "Pet activities cannot exceed {} entries",
                        crate::wardrobe::MAX_PET_ACTIVITIES
                    ));
                }
                list.push(act.clone());
            }
        }
    }

    // All validation passed; atomically write outfit file, optional sleepStrip, activity strips, thumbnail, and pet.json.
    write_file_atomic(&dir.join(&outfit.spritesheet_path), &sheet_bytes)?;
    if let Some((sleep_rel, sleep_bytes)) = &validated_outfit_sleep {
        write_file_atomic(&dir.join(sleep_rel), sleep_bytes)?;
    }
    // Refresh only this outfit's cached thumbnail.
    if let Some(old_rel) = previous_outfit_path {
        let _ = fs::remove_file(outfit_thumbnail_path(&dir, &old_rel));
    }
    let thumb_path = outfit_thumbnail_path(&dir, &outfit.spritesheet_path);
    let _ = fs::remove_file(&thumb_path);
    let _ = cache_thumbnail(&thumb_path, &outfit_cell);

    for (act, _, strip_bytes) in &validated_activities {
        write_file_atomic(&dir.join(&act.spritesheet_path), strip_bytes)?;
    }

    let mut rev_hash = Sha256::new();
    rev_hash.update(&sheet_bytes);
    if let Some((_, ref sleep_bytes)) = validated_outfit_sleep {
        rev_hash.update(sleep_bytes);
    }
    for (_, _, strip_bytes) in &validated_activities {
        rev_hash.update(strip_bytes);
    }
    bump_outfit_revision(&mut pet, &rev_hash.finalize());

    let _ = write_json(&dir.join("pet.prev.json"), &prev);
    write_json(&dir.join("pet.json"), &pet)?;

    Ok(OutfitInstallResult {
        pet_id: pet.id,
        outfit_id: outfit.id,
        display_name: outfit.display_name,
        updated,
    })
}
/// Removes a single installed outfit (its atlas, optional per-outfit `sleepStrip`,
/// cached thumbnail, outfit-only activities/variants, and schedule references)
/// without touching the pet's base atlas, base `sleepStrip`, `behavior`, `custom/`,
/// or other outfits. Returns the deleted outfit's display name.
pub fn delete_outfit(root: &Path, pet_id: &str, outfit_id: &str) -> Result<String, String> {
    crate::wardrobe::validate_outfit_id(outfit_id)?;
    let mut pet = read_pet(root, pet_id)?;
    let prev = pet.clone();
    let dir = root.join("pets").join(&pet.id);

    let removed = {
        let wardrobe = pet
            .wardrobe
            .as_mut()
            .ok_or_else(|| format!("Unknown outfit: {outfit_id}"))?;
        let pos = wardrobe
            .outfits
            .iter()
            .position(|o| o.id == outfit_id)
            .ok_or_else(|| format!("Unknown outfit: {outfit_id}"))?;
        let removed = wardrobe.outfits.remove(pos);
        wardrobe.schedule.retain(|rule| rule.outfit != outfit_id);
        removed
    };

    if pet
        .wardrobe
        .as_ref()
        .is_some_and(|w| w.outfits.is_empty())
    {
        pet.wardrobe = None;
    }

    let mut orphaned_strips: Vec<String> = Vec::new();
    if let Some(activities) = pet.activities.as_mut() {
        activities.retain_mut(|act| {
            if act.outfit_id == outfit_id {
                orphaned_strips.push(act.spritesheet_path.clone());
                if let Some(variants) = &act.outfit_variants {
                    for v in variants {
                        orphaned_strips.push(v.spritesheet_path.clone());
                    }
                }
                return false;
            }
            if let Some(variants) = act.outfit_variants.as_mut() {
                variants.retain(|v| {
                    if v.outfit_id == outfit_id {
                        orphaned_strips.push(v.spritesheet_path.clone());
                        false
                    } else {
                        true
                    }
                });
                if variants.is_empty() {
                    act.outfit_variants = None;
                }
            }
            true
        });
        if activities.is_empty() {
            pet.activities = None;
        }
    }

    bump_outfit_revision(&mut pet, format!("delete:{outfit_id}").as_bytes());
    let _ = write_json(&dir.join("pet.prev.json"), &prev);
    write_json(&dir.join("pet.json"), &pet)?;

    if relative(&removed.spritesheet_path).is_ok() {
        let _ = fs::remove_file(dir.join(&removed.spritesheet_path));
        let _ = fs::remove_file(outfit_thumbnail_path(&dir, &removed.spritesheet_path));
    }
    if let Some(sleep_rel) = &removed.sleep_strip {
        if relative(sleep_rel).is_ok() {
            let _ = fs::remove_file(dir.join(sleep_rel));
        }
    }
    for strip_rel in orphaned_strips {
        if relative(&strip_rel).is_ok() {
            let _ = fs::remove_file(dir.join(&strip_rel));
        }
    }
    let _ = fs::remove_dir(dir.join("outfits"));

    Ok(removed.display_name)
}
/// Exports an installed pet as a clean portable `.zip` package that `import`
/// can load directly on any machine.
pub fn export(root: &Path, id: &str, dest: &Path) -> Result<(), String> {
    let mut p = read_pet(root, id)?;
    let dir = root.join("pets").join(&p.id);
    let sheet_bytes = bounded(&dir.join(&p.spritesheet_path), MAX_IMAGE)?;
    let sheet_ext = Path::new(&p.spritesheet_path)
        .extension()
        .and_then(|s| s.to_str())
        .filter(|s| matches!(*s, "webp" | "png"))
        .unwrap_or("webp");
    let sheet_name = format!("spritesheet.{sheet_ext}");

    let sleep_entry = if let Some(sleep_file) = &p.sleep_strip {
        let bytes = bounded(&dir.join(sleep_file), 4 * 1024 * 1024)?;
        let ext = Path::new(sleep_file)
            .extension()
            .and_then(|s| s.to_str())
            .filter(|s| matches!(*s, "png" | "webp"))
            .unwrap_or("png");
        Some((format!("sleep.{ext}"), bytes))
    } else {
        None
    };

    let mut extra_entries: Vec<(String, Vec<u8>)> = Vec::new();
    if let Some(wardrobe) = &p.wardrobe {
        for outfit in &wardrobe.outfits {
            let asset = pet_asset_path(root, id, &outfit.spritesheet_path)?;
            let bytes = bounded(&asset, MAX_IMAGE)?;
            extra_entries.push((outfit.spritesheet_path.clone(), bytes));
            if let Some(sleep_rel) = &outfit.sleep_strip {
                let sleep_asset = pet_asset_path(root, id, sleep_rel)?;
                let sleep_bytes = bounded(&sleep_asset, MAX_SLEEP)?;
                extra_entries.push((sleep_rel.clone(), sleep_bytes));
            }
        }
    }
    if let Some(activities) = &p.activities {
        for activity in activities {
            for (rel, _) in crate::wardrobe::activity_strip_specs(activity) {
                let asset = pet_asset_path(root, id, rel)?;
                let bytes = bounded(&asset, crate::wardrobe::MAX_ACTIVITY_BYTES)?;
                extra_entries.push((rel.to_owned(), bytes));
            }
        }
    }

    p.spritesheet_path = sheet_name.clone();
    p.sleep_strip = sleep_entry.as_ref().map(|(name, _)| name.clone());
    p.fingerprint.clear();
    let manifest = serde_json::to_vec_pretty(&p).map_err(|e| e.to_string())?;

    let parent = dest.parent().ok_or("文件位置无效")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let mut tmp = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    {
        let mut zip = zip::ZipWriter::new(tmp.as_file_mut());
        let deflated = zip::write::SimpleFileOptions::default();
        let stored = zip::write::SimpleFileOptions::default()
            .compression_method(zip::CompressionMethod::Stored);
        zip.start_file("pet.json", deflated)
            .map_err(|e| e.to_string())?;
        zip.write_all(&manifest).map_err(|e| e.to_string())?;
        zip.start_file(&sheet_name, stored)
            .map_err(|e| e.to_string())?;
        zip.write_all(&sheet_bytes).map_err(|e| e.to_string())?;
        if let Some((sleep_name, sleep_bytes)) = sleep_entry {
            zip.start_file(&sleep_name, stored)
                .map_err(|e| e.to_string())?;
            zip.write_all(&sleep_bytes).map_err(|e| e.to_string())?;
        }
        for (rel, data) in extra_entries {
            zip.start_file(&rel, stored).map_err(|e| e.to_string())?;
            zip.write_all(&data).map_err(|e| e.to_string())?;
        }
        zip.finish().map_err(|e| e.to_string())?;
    }
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(dest).map_err(|e| e.error.to_string())?;
    Ok(())
}
pub fn store_with_outfits(
    root: &Path,
    manifest: &[u8],
    bytes: &[u8],
    outfits: Vec<(String, Vec<u8>)>,
    outfit_sleeps: Vec<(String, Vec<u8>)>,
) -> Result<ImportResult, String> {
    store_package(
        root,
        Package {
            pet: parse(manifest)?,
            sheet: bytes.to_vec(),
            sleep: None,
            outfits,
            outfit_sleeps,
            activities: Vec::new(),
        },
    )
}
fn store_package(root: &Path, pkg: Package) -> Result<ImportResult, String> {
    let Package {
        mut pet,
        sheet,
        sleep,
        outfits,
        outfit_sleeps,
        activities,
    } = pkg;
    let (ext, cell) = validate(&sheet, pet.sprite_version_number)?;

    // Validate all optional assets before writing anything to disk.
    let validated_sleep = if let Some(data) = sleep {
        if data.len() > MAX_SLEEP as usize {
            return Err(t("host.pkgSleepBig").into());
        }
        let sleep_ext = crate::teaching::validate_strip(&data, 16)?;
        Some((sleep_ext, data))
    } else if pet.sleep_strip.is_some() {
        return Err(t("host.noSleep").into());
    } else {
        None
    };

    let mut validated_outfits = Vec::with_capacity(outfits.len());
    for (rel, data) in outfits {
        let (_, outfit_cell) = validate(&data, pet.sprite_version_number)?;
        validated_outfits.push((rel, data, outfit_cell));
    }

    let mut validated_outfit_sleeps = Vec::with_capacity(outfit_sleeps.len());
    for (rel, data) in outfit_sleeps {
        if data.len() > MAX_SLEEP as usize {
            return Err(t("host.pkgSleepBig").into());
        }
        crate::teaching::validate_strip(&data, 16)?;
        validated_outfit_sleeps.push((rel, data));
    }

    let mut validated_activities = Vec::with_capacity(activities.len());
    for (rel, frame_count, data) in activities {
        crate::wardrobe::validate_activity_strip(&data, frame_count)?;
        validated_activities.push((rel, data));
    }

    let hash = format!("{:x}", Sha256::digest(&sheet));
    if pet.id == "imported-pet" {
        pet.id = format!("pet-{}", &hash[..12]);
    }
    let dir = root.join("pets").join(&pet.id);
    let prev = if dir.join("pet.json").exists() {
        read_pet(root, &pet.id).ok()
    } else {
        None
    };
    let updated = dir.join("pet.json").exists();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;

    if let Some((sleep_ext, data)) = validated_sleep {
        let digest = format!("{:x}", Sha256::digest(&data));
        let file = format!("sleep-{}.{sleep_ext}", &digest[..16]);
        fs::write(dir.join(&file), &data).map_err(|e| e.to_string())?;
        pet.sleep_strip = Some(file);
    } else if pet.sleep_strip.is_none() {
        // Preserve an existing pet's sleepStrip across updates when the new
        // package doesn't replace it.
        if let Some(prev_sleep) = prev.as_ref().and_then(|old| old.sleep_strip.as_ref()) {
            if relative(prev_sleep).is_ok() && dir.join(prev_sleep).is_file() {
                pet.sleep_strip = Some(prev_sleep.clone());
            }
        }
    }

    // Preserve existing user-installed outfits (and per-outfit sleepStrip) across re-imports.
    if let Some(prev_wardrobe) = prev.as_ref().and_then(|old| old.wardrobe.as_ref()) {
        let mut merged = pet.wardrobe.take().unwrap_or(crate::wardrobe::PetWardrobe {
            outfits: Vec::new(),
            schedule: Vec::new(),
        });
        for outfit in &mut merged.outfits {
            if outfit.sleep_strip.is_none() {
                if let Some(prev_sleep) = prev_wardrobe
                    .outfits
                    .iter()
                    .find(|old| old.id == outfit.id)
                    .and_then(|old| old.sleep_strip.as_ref())
                {
                    if relative(prev_sleep).is_ok() && dir.join(prev_sleep).is_file() {
                        outfit.sleep_strip = Some(prev_sleep.clone());
                    }
                }
            }
        }
        for old_outfit in &prev_wardrobe.outfits {
            if merged.outfits.len() >= crate::wardrobe::MAX_PET_OUTFITS {
                break;
            }
            if merged.outfits.iter().any(|o| o.id == old_outfit.id) {
                continue;
            }
            if relative(&old_outfit.spritesheet_path).is_ok()
                && dir.join(&old_outfit.spritesheet_path).is_file()
            {
                let mut kept = old_outfit.clone();
                if let Some(ref sp) = kept.sleep_strip {
                    if relative(sp).is_err() || !dir.join(sp).is_file() {
                        kept.sleep_strip = None;
                    }
                }
                merged.outfits.push(kept);
            }
        }
        if !merged.outfits.is_empty() {
            pet.wardrobe = Some(merged);
        }
    }

    // Clear stale outfit thumbnail caches on update so changed outfits refresh cleanly.
    if updated {
        if let Ok(entries) = fs::read_dir(&dir) {
            for entry in entries.flatten() {
                let name = entry.file_name();
                let name = name.to_string_lossy();
                if name.starts_with("thumbnail-outfit-") && name.ends_with(".png") {
                    let _ = fs::remove_file(entry.path());
                }
            }
        }
    }

    for (rel, data, outfit_cell) in validated_outfits {
        let target = dir.join(&rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&target, &data).map_err(|e| e.to_string())?;
        let _ = cache_thumbnail(&outfit_thumbnail_path(&dir, &rel), &outfit_cell);
    }

    for (rel, data) in validated_outfit_sleeps {
        write_file_atomic(&dir.join(&rel), &data)?;
    }

    for (rel, data) in validated_activities {
        let target = dir.join(&rel);
        if let Some(parent) = target.parent() {
            fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        fs::write(&target, &data).map_err(|e| e.to_string())?;
    }

    pet.fingerprint = hash.clone();
    pet.spritesheet_path = format!("spritesheet-{}.{}", &hash[..16], ext);
    fs::write(dir.join(&pet.spritesheet_path), &sheet).map_err(|e| e.to_string())?;
    // A cache-write failure must not prevent importing the original pet.
    let _ = cache_thumbnail(&thumbnail_path(&dir, &pet), &cell);
    // Keep the previous manifest alongside content-addressed sheets before updating.
    if updated {
        if let Some(prev) = prev {
            let _ = write_json(&dir.join("pet.prev.json"), &prev);
        }
    }
    write_json(&dir.join("pet.json"), &pet)?;
    Ok(ImportResult {
        pet: pet.localized(),
        updated,
    })
}
/// The longest name a pet can have (raised to 40 for OpenPets pack display names).
pub const NAME_MAX: usize = 40;
pub fn clean_name(name: &str) -> Result<String, String> {
    let n = name.trim();
    if n.is_empty() || n.chars().count() > NAME_MAX {
        return Err(t("host.petNameBad").into());
    }
    Ok(n.into())
}
pub fn rename(root: &Path, id: &str, name: &str) -> Result<Pet, String> {
    let mut p = read_pet(root, id)?;
    p.display_name = clean_name(name)?;
    write_json(&root.join("pets").join(id).join("pet.json"), &p)?;
    Ok(p.localized())
}
#[cfg(test)]
#[path = "library_name_tests.rs"]
mod name_tests;
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_traversal() {
        for p in ["../a.png", "/a.png", "x/../../a.png", "x\\a.png"] {
            assert!(relative(p).is_err());
        }
        assert!(relative("assets/pet.webp").is_ok());
    }
    #[test]
    fn rejects_wrong_atlas() {
        let img = image::RgbaImage::new(10, 10);
        let mut bytes = std::io::Cursor::new(Vec::new());
        img.write_to(&mut bytes, image::ImageFormat::Png).unwrap();
        assert!(validate(bytes.get_ref(), 2).unwrap_err().contains("1536"));
    }
    #[test]
    fn imported_and_legacy_thumbnails_match_the_original_first_frame() {
        let root = tempfile::tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/mika");
        let p = import(root.path(), &source).unwrap().pet;
        let dir = root.path().join("pets").join(&p.id);
        let path = thumbnail_path(&dir, &p);
        let sheet = image::open(dir.join(&p.spritesheet_path)).unwrap();
        let expected = sheet.crop_imm(0, 0, 192, 208).into_rgba8();
        assert_eq!(image::open(&path).unwrap().into_rgba8(), expected);
        fs::remove_file(&path).unwrap(); // existing installation, before thumbnails
        assert_eq!(thumbnail(root.path(), &p.id).unwrap(), path);
        assert_eq!(image::open(&path).unwrap().into_rgba8(), expected);
        fs::rename(dir.join(&p.spritesheet_path), dir.join("held-sheet")).unwrap();
        assert_eq!(thumbnail(root.path(), &p.id).unwrap(), path); // cache hit needs no atlas
        assert!(thumbnail(root.path(), "../").is_err());
    }
    #[test]
    fn remove_deletes_the_pet_folder() {
        let root = tempfile::tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/mika");
        let p = import(root.path(), &source).unwrap().pet;
        remove(root.path(), &p.id).unwrap();
        assert!(!root.path().join("pets").join(&p.id).exists());
        assert!(list(root.path()).unwrap().is_empty());
        assert!(remove(root.path(), "../etc").is_err());
    }
    #[test]
    fn import_stores_the_new_pets_own_sleep_strip_in_both_package_formats() {
        let root = tempfile::tempdir().unwrap();
        let package = tempfile::tempdir().unwrap();
        let dir = package.path();
        let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples");
        let bytes = fs::read(examples.join("lizi-sleep/actions/sleep.png")).unwrap();
        fs::write(dir.join("sleep.png"), &bytes).unwrap();
        fs::copy(
            examples.join("lizi/spritesheet.webp"),
            dir.join("atlas.webp"),
        )
        .unwrap();
        fs::write(dir.join("pet.json"), br#"{"id":"new-pet","displayName":"Test","spriteVersionNumber":2,"spritesheetPath":"atlas.webp","sleepStrip":"sleep.png"}"#).unwrap();
        let archive = dir.join("portable.zip");
        let mut zip = zip::ZipWriter::new(fs::File::create(&archive).unwrap());
        for file in ["pet.json", "atlas.webp", "sleep.png"] {
            zip.start_file(file, zip::write::SimpleFileOptions::default())
                .unwrap();
            zip.write_all(&fs::read(dir.join(file)).unwrap()).unwrap();
        }
        zip.finish().unwrap();
        for source in [dir, archive.as_path()] {
            let p = import(root.path(), source).unwrap().pet;
            let stored = root
                .path()
                .join("pets/new-pet")
                .join(p.sleep_strip.unwrap());
            assert_eq!(fs::read(stored).unwrap(), bytes);
        }
    }
    #[test]
    fn package_preserves_identity_on_update() {
        let root = tempfile::tempdir().unwrap();
        let source = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/mika");
        let a = import(root.path(), &source).unwrap();
        assert!(!root.path().join("pets").join(&a.pet.id).join("pet.prev.json").exists());
        let b = import(root.path(), &source).unwrap();
        assert!(!a.updated);
        assert!(b.updated);
        assert_eq!(a.pet.id, b.pet.id);
        assert_eq!(list(root.path()).unwrap().len(), 1);
        let prev = root.path().join("pets").join(&a.pet.id).join("pet.prev.json");
        assert!(prev.is_file());
        let backup: Pet = serde_json::from_slice(&fs::read(prev).unwrap()).unwrap();
        assert_eq!(backup.fingerprint, a.pet.fingerprint);
    }
    #[test]
    fn export_creates_a_portable_zip_that_imports_back_cleanly() {
        let root_a = tempfile::tempdir().unwrap();
        let root_b = tempfile::tempdir().unwrap();
        let out_dir = tempfile::tempdir().unwrap();
        let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples");

        // 1. Pet with sleep strip: export -> inspect manifest -> re-import into fresh library
        let pkg = tempfile::tempdir().unwrap();
        let sleep_bytes = fs::read(examples.join("lizi-sleep/actions/sleep.png")).unwrap();
        let sheet_bytes = fs::read(examples.join("lizi/spritesheet.webp")).unwrap();
        fs::write(pkg.path().join("sleep.png"), &sleep_bytes).unwrap();
        fs::write(pkg.path().join("spritesheet.webp"), &sheet_bytes).unwrap();
        fs::write(
            pkg.path().join("pet.json"),
            r#"{"id":"xiaoju","displayName":"小橘色","spriteVersionNumber":2,"spritesheetPath":"spritesheet.webp","sleepStrip":"sleep.png"}"#.as_bytes(),
        )
        .unwrap();
        import(root_a.path(), pkg.path()).unwrap();

        let zip_with_sleep = out_dir.path().join("xiaoju.zip");
        export(root_a.path(), "xiaoju", &zip_with_sleep).unwrap();

        let mut archive = zip::ZipArchive::new(fs::File::open(&zip_with_sleep).unwrap()).unwrap();
        let mut raw = Vec::new();
        archive.by_name("pet.json").unwrap().read_to_end(&mut raw).unwrap();
        let exported: Pet = serde_json::from_slice(&raw).unwrap();
        assert_eq!(exported.spritesheet_path, "spritesheet.webp");
        assert_eq!(exported.sleep_strip.as_deref(), Some("sleep.png"));
        assert!(exported.fingerprint.is_empty());

        let reimported = import(root_b.path(), &zip_with_sleep).unwrap().pet;
        assert_eq!(reimported.id, "xiaoju");
        assert_eq!(reimported.display_name, "小橘色");
        assert_eq!(
            fs::read(root_b.path().join("pets/xiaoju").join(&reimported.spritesheet_path)).unwrap(),
            sheet_bytes
        );
        assert_eq!(
            fs::read(
                root_b
                    .path()
                    .join("pets/xiaoju")
                    .join(reimported.sleep_strip.unwrap())
            )
            .unwrap(),
            sleep_bytes
        );

        // 2. Pet without sleep strip (mika): export -> re-import cleanly
        let mika = import(root_a.path(), &examples.join("mika")).unwrap().pet;
        let zip_plain = out_dir.path().join("mika.zip");
        export(root_a.path(), &mika.id, &zip_plain).unwrap();
        let mika_back = import(root_b.path(), &zip_plain).unwrap().pet;
        assert_eq!(mika_back.id, mika.id);
        assert!(mika_back.sleep_strip.is_none());
    }

    #[test]
    fn default_lizi_localizes_while_preserving_user_customizations() {
        let root = tempfile::tempdir().unwrap();
        let lizi_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/lizi");
        import(root.path(), &lizi_dir).unwrap();
        let raw = read_pet(root.path(), LIZI_ID).unwrap();
        assert_eq!(raw.display_name, LIZI_DEFAULT_NAME);
        assert_eq!(raw.description, LIZI_DEFAULT_DESC);

        for (loc, expected_name, expected_pajamas) in [
            ("zh", "栗子", "月牙睡衣"),
            ("en", "Lizi", "Moon Pajamas"),
            ("zh-TW", "栗子", "月牙睡衣"),
            ("ja", "くり", "三日月パジャマ"),
            ("ko", "밤톨이", "초승달 잠옷"),
        ] {
            let p = raw.clone().localized_in(loc);
            assert_eq!(p.display_name, expected_name, "{loc}");
            assert_eq!(p.description, crate::locale::t_in(loc, "pet.lizi.desc"), "{loc}");
            assert_eq!(
                p.wardrobe.as_ref().unwrap().outfits[0].display_name,
                expected_pajamas,
                "{loc}"
            );
        }

        // Renaming lizi preserves the custom name verbatim and keeps the raw description on disk.
        rename(root.path(), LIZI_ID, "Mochi").unwrap();
        let renamed_raw = read_pet(root.path(), LIZI_ID).unwrap();
        assert_eq!(renamed_raw.display_name, "Mochi");
        assert_eq!(renamed_raw.description, LIZI_DEFAULT_DESC);
        let en = renamed_raw.clone().localized_in("en");
        assert_eq!(en.display_name, "Mochi");
        assert_eq!(en.description, crate::locale::t_in("en", "pet.lizi.desc"));

        // Custom description is preserved verbatim, and non-lizi pets named "栗子" are untouched.
        let mut custom_desc = renamed_raw;
        custom_desc.description = "My custom kitten".into();
        assert_eq!(custom_desc.localized_in("en").description, "My custom kitten");
        assert_eq!(localize_lizi_name("mika", LIZI_DEFAULT_NAME, "en"), LIZI_DEFAULT_NAME);
    }

    #[test]
    fn delete_outfit_removes_files_and_clears_empty_wardrobe() {
        let root = tempfile::tempdir().unwrap();
        let lizi_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/lizi");
        import(root.path(), &lizi_dir).unwrap();
        let sheet_bytes = fs::read(lizi_dir.join("spritesheet.webp")).unwrap();
        let sleep_bytes = fs::read(
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/lizi-sleep/actions/sleep.png"),
        )
        .unwrap();

        // Install two outfits (one with a per-outfit sleepStrip + schedule rule).
        let deliv1 = tempfile::tempdir().unwrap();
        fs::create_dir_all(deliv1.path().join("outfits")).unwrap();
        fs::write(deliv1.path().join("outfits/pajamas.webp"), &sheet_bytes).unwrap();
        fs::write(deliv1.path().join("outfits/pajamas-sleep.png"), &sleep_bytes).unwrap();
        fs::write(
            deliv1.path().join("outfit.json"),
            r#"{
              "petId": "lizi",
              "outfit": {
                "id": "pajamas",
                "displayName": "月牙睡衣",
                "spritesheetPath": "outfits/pajamas.webp",
                "sleepStrip": "outfits/pajamas-sleep.png"
              },
              "scheduleRule": {
                "outfit": "pajamas",
                "when": { "time": { "from": "22:00", "to": "07:00" } }
              }
            }"#,
        )
        .unwrap();
        install_outfit(root.path(), deliv1.path()).unwrap();

        let deliv2 = tempfile::tempdir().unwrap();
        fs::create_dir_all(deliv2.path().join("outfits")).unwrap();
        fs::write(deliv2.path().join("outfits/hoodie.webp"), &sheet_bytes).unwrap();
        fs::write(
            deliv2.path().join("outfit.json"),
            r#"{
              "petId": "lizi",
              "outfit": {
                "id": "hoodie",
                "displayName": "小卫衣",
                "spritesheetPath": "outfits/hoodie.webp"
              }
            }"#,
        )
        .unwrap();
        install_outfit(root.path(), deliv2.path()).unwrap();

        // Reject invalid/default/unknown ids.
        assert!(delete_outfit(root.path(), LIZI_ID, "default").is_err());
        assert!(delete_outfit(root.path(), LIZI_ID, "missing").is_err());

        // Delete first outfit: files + sleep strip + schedule rule gone, second outfit untouched.
        let removed_name = delete_outfit(root.path(), LIZI_ID, "pajamas").unwrap();
        assert_eq!(removed_name, "月牙睡衣");
        let pet_dir = root.path().join("pets").join(LIZI_ID);
        assert!(!pet_dir.join("outfits/pajamas.webp").exists());
        assert!(!pet_dir.join("outfits/pajamas-sleep.png").exists());
        assert!(pet_dir.join("outfits/hoodie.webp").exists());
        let after_one = read_pet(root.path(), LIZI_ID).unwrap();
        let w = after_one.wardrobe.as_ref().unwrap();
        assert_eq!(w.outfits.len(), 2);
        assert!(w.outfits.iter().any(|o| o.id == "hoodie"));
        assert!(w.outfits.iter().any(|o| o.id == LIZI_PAJAMAS_ID));
        assert!(w.schedule.is_empty());

        // Delete remaining outfits: wardrobe becomes None, base atlas intact.
        let removed_second = delete_outfit(root.path(), LIZI_ID, "hoodie").unwrap();
        assert_eq!(removed_second, "小卫衣");
        let removed_third = delete_outfit(root.path(), LIZI_ID, LIZI_PAJAMAS_ID).unwrap();
        assert_eq!(removed_third, LIZI_PAJAMAS_NAME);
        let after_all = read_pet(root.path(), LIZI_ID).unwrap();
        assert!(after_all.wardrobe.is_none());
        assert!(pet_dir.join(&after_all.spritesheet_path).is_file());
    }

    #[test]
    fn reimport_preserves_user_installed_custom_outfits() {
        let root = tempfile::tempdir().unwrap();
        let lizi_dir = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/lizi");
        import(root.path(), &lizi_dir).unwrap();
        let sheet_bytes = fs::read(lizi_dir.join("spritesheet.webp")).unwrap();

        let deliv = tempfile::tempdir().unwrap();
        fs::create_dir_all(deliv.path().join("outfits")).unwrap();
        fs::write(deliv.path().join("outfits/raincoat.webp"), &sheet_bytes).unwrap();
        fs::write(
            deliv.path().join("outfit.json"),
            r#"{
              "petId": "lizi",
              "outfit": {
                "id": "raincoat",
                "displayName": "小黄雨衣",
                "spritesheetPath": "outfits/raincoat.webp"
              }
            }"#,
        )
        .unwrap();
        install_outfit(root.path(), deliv.path()).unwrap();

        // Re-importing built-in Lizi must preserve the user's custom raincoat outfit.
        let res = import(root.path(), &lizi_dir).unwrap();
        assert!(res.updated);
        let w = res.pet.wardrobe.as_ref().unwrap();
        assert!(w.outfits.iter().any(|o| o.id == LIZI_PAJAMAS_ID));
        assert!(w.outfits.iter().any(|o| o.id == "raincoat" && o.display_name == "小黄雨衣"));
        assert!(root.path().join("pets").join(LIZI_ID).join("outfits/raincoat.webp").is_file());
    }
}
