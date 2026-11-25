use crate::locale::t;
use crate::{
    brain::{Client, Supervisor},
    library,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
};
use tauri::{AppHandle, Emitter, Manager};
#[cfg(test)]
#[path = "companion_commit_tests.rs"]
mod commit_regression;
#[cfg(test)]
#[path = "companion_online_tests.rs"]
mod online_regression;

#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BackupModel {
    pub service: String,
    pub base_url: String,
    pub model: String,
    #[serde(default)]
    pub can_see: bool,
    #[serde(default)]
    pub credential_ref: String,
}
impl BackupModel {
    fn settings(&self) -> Settings {
        Settings {
            enabled: true,
            service: self.service.clone(),
            base_url: self.base_url.clone(),
            model: self.model.clone(),
            can_see: self.can_see,
            credential_ref: self.credential_ref.clone(),
            ..Settings::default()
        }
    }
}
#[derive(Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Search {
    #[serde(default)]
    pub credential_ref: String,
    pub provider: String,
    #[serde(default)]
    pub base_url: String,
}
impl Search {
    fn account(&self) -> Result<Settings, String> {
        let endpoint = match self.provider.as_str() {
            "bocha" => "https://api.bocha.cn",
            "glm" => "https://open.bigmodel.cn",
            "tavily" => "https://api.tavily.com",
            "brave" => "https://api.search.brave.com",
            "searxng" => &self.base_url,
            _ => return Err(t("host.searchUnknown").into()),
        };
        let mut s = Settings {
            service: "custom".into(),
            enabled: true,
            base_url: endpoint.into(),
            ..Settings::default()
        };
        s.validate()?;
        s.service = format!("search-{}", self.provider);
        s.credential_ref = self.credential_ref.clone();
        Ok(s)
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase", deny_unknown_fields)]
pub struct Settings {
    pub fallbacks: Vec<BackupModel>,
    pub search: Option<Search>,
    pub follow_search: bool,
    pub search_daily_limit: u32,
    pub daily_limit: u64,
    pub protocol: String,
    pub credential_ref: String,
    pub model_verified: bool,
    pub tool_check: Value,
    pub enabled: bool,
    pub service: String,
    pub base_url: String,
    pub model: String,
    pub vision_model: String,
    pub can_see: bool,
    pub context_window: u32,
    pub reminders: bool,
    pub memory: bool,
    pub vision: bool,
    pub vision_shortcut: String,
    /// Optional global shortcut to snip a screen region directly into the chat sidebar.
    pub chat_snip_shortcut: String,
    pub translation: bool,
    /// Copy twice in a moment to translate what was copied.
    pub copy_twice: bool,
    pub clipboard_shortcut: String,
    /// Translates the selection, or opens the translation bubble to type in
    /// (plan/41). Older builds read this field and ignore it.
    pub translation_shortcut: String,
    pub translation_target: String,
    pub personality: String,
    pub chat_shortcut: String,
    /// Opens and puts away the chat side panel.
    pub panel_shortcut: String,
    /// "system", "zh" or "en" (plan/15). A settings file from before this
    /// existed belongs to someone already using 随伴 in Chinese.
    #[serde(default = "chinese")]
    pub language: String,
}
fn chinese() -> String {
    "zh".into()
}
impl Default for Settings {
    fn default() -> Self {
        Self {
            fallbacks: vec![],
            search: None,
            follow_search: true,
            search_daily_limit: 20,
            daily_limit: 0,
            protocol: String::new(),
            credential_ref: String::new(),
            model_verified: false,
            tool_check: Value::Null,
            enabled: false,
            service: "openai".into(),
            base_url: "https://api.openai.com/v1".into(),
            model: "gpt-5.4-mini".into(),
            vision_model: String::new(),
            can_see: false,
            context_window: 32768,
            reminders: true,
            memory: true,
            vision: true,
            vision_shortcut: crate::shortcuts::VISION.into(),
            chat_snip_shortcut: crate::shortcuts::CHAT_SNIP.into(),
            translation: true,
            copy_twice: true,
            clipboard_shortcut: crate::shortcuts::CLIPBOARD.into(),
            translation_shortcut: crate::shortcuts::TRANSLATE.into(),
            translation_target: "auto".into(),
            personality: String::new(),
            chat_shortcut: crate::shortcuts::CHAT.into(),
            panel_shortcut: crate::shortcuts::PANEL.into(),
            language: "system".into(),
        }
    }
}
impl Settings {
    pub(crate) fn credential_accounts(&self) -> Result<BTreeSet<String>, String> {
        let mut refs = BTreeSet::new();
        let mut add = |s: &Settings| {
            let id = crate::credentials::binding(&s.service, &s.base_url);
            if s.credential_ref != "none" {
                refs.insert(if s.credential_ref.is_empty() {
                    id
                } else {
                    s.credential_ref.clone()
                });
            }
        };
        add(self); // Keep the configured primary even when the brain is switched off.
        for b in &self.fallbacks {
            add(&b.settings());
        }
        if let Some(search) = &self.search {
            add(&search.account()?);
        }
        Ok(refs)
    }
    pub(crate) fn validate(&self) -> Result<(), String> {
        if self.fallbacks.len() > 2 || self.daily_limit > 1_000_000_000 {
            return Err(t("host.backupLimits").into());
        }
        for b in &self.fallbacks {
            if b.model.trim().is_empty() {
                return Err(t("host.backupName").into());
            }
            b.settings().validate()?;
        }
        if let Some(search) = &self.search {
            search.account()?;
        }
        #[cfg(feature = "acceptance")]
        if tauri::Url::parse(&self.base_url)
            .ok()
            .and_then(|u| u.host_str().map(str::to_owned))
            .as_deref()
            != Some("127.0.0.1")
        {
            return Err("验收只允许本地测试地址".into());
        }

        crate::model_setup::service_info(&self.service)?;
        if !self.protocol.is_empty()
            && ![
                "openai-completions",
                "openai-responses",
                "anthropic-messages",
                "google-generative-ai",
            ]
            .contains(&self.protocol.as_str())
        {
            return Err(t("host.protocolUnknown").into());
        }
        if !self.base_url.is_empty() || self.enabled {
            crate::credentials::endpoint(&self.base_url)?;
        }
        if !(256..=16_000_000).contains(&self.context_window) {
            return Err(t("host.contextRange").into());
        }
        if !crate::locale::is_valid_choice(&self.language) {
            return Err(t("host.languageUnknown").into());
        }
        Ok(())
    }
}
fn credential(s: &Settings) -> Result<String, String> {
    crate::credentials::Store::default().key(
        &crate::credentials::binding(&s.service, &s.base_url),
        &s.credential_ref,
    )
}

pub(crate) fn commit_configuration(
    dir: &Path,
    next: &Settings,
    apply: impl FnOnce() -> Result<(), String>,
    restore: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let path = dir.join("settings.json");
    let previous: Option<Value> = match fs::read(&path) {
        Ok(bytes) => Some(serde_json::from_slice(&bytes).map_err(|_| t("host.oldSettingsBad"))?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err(t("host.oldSettingsRead").into()),
    };
    library::write_json(&path, next)?;
    if let Err(error) = apply() {
        let disk = match previous {
            Some(value) => library::write_json(&path, &value),
            None => fs::remove_file(&path).map_err(|e| e.to_string()),
        };
        let runtime = restore();
        if disk.is_err() || runtime.is_err() {
            return Err(t("host.restoreFailed").into());
        }
        return Err(error);
    }
    Ok(())
}

pub struct Companion {
    pub dir: PathBuf,
    pub host: Arc<crate::host::Host>,
    pub settings: Mutex<Settings>,
    pub(crate) changes: Mutex<()>,
    pub(crate) checks: Mutex<crate::model_setup::Checks>,
    running: Mutex<Option<Supervisor>>,
    clock: Mutex<Option<crate::reminders::Clock>>,
}
impl Companion {
    pub fn open(root: &Path) -> Result<Self, String> {
        let dir = crate::migrate::shared(&root.join("brain"))?;
        fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        crate::reminders::db(&dir)?
            .execute(
                "UPDATE task_modes SET mode='agent' WHERE mode='research'",
                [],
            )
            .map_err(|e| e.to_string())?;
        let mut settings = match fs::read(dir.join("settings.json")) {
            Ok(bytes) => serde_json::from_slice(&bytes).map_err(|_| t("host.settingsBad"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Settings::default(),
            Err(e) => return Err(e.to_string()),
        };
        // Old builds' default shortcuts become today's; the next save keeps them.
        crate::shortcuts::refresh_defaults(&mut settings);
        crate::locale::set(&settings.language);
        crate::reminders::db(&dir)?
            .execute(
                "UPDATE task_runs SET status='failed',result=?1 WHERE status='running'",
                [t("host.taskInterrupted")],
            )
            .map_err(|e| e.to_string())?;
        Ok(Self {
            host: Arc::new(crate::host::Host::new(dir.clone(), root.join("library"))?),
            dir,
            settings: Mutex::new(settings),
            changes: Mutex::new(()),
            checks: Default::default(),
            running: Mutex::new(None),
            clock: Mutex::new(None),
        })
    }
    pub fn client(&self) -> Result<Client, String> {
        self.running
            .lock()
            .unwrap()
            .as_ref()
            .map(|s| s.client.clone())
            .ok_or_else(|| "disabled".into())
    }
    fn sync_clock(&self, app: &AppHandle, s: &Settings) -> Result<(), String> {
        let enabled = s.enabled && s.reminders;
        self.host
            .reminders
            .store(enabled, std::sync::atomic::Ordering::Release);
        let mut clock = self.clock.lock().unwrap();
        if !enabled {
            clock.take();
        } else if clock.is_none() {
            crate::chat::ensure(app)?;
            *clock = Some(crate::reminders::Clock::start(
                app.clone(),
                self.dir.clone(),
                self.host.alarm.clone(),
            ));
        }
        Ok(())
    }
    pub(crate) fn sync(&self, app: &AppHandle, s: &Settings, key: String) -> Result<(), String> {
        self.host.search_limit.store(
            s.search_daily_limit.into(),
            std::sync::atomic::Ordering::Release,
        );
        self.host
            .daily_limit
            .store(s.daily_limit, std::sync::atomic::Ordering::Release);
        crate::shortcuts::apply(app, s)?;
        self.sync_clock(app, s)?;
        self.host
            .memory
            .store(s.enabled && s.memory, std::sync::atomic::Ordering::Release);
        let mut slot = self.running.lock().unwrap();
        if !s.translation || !s.enabled {
            crate::selection::invalidate();
        }
        if !s.enabled || !s.vision {
            crate::snip::clear(app);
        }
        if !s.enabled {
            slot.take();
            if let Some(w) = app.get_webview_window("bubble") {
                let _ = w.hide();
            }
            app.state::<crate::chat::Chat>()
                .intent
                .lock()
                .unwrap()
                .take();
            return Ok(());
        }
        crate::chat::ensure(app)?;
        let mut config = serde_json::to_value(s).map_err(|e| e.to_string())?;
        config["apiKey"] = key.into();
        config["hostClock"] = true.into();
        config["locale"] = crate::locale::resolve(&s.language).into();
        config["meterUsage"] = true.into();
        for (index, b) in s.fallbacks.iter().enumerate() {
            config["fallbacks"][index]["apiKey"] = credential(&b.settings())?.into();
        }
        if let Some(search) = &s.search {
            config["search"]["apiKey"] = credential(&search.account()?)?.into();
        }
        if let Some(brain) = slot.as_ref() {
            brain.client.call("configure", config)?;
        } else {
            let exe = std::env::current_exe()
                .map_err(|e| e.to_string())?
                .with_file_name(format!("companion-brain{}", std::env::consts::EXE_SUFFIX));
            let app = app.clone();
            *slot = Some(Supervisor::with_host(
                exe,
                vec![],
                config,
                self.dir.join("logs"),
                Arc::new(move |method, data| {
                    // Spoken replies play in the pet window only (plan/10 §9).
                    if method.starts_with("speech.") {
                        crate::voice::heard(method);
                        let _ =
                            app.emit_to("pet", "speech", json!({"method":method,"params":data}));
                        return;
                    }
                    if method == "chat.reminderChanged" {
                        let _ = app.emit_to("studio", "reminders-changed", ());
                        crate::tips::noticed("reminder");
                    }
                    if method == "chat.remembered" {
                        crate::tips::noticed("memory");
                        let _ = app.emit_to("studio", "memory-changed", ());
                        let mut bubble = data.clone();
                        let token = data["token"].as_str().unwrap_or("");
                        bubble["receipt"] = app
                            .state::<Companion>()
                            .host
                            .recent_write
                            .lock()
                            .unwrap()
                            .notice(token)
                            .into();
                        let _ = app.emit_to(
                            "bubble",
                            "brain-event",
                            json!({"method":method,"params":bubble}),
                        );
                        let _ = app.emit_to(
                            "pet",
                            "brain-event",
                            json!({"method":method,"params":data}),
                        );
                        return;
                    }
                    crate::chat::notify(&app, method, &data);
                    let _ = app.emit("brain-event", json!({"method":method,"params":data}));
                }),
                Some(self.host.clone()),
            ));
        }
        Ok(())
    }
}
pub fn startup(app: AppHandle) {
    std::thread::spawn(move || {
        let state = app.state::<Companion>();
        let _change = state.changes.lock().unwrap();
        let s = state.settings.lock().unwrap().clone();
        // Clipboard history has its own shortcut even with the AI companion off.
        let _ = crate::shortcuts::apply(&app, &s);
        // Timers and pending deliveries are independent of model/keychain availability.
        let _ = state.sync_clock(&app, &s);
        if s.enabled
            && credential(&s)
                .and_then(|key| state.sync(&app, &s, key))
                .is_err()
        {
            let _ = app.emit("brain-event", json!({"method":"crash"}));
        }
    });
}
#[tauri::command]
pub fn companion_settings(state: tauri::State<Companion>) -> Settings {
    state.settings.lock().unwrap().clone()
}
/// "zh" or "en": what every window shows its text in.
#[tauri::command]
pub fn app_language(state: tauri::State<Companion>) -> &'static str {
    crate::locale::resolve(&state.settings.lock().unwrap().language)
}

fn stage_online_keys<S: crate::credentials::Secrets>(
    dir: &Path,
    settings: &mut Settings,
    old: &Settings,
    fallback_keys: Option<Vec<Option<String>>>,
    search_key: Option<String>,
    store: &crate::credentials::Store<S>,
    protected: &mut BTreeSet<String>,
    mut verify: impl FnMut(&Settings, &str, bool) -> Result<(), String>,
) -> Result<Vec<(String, String)>, String> {
    if fallback_keys.is_none()
        && search_key.is_none()
        && settings.fallbacks == old.fallbacks
        && settings.search == old.search
    {
        return Ok(Vec::new());
    }
    let mut keys = fallback_keys.unwrap_or_default();
    if keys.len() > settings.fallbacks.len() {
        return Err(t("host.backupKeysMismatch").into());
    }
    keys.resize(settings.fallbacks.len(), None);
    let known = old.credential_accounts()?;
    let resolve = |account: &mut Settings, raw: Option<&String>| -> Result<String, String> {
        if let Some(raw) = raw {
            return crate::credentials::checked_key(raw).map(str::to_owned);
        }
        let id = crate::credentials::binding(&account.service, &account.base_url);
        if account.credential_ref.is_empty() {
            account.credential_ref = known
                .iter()
                .find(|r| *r == &id || r.starts_with(&format!("{id}/")))
                .map(|r| if r == &id { String::new() } else { r.clone() })
                .unwrap_or_default();
        }
        let mut key = store.key(&id, &account.credential_ref)?;
        if key.is_empty() && account.credential_ref.is_empty() {
            if let Some(reference) = store.pending(dir, &id)? {
                key = store.key(&id, &reference)?;
                account.credential_ref = reference;
            }
        }
        Ok(key)
    };
    struct Candidate {
        backup: Option<usize>,
        account: Settings,
        key: String,
        new_key: bool,
    }
    let mut candidates = Vec::new();
    // Validate the whole group before writing any replacement credentials.
    for (index, (backup, raw)) in settings.fallbacks.iter_mut().zip(&keys).enumerate() {
        if raw.is_none() && old.fallbacks.contains(backup) {
            continue;
        }
        if raw.is_some() {
            backup.base_url = crate::credentials::endpoint(&backup.base_url)?;
        }
        let mut account = backup.settings();
        let key = resolve(&mut account, raw.as_ref())?;
        if key.is_empty()
            && crate::model_setup::service_info(&account.service)?["keyRequired"] == true
        {
            return Err(format!("backup:{}:missingKey", index + 1));
        }
        verify(&account, &key, false).map_err(|e| format!("backup:{}:{e}", index + 1))?;
        candidates.push(Candidate {
            backup: Some(index),
            account,
            key,
            new_key: raw.is_some(),
        });
    }
    if let Some(search) = settings
        .search
        .as_ref()
        .filter(|search| search_key.is_some() || old.search.as_ref() != Some(*search))
    {
        let mut account = search.account()?;
        let key = resolve(&mut account, search_key.as_ref())?;
        if key.is_empty() && search.provider != "searxng" {
            return Err("search:missingKey".into());
        }
        verify(&account, &key, true).map_err(|e| format!("search:{e}"))?;
        candidates.push(Candidate {
            backup: None,
            account,
            key,
            new_key: search_key.is_some(),
        });
    }
    let mut changed = Vec::new();
    for candidate in candidates {
        let account = candidate.account;
        let id = crate::credentials::binding(&account.service, &account.base_url);
        let reference = if candidate.new_key {
            let draft = if candidate.backup.is_some() {
                serde_json::to_value(crate::model_setup::Draft::from_settings(&account)).unwrap()
            } else {
                json!({"service":account.service})
            };
            store.save(dir, &id, &candidate.key, draft, protected)?
        } else {
            account.credential_ref
        };
        protected.insert(if reference.is_empty() {
            id.clone()
        } else {
            reference.clone()
        });
        if let Some(index) = candidate.backup {
            settings.fallbacks[index].credential_ref = reference.clone();
        } else {
            settings.search.as_mut().unwrap().credential_ref = reference.clone();
        }
        if !reference.is_empty() && reference != "none" {
            changed.push((id, reference));
        }
    }
    Ok(changed)
}

fn verify_online_connection(
    dir: &Path,
    account: &Settings,
    key: &str,
    search: bool,
) -> Result<(), String> {
    if search {
        let provider = account
            .service
            .strip_prefix("search-")
            .ok_or(t("host.searchUnknown"))?;
        crate::model_setup::probe_config(
            dir,
            json!({
                "service":"custom", "model":"", "baseUrl":"", "apiKey":"",
                "search":{"provider":provider,"baseUrl":account.base_url,"apiKey":key}
            }),
            "search_test",
        )?;
    } else {
        let mut config =
            serde_json::to_value(crate::model_setup::Draft::from_settings(account)).unwrap();
        config["apiKey"] = key.into();
        crate::model_setup::probe_config(dir, config, "test")?;
    }
    Ok(())
}

#[tauri::command]
pub async fn save_companion(
    app: AppHandle,
    window: tauri::WebviewWindow,
    mut settings: Settings,
    new_key: Option<String>,
    fallback_keys: Option<Vec<Option<String>>>,
    search_key: Option<String>,
) -> Result<Settings, String> {
    if window.label() != "studio" {
        return Err(t("host.settingsInMain").into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        if new_key.is_some() {
            return Err(t("host.mainKeyInSetup").into());
        }
        let state = app.state::<Companion>();
        let _change = state.changes.lock().unwrap();
        let old = state.settings.lock().unwrap().clone();
        crate::model_setup::Draft::from_settings(&old)
            .install(&mut settings, old.credential_ref.clone());
        settings.model_verified = old.model_verified;
        settings.tool_check = old.tool_check.clone();
        settings.validate()?;
        let store = crate::credentials::Store::default();
        let mut protected = old.credential_accounts()?;
        protected.extend(settings.credential_accounts()?);
        store.retain_references(&state.dir, &old.credential_accounts()?)?;
        let changed_keys = stage_online_keys(
            &state.dir,
            &mut settings,
            &old,
            fallback_keys,
            search_key,
            &store,
            &mut protected,
            |account, key, search| verify_online_connection(&state.dir, account, key, search),
        )?;
        let key = if settings.enabled {
            credential(&settings)?
        } else {
            String::new()
        };
        if settings.enabled
            && crate::model_setup::service_info(&settings.service)?["keyRequired"] == true
            && key.is_empty()
        {
            return Err(t("host.keyThenTest").into());
        }
        let old_key = if old.enabled {
            credential(&old)?
        } else {
            String::new()
        };
        commit_configuration(
            &state.dir,
            &settings,
            || state.sync(&app, &settings, key),
            || state.sync(&app, &old, old_key),
        )?;
        *state.settings.lock().unwrap() = settings.clone();
        let prev_locale = crate::locale::current();
        crate::locale::set(&settings.language);
        if crate::locale::current() != prev_locale {
            let handle = app.clone();
            let _ = app.run_on_main_thread(move || {
                crate::tray_menu::refresh_locale(&handle);
                crate::refresh_window_titles(&handle);
            });
            if let Ok(snap) = crate::snapshot(&app) {
                let _ = app.emit("library-changed", snap);
            }
        }
        let in_use = settings.credential_accounts()?;
        for (id, reference) in changed_keys {
            let _ = store.activated(&state.dir, &id, &reference, &in_use);
        }
        let _ = app.emit("companion-settings", &settings);
        Ok(settings)
    })
    .await
    .map_err(|_| t("host.settingsSave"))?
}
/// 对方语言 picked in the translation bubble (plan/41): only this field
/// changes, so the bubble needs no part of the settings page.
#[tauri::command]
pub fn set_translation_partner(app: AppHandle, target: String) -> Result<(), String> {
    let target = target.trim();
    if target.is_empty() || target.chars().count() > 60 {
        return Err(t("host.settingsSave").into());
    }
    let state = app.state::<Companion>();
    let _change = state.changes.lock().unwrap();
    let mut next = state.settings.lock().unwrap().clone();
    if next.translation_target == target {
        return Ok(());
    }
    next.translation_target = target.into();
    library::write_json(&state.dir.join("settings.json"), &next)?;
    *state.settings.lock().unwrap() = next.clone();
    let _ = app.emit("companion-settings", &next);
    Ok(())
}
#[cfg(test)]
mod configuration_tests {
    use super::*;
    use std::cell::RefCell;
    #[test]
    fn existing_users_stay_in_chinese_and_new_ones_follow_the_system() {
        let old: Settings = serde_json::from_str(r#"{"memory":true}"#).unwrap();
        assert_eq!(old.language, "zh");
        assert_eq!(Settings::default().language, "system");
        let saved = serde_json::to_string(&Settings::default()).unwrap();
        let back: Settings = serde_json::from_str(&saved).unwrap();
        assert_eq!(back.language, "system");
        let mut s = Settings::default();
        s.language = "fr".into();
        assert_eq!(s.validate().unwrap_err(), t("host.languageUnknown"));
    }
    #[test]
    fn failed_activation_and_failed_write_restore_previous_runtime() {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path();
        let original = Settings::default();
        library::write_json(&p.join("settings.json"), &original).unwrap();
        let next = Settings {
            model: "candidate".into(),
            ..Settings::default()
        };
        let calls = RefCell::new(vec![]);
        assert!(commit_configuration(
            p,
            &next,
            || {
                calls.borrow_mut().push("apply");
                Err("auth".into())
            },
            || {
                calls.borrow_mut().push("restore");
                Ok(())
            }
        )
        .is_err());
        assert_eq!(*calls.borrow(), ["apply", "restore"]);
        let saved: Settings =
            serde_json::from_slice(&fs::read(p.join("settings.json")).unwrap()).unwrap();
        assert_eq!(saved.model, original.model);
        calls.borrow_mut().clear();
        assert!(commit_configuration(
            &p.join("missing"),
            &next,
            || {
                calls.borrow_mut().push("apply");
                Ok(())
            },
            || {
                calls.borrow_mut().push("restore");
                Ok(())
            }
        )
        .is_err());
        assert!(calls.borrow().is_empty());
        commit_configuration(p, &next, || Ok(()), || panic!("成功不回滚")).unwrap();
        let saved: Settings =
            serde_json::from_slice(&fs::read(p.join("settings.json")).unwrap()).unwrap();
        assert_eq!(saved.model, "candidate");
    }
}
