//! Unified OS permissions center (macOS 4 items + Windows 2 items).
//!
//! Single source of truth for:
//! - App-level permission opt-in switches persisted in `permissions.json`
//!   (all enabled by default; turning a switch off stops Suiby from probing
//!   or triggering OS prompts for that permission).
//! - Live OS grant inspection where the OS provides a non-prompting preflight
//!   API (macOS Accessibility & Screen Recording).
//! - Opening OS Settings panes without double-opening or duplicate prompts.
use crate::locale::t;
use serde::{Deserialize, Serialize};
use std::{
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicI64, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};

const OPEN_DEBOUNCE_MS: i64 = 1000;

static AX_REGISTERED: AtomicBool = AtomicBool::new(false);
static SCREEN_REGISTERED: AtomicBool = AtomicBool::new(false);
static LAST_OPEN_MS: AtomicI64 = AtomicI64::new(0);

fn default_true() -> bool {
    true
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(default, rename_all = "camelCase")]
pub struct PermissionPrefs {
    #[serde(default = "default_true")]
    pub accessibility: bool,
    #[serde(default = "default_true")]
    pub screen: bool,
    #[serde(default = "default_true")]
    pub app_data: bool,
    #[serde(default = "default_true")]
    pub local_network: bool,
}

impl Default for PermissionPrefs {
    fn default() -> Self {
        Self {
            accessibility: true,
            screen: true,
            app_data: true,
            local_network: true,
        }
    }
}

impl PermissionPrefs {
    pub fn get(&self, kind: &str) -> bool {
        match kind {
            "accessibility" => self.accessibility,
            "screen" => self.screen,
            "appData" => self.app_data,
            "localNetwork" => self.local_network,
            _ => true,
        }
    }

