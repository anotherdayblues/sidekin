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
const MAX_IMAGE: u64 = 20 * 1024 * 1024;
pub const LIZI_ID: &str = "lizi";
pub const LIZI_DEFAULT_NAME: &str = "栗子";
pub const LIZI_DEFAULT_DESC: &str = "一只温暖的原创橘白小猫，安静陪伴，也会好奇地四处走走。";
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
fn read_pet(root: &Path, id: &str) -> Result<Pet, String> {
    if !valid_id(id) {
        return Err(t("host.petIdBad").into());
    }
    let p: Pet = serde_json::from_slice(&bounded(
        &root.join("pets").join(id).join("pet.json"),
        64 * 1024,
    )?)
    .map_err(|e| e.to_string())?;
    relative(&p.spritesheet_path)?;
    if let Some(path) = &p.sleep_strip {
        relative(path)?;
    }
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
    Ok(p)
}
fn read_package(path: &Path) -> Result<(Pet, Vec<u8>, Option<Vec<u8>>), String> {
    if path.extension().is_some_and(|s| s == "zip") {
        let bytes = bounded(path, 24 * 1024 * 1024)?;
        let mut archive =
            zip::ZipArchive::new(std::io::Cursor::new(bytes)).map_err(|e| e.to_string())?;
        let manifests: Vec<String> = archive
            .file_names()
            .filter(|s| *s == "pet.json" || s.ends_with("/pet.json"))
            .map(str::to_string)
            .collect();
        if manifests.len() != 1 {
            return Err(t("host.pkgOneJson").into());
        }
        let name = &manifests[0];
        relative(name)?;
        let mut raw = Vec::new();
        archive
            .by_name(name)
            .map_err(|e| e.to_string())?
            .take(65537)
            .read_to_end(&mut raw)
            .map_err(|e| e.to_string())?;
        if raw.len() > 65536 {
            return Err(t("host.pkgJsonBig").into());
        }
        let pet = parse(&raw)?;
        let sprite = Path::new(name)
            .parent()
            .unwrap_or(Path::new(""))
            .join(&pet.spritesheet_path)
            .to_string_lossy()
            .replace('\\', "/");
        let entry = archive.by_name(&sprite).map_err(|_| t("host.pkgNoSheet"))?;
        if entry.size() > MAX_IMAGE {
            return Err(t("host.pkgSheetBig").into());
        }
        let mut image = Vec::new();
        entry
            .take(MAX_IMAGE + 1)
            .read_to_end(&mut image)
            .map_err(|e| e.to_string())?;
        let sleep = if let Some(file) = &pet.sleep_strip {
            let member = Path::new(name).parent().unwrap_or(Path::new("")).join(file);
            let mut buf = Vec::new();
            archive
                .by_name(&member.to_string_lossy().replace('\\', "/"))
                .map_err(|_| t("host.pkgNoSleep"))?
                .take(4 * 1024 * 1024 + 1)
                .read_to_end(&mut buf)
                .map_err(|e| e.to_string())?;
            Some(buf)
        } else {
            None
        };
        Ok((pet, image, sleep))
    } else {
        let manifest = if path.is_dir() {
            path.join("pet.json")
        } else {
            path.to_path_buf()
        };
        let root = manifest
            .parent()
            .ok_or(t("host.pkgWhere"))?
            .canonicalize()
            .map_err(|e| e.to_string())?;
        let pet = parse(&bounded(&manifest, 65536)?)?;
        let sprite = root
            .join(&pet.spritesheet_path)
            .canonicalize()
            .map_err(|e| e.to_string())?;
        if !sprite.starts_with(&root) {
            return Err(t("host.pkgOutside").into());
        }
        let bytes = bounded(&sprite, MAX_IMAGE)?;
        let sleep = if let Some(file) = &pet.sleep_strip {
            let path = root.join(file).canonicalize().map_err(|e| e.to_string())?;
            if !path.starts_with(&root) {
                return Err(t("host.pkgSleepOutside").into());
            }
            Some(bounded(&path, 4 * 1024 * 1024)?)
        } else {
            None
        };
        Ok((pet, bytes, sleep))
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
    let frames = [6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
    for row in 0..h / 208 {
        for col in 0..8 {
            let mut occupied = false;
            for y in row * 208..(row + 1) * 208 {
                for x in col * 192..(col + 1) * 192 {
                    if img.get_pixel(x, y)[3] > 0 {
                        occupied = true;
                        if col >= frames[row as usize] {
                            return Err(crate::locale::tf(
                                "host.pkgUnusedCell",
                                &[("row", &(row + 1))],
                            ));
                        }
                    }
                }
            }
            if col < frames[row as usize] && !occupied {
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

fn cache_thumbnail(path: &Path, cell: &image::RgbaImage) -> Result<(), String> {
    if path.is_file() {
        return Ok(());
    }
    let mut temp = tempfile::NamedTempFile::new_in(path.parent().unwrap()).map_err(|e| e.to_string())?;
    cell.write_to(temp.as_file_mut(), image::ImageFormat::Png).map_err(|e| e.to_string())?;
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
pub fn import(root: &Path, path: &Path) -> Result<ImportResult, String> {
    let (p, bytes, sleep) = read_package(path)?;
    store_pet(root, p, &bytes, sleep.as_deref())
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
        zip.finish().map_err(|e| e.to_string())?;
    }
    tmp.as_file().sync_all().map_err(|e| e.to_string())?;
    tmp.persist(dest).map_err(|e| e.error.to_string())?;
    Ok(())
}
pub fn store(root: &Path, manifest: &[u8], bytes: &[u8]) -> Result<ImportResult, String> {
    store_pet(root, parse(manifest)?, bytes, None)
}
fn store_pet(
    root: &Path,
    mut p: Pet,
    bytes: &[u8],
    sleep: Option<&[u8]>,
) -> Result<ImportResult, String> {
    let (ext, cell) = validate(bytes, p.sprite_version_number)?;
    let hash = format!("{:x}", Sha256::digest(bytes));
    if p.id == "imported-pet" {
        p.id = format!("pet-{}", &hash[..12]);
    }
    let dir = root.join("pets").join(&p.id);
    let updated = dir.join("pet.json").exists();
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    if let Some(data) = sleep {
        if data.len() > 4 * 1024 * 1024 {
            return Err(t("host.pkgSleepBig").into());
        }
        let ext = crate::teaching::validate_strip(data, 16)?;
        let digest = format!("{:x}", Sha256::digest(data));
        let file = format!("sleep-{}.{ext}", &digest[..16]);
        fs::write(dir.join(&file), data).map_err(|e| e.to_string())?;
        p.sleep_strip = Some(file);
    } else if p.sleep_strip.is_some() {
        return Err(t("host.noSleep").into());
    }
    p.fingerprint = hash.clone();
    p.spritesheet_path = format!("spritesheet-{}.{}", &hash[..16], ext);
    fs::write(dir.join(&p.spritesheet_path), bytes).map_err(|e| e.to_string())?;
    // A cache-write failure must not prevent importing the original pet.
    let _ = cache_thumbnail(&thumbnail_path(&dir, &p), &cell);
    // Keep the previous manifest alongside content-addressed sheets before updating.
    if updated {
        if let Ok(prev) = read_pet(root, &p.id) {
            let _ = write_json(&dir.join("pet.prev.json"), &prev);
        }
    }
    write_json(&dir.join("pet.json"), &p)?;
    Ok(ImportResult {
        pet: p.localized(),
        updated,
    })
}
/// The longest name a pet can have: it has to fit the title, the list tile
/// and the chat panel's header (plan/29).
pub const NAME_MAX: usize = 12;
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

        for (loc, expected_name) in [
            ("zh", "栗子"),
            ("en", "Lizi"),
            ("zh-TW", "栗子"),
            ("ja", "くり"),
            ("ko", "밤톨이"),
        ] {
            let p = raw.clone().localized_in(loc);
            assert_eq!(p.display_name, expected_name, "{loc}");
            assert_eq!(p.description, crate::locale::t_in(loc, "pet.lizi.desc"), "{loc}");
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
}
