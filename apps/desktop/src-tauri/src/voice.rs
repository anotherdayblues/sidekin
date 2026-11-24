//! 宠物声音 (plan/10 §9): the voice settings, the voice's key and the
//! "speaking now" flag. Kept in voice.json, apart from settings.json: that
//! file refuses unknown fields, so an older 随伴 could not read it back.
use crate::locale::t;
use crate::{companion::Companion, credentials};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::atomic::{AtomicBool, Ordering},
};
use tauri::{AppHandle, Emitter, Manager};

#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Voice {
    /// 宠物声音: replies and reminders are spoken.
    pub enabled: bool,
    pub provider: String,
    pub voice: String,
    pub voice_label: String,
    pub base_url: String,
    pub model: String,
    /// Volcengine only.
    pub resource_id: String,
    pub app_id: String,
    /// OpenAI-compatible only: how to speak.
    pub instructions: String,
    /// The saved key's reference for each service, so switching back keeps it.
    #[serde(skip_serializing_if = "BTreeMap::is_empty")]
    pub keys: BTreeMap<String, String>,
}

fn services() -> Value {
    serde_json::from_str(include_str!("../../../shared/voiceServices.json")).unwrap()
}
fn path(dir: &Path) -> std::path::PathBuf {
    dir.join("voice.json")
}
pub fn read(dir: &Path) -> Voice {
    std::fs::read(path(dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
fn write(dir: &Path, v: &Voice) -> Result<(), String> {
    crate::library::write_json(&path(dir), v)
}
fn account(provider: &str) -> String {
    format!("voice-{provider}")
}
fn valid_url(url: &str) -> bool {
    url.is_empty()
        || ["https://", "http://", "wss://", "ws://"]
            .iter()
            .any(|p| url.starts_with(p))
}
/// Checks what the settings page sends; keys are never part of it.
fn checked(next: Voice, old: &Voice) -> Result<Voice, String> {
    if !next.provider.is_empty() && services().get(&next.provider).is_none() {
        return Err(t("host.voiceUnknown").into());
    }
    if !valid_url(next.base_url.trim()) {
        return Err(t("host.voiceUrl").into());
    }
    if next.voice.chars().count() > 200 || next.instructions.chars().count() > 500 {
        return Err(t("host.voiceLong").into());
    }
    Ok(Voice {
        keys: old.keys.clone(),
        base_url: next.base_url.trim().into(),
        voice: next.voice.trim().into(),
        model: next.model.trim().into(),
        resource_id: next.resource_id.trim().into(),
        app_id: next.app_id.trim().into(),
        ..next
    })
}
/// The voice for the brain, with its key, when it can speak; `force` ignores
/// the on/off switch (试听).
pub fn config(dir: &Path, force: bool) -> Option<Value> {
    let v = read(dir);
    if !(v.enabled || force) || v.provider.is_empty() || v.voice.is_empty() {
        return None;
    }
    let reference = v.keys.get(&v.provider)?;
    let key = credentials::Store::default()
        .key(&account(&v.provider), reference)
        .ok()
        .filter(|k| !k.is_empty())?;
    let mut c = json!({"provider": v.provider, "apiKey": key, "voice": v.voice});
    for (field, value) in [
        ("baseUrl", &v.base_url),
        ("model", &v.model),
        ("resourceId", &v.resource_id),
        ("appId", &v.app_id),
        ("instructions", &v.instructions),
    ] {
        if !value.is_empty() {
            c[field] = json!(value);
        }
    }
    Some(c)
}

/// The settings page's view: everything but key references.
fn view(v: &Voice) -> Value {
    let mut out = serde_json::to_value(Voice {
        keys: BTreeMap::new(),
        ..v.clone()
    })
    .unwrap();
    out["hasKey"] = json!(v.keys.contains_key(&v.provider));
    out["ready"] =
        json!(!v.provider.is_empty() && !v.voice.is_empty() && v.keys.contains_key(&v.provider));
    out
}
fn changed(app: &AppHandle, v: &Voice) -> Value {
    let out = view(v);
    let _ = app.emit("voice-changed", &out);
    out
}
fn dir(app: &AppHandle) -> std::path::PathBuf {
    app.state::<Companion>().dir.clone()
}

#[tauri::command]
pub fn get_voice(app: AppHandle) -> Value {
    view(&read(&dir(&app)))
}
#[tauri::command]
pub fn save_voice(app: AppHandle, voice: Voice) -> Result<Value, String> {
    let d = dir(&app);
    let next = checked(voice, &read(&d))?;
    write(&d, &next)?;
    Ok(changed(&app, &next))
}
#[tauri::command]
pub async fn list_voice_options(
    app: AppHandle,
    window: tauri::WebviewWindow,
    voice: Voice,
    key: String,
) -> Result<Value, String> {
    if window.label() != "studio" {
        return Err(t("host.voiceInMain").into());
    }
    let state = app.state::<Companion>();
    let old = read(&state.dir);
    let draft = checked(voice, &old)?;
    let key = if !key.trim().is_empty() {
        key.trim().to_owned()
    } else {
        match old.keys.get(&draft.provider) {
            Some(r)
                if draft.base_url.is_empty()
                    || (draft.provider == old.provider && draft.base_url == old.base_url) =>
            {
                credentials::Store::default().key(&account(&draft.provider), r)?
            }
            Some(_) => return Err(t("host.voiceUrlChanged").into()),
            None => String::new(),
        }
    };
    let dir = state.dir.clone();
    let params = json!({"provider":draft.provider, "baseUrl":draft.base_url, "model":draft.model, "resourceId":draft.resource_id,"apiKey":key});
    tauri::async_runtime::spawn_blocking(move || {
        crate::model_setup::probe_with_params(&dir, json!({"apiKey": ""}), "voice_catalog", params)
    })
    .await
    .map_err(|_| t("host.voiceList"))?
}
/// The switch in settings and the pet's menu. Turning it off stops speech.
#[tauri::command]
pub async fn set_voice_enabled(app: AppHandle, on: bool) -> Result<Value, String> {
    let d = dir(&app);
    let mut v = read(&d);
    v.enabled = on;
    write(&d, &v)?;
    if !on {
        let _ = stop_speech(app.clone()).await;
    }
    Ok(changed(&app, &v))
}
#[tauri::command]
pub async fn save_voice_key(
    app: AppHandle,
    provider: String,
    key: String,
) -> Result<Value, String> {
    if services().get(&provider).is_none() {
        return Err(t("host.voiceUnknown").into());
    }
    let d = dir(&app);
    let id = account(&provider);
    let store = credentials::Store::default();
    let reference = store.save(&d, &id, &key, json!({"service": id}), &Default::default())?;
    let mut v = read(&d);
    v.keys.insert(provider, reference.clone());
    write(&d, &v)?;
    let _ = store.activated(&d, &id, &reference, &[reference.clone()].into());
    Ok(changed(&app, &v))
}
/// Stops a spoken reply: the brain cancels the voice service.
#[tauri::command]
pub async fn stop_speech(app: AppHandle) -> Result<(), String> {
    // The pet window falls silent at once; the brain is asked only while it
    // is still making audio, so typing can call this freely.
    let _ = app.emit_to("pet", "speech", json!({"method":"speech.stop","params":{}}));
    if !speaking() {
        return Ok(());
    }
    let c = app.state::<Companion>().client()?;
    tauri::async_runtime::spawn_blocking(move || c.call("speech_stop", json!({})))
        .await
        .map_err(|e| e.to_string())??;
    Ok(())
}
/// 试听: says one line with the current voice, even while it is switched off.
#[tauri::command]
pub async fn test_voice(app: AppHandle) -> Result<(), String> {
    let d = dir(&app);
    let config = config(&d, true).ok_or(t("host.voiceSetup"))?;
    let state = app.state::<crate::State>();
    let active = state.settings.lock().unwrap().active_id.clone();
    let name = active
        .and_then(|id| crate::library::pet(&state.root, &id).ok())
        .map(|p| p.display_name)
        .unwrap_or_else(|| t("app.name").into());
    let hello = crate::locale::tf("host.voiceHello", &[("name", &name)]);
    say(&app, &hello, config).await
}
/// Speaks `text` (a reminder) when 宠物声音 is on.
pub fn speak_if_on(app: &AppHandle, text: &str) {
    let Some(config) = config(&dir(app), false) else {
        return;
    };
    let app = app.clone();
    let text = text.to_owned();
    tauri::async_runtime::spawn(async move {
        let _ = say(&app, &text, config).await;
    });
}
async fn say(app: &AppHandle, text: &str, config: Value) -> Result<(), String> {
    let c = app.state::<Companion>().client()?;
    let params = json!({"text": text, "speak": config});
    tauri::async_runtime::spawn_blocking(move || c.call("speak", params))
        .await
        .map_err(|e| e.to_string())??;
    Ok(())
}

/// Whether a spoken reply may be playing now, from the audio the brain sends.
static SPEAKING: AtomicBool = AtomicBool::new(false);
pub fn heard(method: &str) {
    SPEAKING.store(method == "speech.audio", Ordering::Relaxed);
}
pub fn speaking() -> bool {
    SPEAKING.load(Ordering::Relaxed)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_known_services_and_safe_addresses_are_kept() {
        let old = Voice {
            keys: [("minimax".into(), "ref".into())].into(),
            ..Voice::default()
        };
        let next = checked(
            Voice {
                provider: "minimax".into(),
                voice: " v ".into(),
                keys: BTreeMap::new(),
                ..Voice::default()
            },
            &old,
        )
        .unwrap();
        assert_eq!(next.voice, "v");
        assert_eq!(next.keys, old.keys, "the page cannot change key references");
        assert!(checked(
            Voice {
                provider: "nope".into(),
                ..Voice::default()
            },
            &old
        )
        .is_err());
        assert!(checked(
            Voice {
                base_url: "file:///etc".into(),
                ..Voice::default()
            },
            &old
        )
        .is_err());
        for p in ["openai", "aliyun", "volcengine", "minimax", "elevenlabs"] {
            assert!(services().get(p).is_some(), "{p}");
        }
    }

    #[test]
    fn the_page_sees_no_key_references_and_knows_when_it_is_ready() {
        let v = Voice {
            provider: "volcengine".into(),
            voice: "zh_female".into(),
            keys: [("volcengine".into(), "voice-volcengine/1".into())].into(),
            ..Voice::default()
        };
        let out = view(&v);
        assert!(out.get("keys").is_none());
        assert_eq!(out["hasKey"], true);
        assert_eq!(out["ready"], true);
        let other = view(&Voice {
            provider: "openai".into(),
            ..v
        });
        assert_eq!(other["hasKey"], false, "the key belongs to another service");
    }

    #[test]
    fn settings_survive_unknown_fields_and_a_missing_file() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(read(d.path()), Voice::default());
        std::fs::write(
            path(d.path()),
            r#"{"enabled":true,"provider":"aliyun","later":1}"#,
        )
        .unwrap();
        let v = read(d.path());
        assert!(v.enabled);
        assert_eq!(v.provider, "aliyun");
        assert!(
            config(d.path(), false).is_none(),
            "no voice and no key: nothing to speak"
        );
    }

    #[test]
    fn speaking_follows_the_audio() {
        heard("speech.audio");
        assert!(speaking());
        heard("speech.end");
        assert!(!speaking());
    }
}
