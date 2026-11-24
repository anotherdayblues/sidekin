use crate::locale::t;
use crate::{
    brain,
    companion::{Companion, Settings},
    credentials::{self, Store},
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::Path,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager, WebviewWindow};
type R<T> = Result<T, String>;
struct Checked {
    tool_status: String,
    draft: Draft,
    reference: String,
    until: Instant,
}
#[derive(Default)]
pub struct Checks {
    items: HashMap<String, Checked>,
}
fn studio(window: &WebviewWindow) -> R<()> {
    if window.label() != "studio" {
        Err(t("host.modelInMain").into())
    } else {
        Ok(())
    }
}
fn state_view(state: &Companion, draft: Draft) -> R<Value> {
    let draft = draft.normalized(false)?;
    let reference = draft.reference(state)?;
    let key = draft.key(state, &reference)?;
    let active = state.settings.lock().unwrap();
    let using = Draft::from_settings(&active)
        .normalized(false)
        .ok()
        .as_ref()
        == Some(&draft)
        && active.credential_ref == reference
        && active.enabled;
    Ok(
        json!({"draft":draft,"hasKey":!key.is_empty(),"canClear":!key.is_empty() || Store::default().can_clear(&state.dir,&draft.binding())?,"revision":reference,"active":using}),
    )
}
fn run_probe(dir: &Path, draft: &Draft, key: &str, method: &str) -> R<Value> {
    let mut config = serde_json::to_value(draft).unwrap();
    config["apiKey"] = key.into();
    probe_config(dir, config, method)
}
pub(crate) fn probe_config(dir: &Path, config: Value, method: &str) -> R<Value> {
    probe_with_params(dir, config, method, json!({}))
}
pub(crate) fn probe_with_params(
    dir: &Path,
    config: Value,
    method: &str,
    params: Value,
) -> R<Value> {
    let exe = std::env::current_exe()
        .map_err(|_| t("host.noBrain"))?
        .with_file_name(format!("companion-brain{}", std::env::consts::EXE_SUFFIX));
    // A short-lived probe never reconfigures the active companion or uses backups.
    let probe =
        brain::Supervisor::watch(exe, vec![], config, dir.join("logs"), Arc::new(|_, _| {}));
    probe.client.call(method, params)
}