    pub fn set(&mut self, kind: &str, enabled: bool) -> Result<(), String> {
        match kind {
            "accessibility" => self.accessibility = enabled,
            "screen" => self.screen = enabled,
            "appData" => self.app_data = enabled,
            "localNetwork" => self.local_network = enabled,
            _ => return Err(t("host.unknownAction").into()),
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OsStatus {
    pub accessibility: &'static str,
    pub screen: &'static str,
    pub app_data: &'static str,
    pub local_network: &'static str,
}

#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PermissionSnapshot {
    pub platform: &'static str,
    pub prefs: PermissionPrefs,
    pub os: OsStatus,
}

#[derive(Default)]
pub struct Permissions {
    cache: Mutex<Option<PermissionPrefs>>,
}

fn store_path(app: &AppHandle) -> Option<PathBuf> {
    app.try_state::<crate::companion::Companion>()
        .map(|c| c.dir.join("permissions.json"))
}

fn read_disk(path: &Path) -> PermissionPrefs {
    std::fs::read(path)
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or_default()
}

fn load_prefs(app: &AppHandle) -> PermissionPrefs {
    let Some(state) = app.try_state::<Permissions>() else {
        return store_path(app)
            .map(|p| read_disk(&p))
            .unwrap_or_default();
    };
    let mut guard = state.cache.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(prefs) = guard.as_ref() {
        return prefs.clone();
    }
    let prefs = store_path(app)
        .map(|p| read_disk(&p))
        .unwrap_or_default();
    *guard = Some(prefs.clone());
    prefs
}

pub fn is_enabled(app: &AppHandle, kind: &str) -> bool {
    load_prefs(app).get(kind)
}

pub fn mark_screen_registered() {
    SCREEN_REGISTERED.store(true, Ordering::Relaxed);
}

fn platform_name() -> &'static str {
    if cfg!(target_os = "macos") {
        "mac"
    } else if cfg!(windows) {
        "win"
    } else {
        "other"
    }
}

fn current_os_status() -> OsStatus {
    #[cfg(target_os = "macos")]
    {
        OsStatus {
            accessibility: if crate::selection::selection_access() {
                "granted"
            } else {
                "denied"
            },
            screen: if crate::snip::screen_access() {
                "granted"
            } else {
                "denied"
            },
            // macOS offers no non-prompting preflight API for App Data or Local Network.
            app_data: "on_demand",
            local_network: "on_demand",
        }
    }
    #[cfg(windows)]
    {
        OsStatus {
            accessibility: "not_needed",
            // Windows 11 has no non-prompting preflight API for programmatic screen capture privacy.
            screen: "on_demand",
            app_data: "not_needed",
            local_network: "on_demand",
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        OsStatus {
            accessibility: "not_needed",
            screen: "on_demand",
            app_data: "not_needed",
            local_network: "on_demand",
        }
    }
}

pub fn snapshot(app: &AppHandle) -> PermissionSnapshot {
    PermissionSnapshot {
        platform: platform_name(),
        prefs: load_prefs(app),
        os: current_os_status(),
    }
}

fn should_debounce(last_ms: &AtomicI64, now_ms: i64, window_ms: i64) -> bool {
    let prev = last_ms.load(Ordering::Relaxed);
    if prev > 0 && now_ms.saturating_sub(prev) < window_ms {
        return true;
    }
    last_ms.store(now_ms, Ordering::Relaxed);
    false
}

#[cfg(target_os = "macos")]
fn open_mac_url(url: &str) -> Result<(), String> {
    std::process::Command::new("/usr/bin/open")
        .arg(url)
        .spawn()
        .map_err(|_| t("host.noSystemSettings"))?;
    Ok(())
}

#[cfg(windows)]
fn open_win_uri(uri: &str) -> Result<(), String> {
    std::process::Command::new("explorer.exe")
        .arg(uri)
        .spawn()
        .map_err(|_| t("host.noSystemSettings"))?;
    Ok(())
}

/// Opens the corresponding OS privacy settings pane cleanly without double-opening
/// or popping redundant registration dialogs.
pub fn open_os_settings(kind: &str) -> Result<(), String> {
    if should_debounce(&LAST_OPEN_MS, crate::chat::now(), OPEN_DEBOUNCE_MS) {
        return Ok(());
    }
    #[cfg(target_os = "macos")]
    {
        match kind {
            "accessibility" => {
                // On macOS 27+, AXIsProcessTrustedWithOptions(Prompt: YES) no longer pops
                // the legacy "Open System Settings" dialog for apps without a private
                // low-friction entitlement. Trigger it once to record the request, then
                // open the pane directly (protected by the 1s debounce above).
                if !crate::selection::selection_access()
                    && !AX_REGISTERED.swap(true, Ordering::Relaxed)
                {
                    extern "C" {
                        fn companion_request_access() -> i32;
                    }
                    let _ = unsafe { companion_request_access() };
                }
                open_mac_url(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility",
                )
            }
            "screen" => {
                if !crate::snip::screen_access()
                    && !SCREEN_REGISTERED.swap(true, Ordering::Relaxed)
                {
                    unsafe extern "C" {
                        fn CGRequestScreenCaptureAccess() -> bool;
                    }
                    let _ = unsafe { CGRequestScreenCaptureAccess() };
                }
                open_mac_url(
                    "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
                )
            }
            "appData" => open_mac_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_AppContainer",
            ),
            "localNetwork" => open_mac_url(
                "x-apple.systempreferences:com.apple.preference.security?Privacy_LocalNetwork",
            ),
            _ => Err(t("host.unknownAction").into()),
        }
    }
    #[cfg(windows)]
    {
        match kind {
            "screen" => open_win_uri("ms-settings:privacy-graphicsCaptureProgrammatic"),
            "localNetwork" => open_win_uri("windowsdefender://network"),
            "accessibility" | "appData" => open_win_uri("ms-settings:privacy"),
            _ => Err(t("host.unknownAction").into()),
        }
    }
    #[cfg(not(any(target_os = "macos", windows)))]
    {
        let _ = kind;
        Ok(())
    }
}

#[tauri::command]
pub fn permissions_status(app: AppHandle) -> PermissionSnapshot {
    snapshot(&app)
}

#[tauri::command]
pub fn set_permission_enabled(
    app: AppHandle,
    kind: String,
    enabled: bool,
) -> Result<PermissionSnapshot, String> {
    let mut next = load_prefs(&app);
    next.set(&kind, enabled)?;
    if let Some(path) = store_path(&app) {
        crate::library::write_json(&path, &next)?;
    }
    if let Some(state) = app.try_state::<Permissions>() {
        *state.cache.lock().unwrap_or_else(|e| e.into_inner()) = Some(next);
    }
    let snap = snapshot(&app);
    let _ = app.emit("permissions-changed", &snap);
    Ok(snap)
}

#[tauri::command]
pub fn open_permission_settings(kind: String) -> Result<(), String> {
    open_os_settings(&kind)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefs_default_all_enabled_and_update_individually() {
        let mut prefs = PermissionPrefs::default();
        assert!(prefs.get("accessibility"));
        assert!(prefs.get("screen"));
        assert!(prefs.get("appData"));
        assert!(prefs.get("localNetwork"));

        prefs.set("appData", false).unwrap();
        assert!(!prefs.get("appData"));
        assert!(prefs.get("accessibility"));
        assert!(prefs.set("bogus", false).is_err());
    }

    #[test]
    fn prefs_deserialize_missing_fields_as_true() {
        let parsed: PermissionPrefs =
            serde_json::from_str(r#"{"screen":false}"#).expect("valid partial json");
        assert!(parsed.accessibility);
        assert!(!parsed.screen);
        assert!(parsed.app_data);
        assert!(parsed.local_network);
    }

    #[test]
    fn debounce_suppresses_rapid_duplicate_opens() {
        let slot = AtomicI64::new(0);
        assert!(!should_debounce(&slot, 10_000, OPEN_DEBOUNCE_MS));
        assert!(should_debounce(&slot, 10_400, OPEN_DEBOUNCE_MS));
        assert!(should_debounce(&slot, 10_999, OPEN_DEBOUNCE_MS));
        assert!(!should_debounce(&slot, 11_000, OPEN_DEBOUNCE_MS));
    }
}
