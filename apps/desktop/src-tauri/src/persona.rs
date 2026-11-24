use crate::locale::t;
use crate::{chat, companion::Companion};
use serde_json::{json, Value};
use std::{collections::BTreeMap, fs, path::Path, sync::Mutex};
use tauri::{AppHandle, Emitter, Manager};
type R<T> = Result<T, String>;
static LOCK: Mutex<()> = Mutex::new(());
fn profiles(dir: &Path) -> R<BTreeMap<String, String>> {
    match fs::read(dir.join("personas.json")) {
        Ok(b) => serde_json::from_slice(&b).map_err(|_| t("host.personaBad").into()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.to_string()),
    }
}
pub fn default(desc: &str) -> String {
    default_in(desc, crate::locale::english())
}
/// The packaged personality in the user's language, after the pet's own words.
fn default_in(desc: &str, english: bool) -> String {
    let text = if english {
        include_str!("../../../brain/prompts/persona-default.en.md")
    } else {
        include_str!("../../../brain/prompts/persona-default.md")
    }
    .trim_end();
    let desc: String = desc
        .chars()
        .take(1500usize.saturating_sub(text.chars().count() + 1))
        .collect();
    if desc.is_empty() {
        text.into()
    } else {
        format!("{desc}\n{text}")
    }
}
pub fn get(dir: &Path, id: &str, desc: &str) -> R<String> {
    let _lock = LOCK.lock().unwrap();
    Ok(profiles(dir)?.remove(id).unwrap_or_else(|| default(desc)))
}
#[tauri::command]
pub fn get_persona(app: AppHandle) -> R<Value> {
    let (id, _, desc) = chat::pet(&app)?;
    let text = get(&app.state::<Companion>().dir, &id, &desc)?;
    Ok(json!({"petId":id,"text":text,"defaultText":default(&desc)}))
}
#[tauri::command]
pub fn save_persona(app: AppHandle, pet_id: String, text: Option<String>) -> R<()> {
    if pet_id != chat::pet(&app)?.0 {
        return Err(t("host.petSwitched").into());
    }
    save(&app.state::<Companion>().dir, &pet_id, text)
}
pub fn save(dir: &Path, pet_id: &str, text: Option<String>) -> R<()> {
    if text.as_ref().is_some_and(|v| v.chars().count() > 1500) {
        return Err(t("host.personaLimit").into());
    }
    let _lock = LOCK.lock().unwrap();
    let mut p = profiles(dir)?;
    if let Some(text) = text {
        p.insert(pet_id.to_owned(), text);
    } else {
        p.remove(pet_id);
    }
    crate::library::write_json(&dir.join("personas.json"), &p)
}
/// 上手引导's last step (plan/17 3.1): the pet speaks first, in its own
/// personality, and the bubble waits for the user's answer.
#[tauri::command]
pub async fn greet_user(app: AppHandle) -> R<()> {
    let (id, name, desc) = chat::pet(&app)?;
    let text = get(&app.state::<Companion>().dir, &id, &desc)?;
    let c = app.state::<Companion>().client()?;
    let r = tauri::async_runtime::spawn_blocking(move || {
        c.call(
            "preview",
            json!({"text":t("host.firstHello"),"pet":{"displayName":name,"personality":text}}),
        )
    })
    .await
    .map_err(|e| e.to_string())??;
    let greeting = r["text"].as_str().unwrap_or("").trim();
    if greeting.is_empty() {
        return Ok(());
    }
    let _ = app.emit_to("pet", "play-action", "waving");
    chat::show(
        &app,
        json!({"mode":"greeting","text":greeting,"at":chat::now()}),
        true,
    )
}
#[cfg(test)]
mod tests {
    #[test]
    fn the_packaged_personality_follows_the_language() {
        let zh = super::default_in("橘猫", false);
        let en = super::default_in("橘猫", true);
        assert!(zh.starts_with("橘猫\n说话方式："));
        assert!(en.starts_with("橘猫\nHow you talk:"));
    }
}