#[tauri::command]
pub async fn model_setup_view(
    app: AppHandle,
    window: WebviewWindow,
    service: Option<String>,
    draft: Option<Draft>,
) -> R<Value> {
    studio(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Companion>();
        let _guard = state.changes.lock().unwrap();
        let active = state.settings.lock().unwrap().clone();
        let draft = if let Some(d) = draft {
            d
        } else {
            let service = service.unwrap_or_else(|| active.service.clone());
            let info = service_info(&service)?;
            if let Some(saved) = Store::default().draft(&state.dir, &service)? {
                let draft: Draft = serde_json::from_value(saved).map_err(|_| t("host.savedBad"))?;
                let current = Draft::from_settings(&active);
                if current.service == draft.service
                    && credentials::endpoint(&current.base_url).ok().as_deref()
                        == Some(draft.base_url.as_str())
                    && Store::default()
                        .pending(&state.dir, &draft.binding())?
                        .as_deref()
                        == Some(active.credential_ref.as_str())
                {
                    current
                } else {
                    draft
                }
            } else if service == active.service {
                Draft::from_settings(&active)
            } else {
                Draft {
                    service,
                    base_url: info["baseUrl"].as_str().unwrap().into(),
                    model: String::new(),
                    vision_model: String::new(),
                    can_see: false,
                    context_window: 32768,
                    protocol: info["protocol"].as_str().unwrap().into(),
                }
            }
        };
        if draft.base_url.is_empty() {
            return Ok(json!({"draft":draft,"hasKey":false,"revision":"","active":false}));
        }
        state_view(&state, draft)
    })
    .await
    .map_err(|_| t("host.modelRead"))?
}
#[tauri::command]
pub async fn model_setup_save_key(
    app: AppHandle,
    window: WebviewWindow,
    draft: Draft,
    key: String,
) -> R<Value> {
    studio(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let draft = draft.normalized(false)?;
        let state = app.state::<Companion>();
        let _guard = state.changes.lock().unwrap();
        Store::default().save(
            &state.dir,
            &draft.binding(),
            &key,
            serde_json::to_value(&draft).unwrap(),
            &state.settings.lock().unwrap().credential_accounts()?,
        )?;
        state_view(&state, draft)
    })
    .await
    .map_err(|_| t("host.keySaveShort"))?
}
#[tauri::command]
pub async fn model_setup_clear_key(
    app: AppHandle,
    window: WebviewWindow,
    draft: Draft,
    revision: String,
) -> R<Value> {
    studio(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let draft = draft.normalized(false)?;
        let state = app.state::<Companion>();
        let _guard = state.changes.lock().unwrap();
        if draft.reference(&state)? != revision {
            return Err(t("host.keyChangedClear").into());
        }
        let legacy = draft.legacy_binding(&state);
        let old = state.settings.lock().unwrap().clone();
        let mut next = old.clone();
        let primary = next.service == draft.service
            && credentials::endpoint(&next.base_url).ok().as_deref()
                == Some(draft.base_url.as_str());
        let previous = next.fallbacks.len();
        next.fallbacks
            .retain(|b| credentials::binding(&b.service, &b.base_url) != draft.binding());
        if primary {
            next.enabled = false;
            next.model_verified = false;
            next.credential_ref = "none".into();
        }
        if primary || previous != next.fallbacks.len() {
            let old_key = if old.enabled {
                Store::default().key(
                    &credentials::binding(&old.service, &old.base_url),
                    &old.credential_ref,
                )?
            } else {
                String::new()
            };
            let next_key = if next.enabled {
                old_key.clone()
            } else {
                String::new()
            };
            crate::companion::commit_configuration(
                &state.dir,
                &next,
                || state.sync(&app, &next, next_key),
                || state.sync(&app, &old, old_key),
            )?;
            *state.settings.lock().unwrap() = next.clone();
            let _ = app.emit("companion-settings", &next);
        }
        Store::default().clear(&state.dir, &draft.binding())?;
        if let Some(id) = legacy.filter(|id| *id != draft.binding()) {
            Store::default().clear(&state.dir, &id)?;
        }
        state_view(&state, draft)
    })
    .await
    .map_err(|_| t("host.keyClearShort"))?
}
fn prepared(
    state: &Companion,
    draft: Draft,
    revision: &str,
    require_model: bool,
) -> R<(Draft, String, String)> {
    let d = draft.normalized(require_model)?;
    let reference = d.reference(state)?;
    if reference != revision {
        return Err(t("host.endpointChanged").into());
    }
    let key = d.key(state, &reference)?;
    if service_info(&d.service)?["keyRequired"] == true && key.is_empty() {
        return Err("missingKey".into());
    }
    Ok((d, reference, key))
}
#[tauri::command]
pub async fn model_setup_models(
    app: AppHandle,
    window: WebviewWindow,
    draft: Draft,
    revision: String,
) -> R<Value> {
    studio(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Companion>();
        let (d, _, key) = {
            let _guard = state.changes.lock().unwrap();
            prepared(&state, draft, &revision, false)?
        };
        run_probe(&state.dir, &d, &key, "models")
    })
    .await
    .map_err(|_| t("host.listRead"))?
}
#[tauri::command]
pub async fn model_setup_test(
    app: AppHandle,
    window: WebviewWindow,
    draft: Draft,
    revision: String,
) -> R<Value> {
    studio(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Companion>();
        let (d, r, key) = {
            let _guard = state.changes.lock().unwrap();
            prepared(&state, draft, &revision, true)?
        };
        let result = run_probe(&state.dir, &d, &key, "test")?;
        let tool_status = match run_probe(&state.dir, &d, &key, "test_tools") {
            Ok(v) => v["toolStatus"].as_str().unwrap_or("unknown").to_owned(),
            Err(e) if e == "unsupportedTools" => "no".into(),
            Err(_) => "unknown".into(),
        };
        let _guard = state.changes.lock().unwrap();
        if d.reference(&state)? != r {
            return Err(t("host.keyChangedTest").into());
        }
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let token = format!(
            "{}-{}",
            crate::chat::now(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        );
        let mut checks = state.checks.lock().unwrap();
        checks.items.retain(|_, c| c.until > Instant::now());
        checks.items.insert(
            token.clone(),
            Checked {
                tool_status: tool_status.clone(),
                draft: d,
                reference: r,
                until: Instant::now() + Duration::from_secs(60),
            },
        );
        Ok(json!({
            "ticket": token, "toolStatus":tool_status,
            "firstMs": result["firstMs"],
            "model": result["model"],
            "canSee": result["canSee"],
        }))
    })
    .await
    .map_err(|_| t("host.testFailed"))?
}
#[tauri::command]
pub async fn model_setup_use(app: AppHandle, window: WebviewWindow, ticket: String) -> R<Settings> {
    studio(&window)?;
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Companion>();
        let _guard = state.changes.lock().unwrap();
        let checked = state
            .checks
            .lock()
            .unwrap()
            .items
            .remove(&ticket)
            .filter(|c| c.until > Instant::now())
            .ok_or(t("host.testExpired"))?;
        let (d, mut r, key) = prepared(&state, checked.draft, &checked.reference, true)?;
        if r.is_empty() && !key.is_empty() {
            r = Store::default().save(
                &state.dir,
                &d.binding(),
                &key,
                serde_json::to_value(&d).unwrap(),
                &state.settings.lock().unwrap().credential_accounts()?,
            )?;
        }
        let old = state.settings.lock().unwrap().clone();
        let mut next = old.clone();
        d.install(&mut next, r);
        next.tool_check = json!({"baseUrl": d.base_url, "protocol":d.protocol, "model":d.model,"status":checked.tool_status});
        next.enabled = true;
        next.model_verified = true;
        next.validate()?;
        let store = Store::default();
        store.retain_references(&state.dir, &old.credential_accounts()?)?;
        let old_key = if old.enabled {
            Store::default().key(
                &credentials::binding(&old.service, &old.base_url),
                &old.credential_ref,
            )?
        } else {
            String::new()
        };
        crate::companion::commit_configuration(
            &state.dir,
            &next,
            || state.sync(&app, &next, key),
            || state.sync(&app, &old, old_key),
        )?;
        *state.settings.lock().unwrap() = next.clone();
        let _ = store.activated(
            &state.dir,
            &d.binding(),
            &next.credential_ref,
            &next.credential_accounts()?,
        );
        let _ = app.emit("companion-settings", &next);
        Ok(next)
    })
    .await
    .map_err(|_| t("host.enableFailed"))?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn displayed_service_selects_its_protocol_and_preserves_manual_model() {
        let mut d = Draft::from_settings(&Settings::default());
        d.service = "anthropic".into();
        d.base_url = "https://api.anthropic.com".into();
        d.model = "private-model".into();
        d.protocol = "openai-responses".into();
        let v = d.normalized(true).unwrap();
        assert_eq!(v.protocol, "anthropic-messages");
        assert_eq!(v.model, "private-model");
        let mut bad = v.clone();
        bad.model = "".into();
        assert!(bad.clone().normalized(false).is_ok());
        assert!(bad.normalized(true).is_err());
    }
}

#[path = "model_draft.rs"]
mod draft;
pub use draft::{service_info, Draft};
