//! A per-action collection. Selecting an existing picture only updates its current selection.
//! Legacy version files stay untouched as migration evidence, not a live history.
use super::*;
use std::sync::Mutex;
static LOCK: Mutex<()> = Mutex::new(());
#[path = "teaching_archive_migration.rs"]
mod migration;
use migration::load;

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SavedAction {
    pub id: String,
    pub name: String,
    pub action: CustomAction,
    pub created_at: u64,
    pub summary: String,
    pub used: bool,
    #[serde(default)]
    pub original: bool,
    #[serde(default, skip_deserializing)]
    pub current: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Collection {
    revision: u32,
    layer: Layer,
    items: Vec<SavedAction>,
}
fn path(root: &Path, pet: &str) -> PathBuf {
    custom_dir(root, pet).join("action-library.json")
}
fn write(root: &Path, pet: &str, c: &Collection) -> Result<(), String> {
    library::write_json(&path(root, pet), c)
}
fn identity(name: &str, action: &CustomAction) -> String {
    let data = serde_json::to_vec(&(name, action)).unwrap();
    format!("{:x}", Sha256::digest(data))[..24].to_owned()
}
fn remember(
    root: &Path,
    pet: &str,
    c: &mut Collection,
    name: &str,
    a: &CustomAction,
    source: &Path,
    summary: &str,
    used: bool,
    at: u64,
    original: bool,
) -> Result<(), String> {
    library::relative(&a.image)?;
    let source_path = source.join(&a.image);
    let bytes = library::bounded(&source_path, limits().max_image_bytes)?;
    remember_bytes(root, pet, c, name, a, &bytes, summary, used, at, original)
}
fn remember_bytes(
    root: &Path,
    pet: &str,
    c: &mut Collection,
    name: &str,
    a: &CustomAction,
    bytes: &[u8],
    summary: &str,
    used: bool,
    at: u64,
    original: bool,
) -> Result<(), String> {
    let ext = validate_strip(bytes, a.durations.len())?;
    let mut action = a.clone();
    action.image = format!(
        "assets/{}.{ext}",
        &format!("{:x}", Sha256::digest(bytes))[..16]
    );
    let target = custom_dir(root, pet).join(&action.image);
    fs::create_dir_all(target.parent().unwrap()).map_err(|e| e.to_string())?;
    if !target.exists() {
        fs::write(&target, bytes).map_err(|e| e.to_string())?;
    }
    let id = identity(name, &action);
    if let Some(old) = c.items.iter_mut().find(|x| x.id == id) {
        old.used |= used;
        old.original |= original;
    } else {
        c.items.push(SavedAction {
            id,
            name: name.into(),
            action,
            created_at: at,
            summary: summary.into(),
            used,
            original,
            current: false,
        });
    }
    Ok(())
}
fn is_current(c: &Collection, item: &SavedAction) -> bool {
    match c.layer.actions.get(&item.name) {
        Some(a) => a == &item.action,
        None => item.original && (ACTIONS.contains(&item.name.as_str()) || item.name == "sleep"),
    }
}
fn collect_draft(root: &Path, c: &mut Collection, id: &str) -> Result<(), String> {
    let (t, at) = load_draft(root, id)?;
    for (name, a) in &t.actions {
        remember(
            root,
            &t.pet_id,
            c,
            name,
            a,
            &root.join("drafts").join(id),
            &t.summary,
            false,
            at,
            false,
        )?;
    }
    Ok(())
}
pub fn current(root: &Path, pet: &str) -> Result<(u32, Layer), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let c = load(root, pet)?;
    Ok((c.revision, c.layer))
}
pub fn list(root: &Path, pet: &str) -> Result<Vec<SavedAction>, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let c = load(root, pet)?;
    let mut items = c.items.clone();
    for item in &mut items {
        item.current = is_current(&c, item);
    }
    items.sort_by_key(|i| (std::cmp::Reverse(i.created_at), i.name.clone()));
    Ok(items)
}
pub fn remember_draft(root: &Path, id: &str) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let (t, _) = load_draft(root, id)?;
    let mut c = load(root, &t.pet_id)?;
    collect_draft(root, &mut c, id)?;
    write(root, &t.pet_id, &c)
}
pub fn save_current(
    root: &Path,
    pet: &str,
    layer: &Layer,
    summary: String,
) -> Result<Version, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut c = load(root, pet)?;
    for (name, a) in &layer.actions {
        remember(
            root,
            pet,
            &mut c,
            name,
            a,
            &custom_dir(root, pet),
            &summary,
            true,
            now(),
            false,
        )?;
    }
    if c.layer != *layer {
        c.revision += 1;
        c.layer = layer.clone();
    }
    write(root, pet, &c)?;
    Ok(Version {
        version: c.revision,
        summary,
        accepted_at: now(),
    })
}
pub fn select(root: &Path, pet: &str, id: &str) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut c = load(root, pet)?;
    let index = c
        .items
        .iter()
        .position(|x| x.id == id)
        .ok_or_else(|| crate::locale::t("archive.missing"))?;
    let item = c.items[index].clone();
    if is_current(&c, &item) {
        return Ok(());
    }
    let mut layer = c.layer.clone();
    if item.original {
        layer.actions.remove(&item.name);
    } else {
        layer.actions.insert(item.name.clone(), item.action);
    }
    check_layer(&layer, &limits())?;
    c.layer = layer;
    c.revision += 1;
    c.items[index].used = true;
    write(root, pet, &c)
}
pub fn image(root: &Path, pet: &str, id: &str) -> Result<PathBuf, String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let c = load(root, pet)?;
    let item = c
        .items
        .iter()
        .find(|i| i.id == id)
        .ok_or_else(|| crate::locale::t("archive.missing"))?;
    library::relative(&item.action.image)?;
    Ok(custom_dir(root, pet).join(&item.action.image))
}
pub fn delete(root: &Path, pet: &str, id: &str) -> Result<(), String> {
    let _guard = LOCK.lock().unwrap_or_else(|e| e.into_inner());
    let mut c = load(root, pet)?;
    let item = c
        .items
        .iter()
        .find(|x| x.id == id)
        .cloned()
        .ok_or_else(|| crate::locale::t("archive.missing"))?;
    if is_current(&c, &item) {
        return Err(crate::locale::t("archive.switchFirst"));
    }
    library::relative(&item.action.image)?;
    // Close any pending bundle containing this exact candidate. Its other actions stay saved.
    let mut dismiss = vec![];
    for e in fs::read_dir(root.join("drafts"))
        .into_iter()
        .flatten()
        .flatten()
    {
        let draft_id = e.file_name().to_string_lossy().to_string();
        if let Ok((t, _)) = load_draft(root, &draft_id) {
            if t.pet_id != pet {
                continue;
            }
            if let Some(a) = t.actions.get(&item.name) {
                let bytes = library::bounded(&e.path().join(&a.image), limits().max_image_bytes)?;
                let mut a = a.clone();
                let ext = validate_strip(&bytes, a.durations.len())?;
                a.image = format!(
                    "assets/{}.{ext}",
                    &format!("{:x}", Sha256::digest(&bytes))[..16]
                );
                if identity(&item.name, &a) == id {
                    collect_draft(root, &mut c, &draft_id)?;
                    dismiss.push(e.path());
                }
            }
        }
    }
    c.items.retain(|x| x.id != id);
    write(root, pet, &c)?;
    for dir in dismiss {
        fs::remove_dir_all(dir).map_err(|e| e.to_string())?;
    }
    // Shared images remain until the last saved variant using them is deleted.
    if !c.items.iter().any(|x| x.action.image == item.action.image)
        && !c
            .layer
            .actions
            .values()
            .any(|a| a.image == item.action.image)
    {
        let file = custom_dir(root, pet).join(&item.action.image);
        if file.exists() {
            if let Err(error) = recycle(root, &file) {
                c.items.push(item);
                write(root, pet, &c)?;
                return Err(error);
            }
        }
    }
    Ok(())
}
#[cfg(not(test))]
fn recycle(_root: &Path, file: &Path) -> Result<(), String> {
    crate::phone::trash::trash(file)
}
#[cfg(test)]
fn recycle(root: &Path, file: &Path) -> Result<(), String> {
    let bin = root.join("test-trash");
    fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    fs::rename(file, bin.join(file.file_name().unwrap())).map_err(|e| e.to_string())
}

#[cfg(test)]
#[path = "teaching_archive_tests.rs"]
mod tests;
