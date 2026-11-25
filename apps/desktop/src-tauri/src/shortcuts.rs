use crate::locale::t;
use crate::{chat, companion::Settings};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Manager};
use tauri_plugin_global_shortcut::{GlobalShortcutExt, Shortcut, ShortcutState};
/// The default shortcuts, the same in every build: chat bubble is opened by
/// clicking the pet (optional custom shortcut), and the four global tools sit
/// on Control+Shift+1..4 (⌃⇧1..4 on Mac, Ctrl+Shift+1..4 on Windows) so they
/// stay clear of Codex, Cursor, Claude, Raycast, and OS/IME chords.
pub const CHAT: &str = "";
pub const PANEL: &str = "Control+Shift+1";
pub const CLIPBOARD: &str = "Control+Shift+2";
pub const TRANSLATE: &str = "Control+Shift+3";
pub const VISION: &str = "Control+Shift+4";
pub const CHAT_SNIP: &str = "";
/// Earlier builds gave each build its own modifiers (the full app ⌃⌥, the
/// trial ⌃⌥⇧, the dev build ⌃⌥⇧⌘), and plan/38 moved them to Alt+Space /
/// Alt+Shift+*. A shortcut still at any earlier default was never chosen, so
/// it moves to today's; one the user picked stays. True when something changed.
pub fn refresh_defaults(s: &mut Settings) -> bool {
    let mut changed = false;
    let legacy_prefixes = [
        "Control+Alt+",
        "Control+Alt+Shift+",
        "Control+Alt+Shift+Super+",
    ];
    for (field, old_key, prev_defaults, new) in [
        (&mut s.chat_shortcut, "Space", &["Alt+Space"][..], CHAT),
        (
            &mut s.panel_shortcut,
            "C",
            &["Alt+Shift+Space"][..],
            PANEL,
        ),
        (
            &mut s.vision_shortcut,
            "S",
            &["Shift+Super+2", "Alt+Shift+S"][..],
            VISION,
        ),
        (
            &mut s.translation_shortcut,
            "T",
            &["", "Alt+Shift+T"][..],
            TRANSLATE,
        ),
        (
            &mut s.clipboard_shortcut,
            "",
            &["", "Alt+Shift+V"][..],
            CLIPBOARD,
        ),
    ] {
        if *field == new {
            continue;
        }
        let is_legacy = (!old_key.is_empty()
            && legacy_prefixes
                .iter()
                .any(|p| *field == format!("{p}{old_key}")))
            || prev_defaults.contains(&field.as_str());
        if is_legacy {
            *field = new.into();
            changed = true;
        }
    }
    changed
}
#[derive(Default)]
pub struct Bindings {
    map: Mutex<HashMap<Shortcut, &'static str>>,
    /// Set while a shortcut field records keys, so the keys pressed there do
    /// not fire the app's own shortcuts.
    paused: AtomicBool,
}
impl Bindings {
    fn pause(&self) {
        self.paused.store(true, Ordering::Release);
    }
    /// True once for each pause: the caller then registers the settings.
    fn end_pause(&self) -> bool {
        self.paused.swap(false, Ordering::AcqRel)
    }
    fn registers_now(&self) -> bool {
        !self.paused.load(Ordering::Acquire)
    }
}
fn desired(s: &Settings) -> Result<HashMap<Shortcut, &'static str>, String> {
    let mut desired = HashMap::new();
    if s.enabled {
        if !s.chat_shortcut.trim().is_empty() {
            desired.insert(
                s.chat_shortcut
                    .parse::<Shortcut>()
                    .map_err(|_| t("host.chatKeyBad"))?,
                "chat",
            );
        }
        let panel = s
            .panel_shortcut
            .parse::<Shortcut>()
            .map_err(|_| t("host.panelKeyBad"))?;
        if desired.insert(panel, "panel").is_some() {
            return Err(t("host.keysSame").into());
        }
        if s.vision {
            let key = s
                .vision_shortcut
                .parse::<Shortcut>()
                .map_err(|_| t("host.snipKeyBad"))?;
            if desired.insert(key, "vision").is_some() {
                return Err(t("host.keysSame").into());
            }
            if !s.chat_snip_shortcut.trim().is_empty() {
                let chat_snip = s
                    .chat_snip_shortcut
                    .parse::<Shortcut>()
                    .map_err(|_| t("host.snipKeyBad"))?;
                if desired.insert(chat_snip, "chat-snip").is_some() {
                    return Err(t("host.keysSame").into());
                }
            }
        }
        if s.translation {
            let key = s
                .translation_shortcut
                .parse::<Shortcut>()
                .map_err(|_| t("host.translateKeyBad"))?;
            if desired.insert(key, "translate").is_some() {
                return Err(t("host.keysSame").into());
            }
        }
    }
    let clip = s
        .clipboard_shortcut
        .parse::<Shortcut>()
        .map_err(|_| t("clip.badKey"))?;
    if desired.insert(clip, "clipboard").is_some() {
        return Err(t("host.keysSame").into());
    }
    Ok(desired)
}
/// Registers the settings' shortcuts. While recording is paused the settings
/// are only checked: resuming registers whatever is saved by then, so a save
/// and a resume give the same result in either order.
pub fn apply(app: &AppHandle, s: &Settings) -> Result<(), String> {
    let mut desired = desired(s)?;
    if cfg!(feature = "acceptance") {
        return Ok(());
    } // QA drives the same handlers without owning global shortcuts.
    let state = app.state::<Bindings>();
    if !state.registers_now() {
        return Ok(());
    }
    let registry = app.global_shortcut();
    let mut old = state.map.lock().unwrap();
    let mut added = Vec::new();
    let mut unavailable_default = None;
    for key in desired.keys().filter(|k| !old.contains_key(k)) {
        if registry
            .on_shortcut(*key, |app, key, event| {
                if event.state != ShortcutState::Pressed {
                    return;
                }
                let action = app
                    .state::<Bindings>()
                    .map
                    .try_lock()
                    .ok()
                    .and_then(|map| map.get(key).copied());
                if action == Some("clipboard") {
                    crate::tips::used(app, "clipboard");
                    let _ = crate::clipboard::toggle(app);
                } else if action == Some("chat") {
                    crate::tips::used(app, "chat-shortcut");
                    let _ = chat::open_chat(app.clone(), None);
                } else if action == Some("panel") {
                    crate::tips::used(app, "panel");
                    let _ = crate::chat_window::toggle(app);
                } else if action == Some("vision") {
                    crate::snip::start(app.clone());
                } else if action == Some("chat-snip") {
                    crate::snip::start_for_chat_from_shortcut(app.clone());
                } else if action == Some("translate") {
                    crate::selection::translate_shortcut(app.clone());
                }
            })
            .is_err()
        {
            if desired.get(key) == Some(&"clipboard") && s.clipboard_shortcut == CLIPBOARD {
                unavailable_default = Some(*key);
                continue;
            }
            for k in added {
                let _ = registry.unregister(k);
            }
            return Err(t("host.keyTaken").into());
        }
        added.push(*key);
    }
    for key in old.keys().filter(|k| !desired.contains_key(k)) {
        registry
            .unregister(*key)
            .map_err(|_| t("host.keyRelease"))?;
    }
    if let Some(key) = unavailable_default {
        desired.remove(&key);
    }
    *old = desired;
    Ok(())
}

#[tauri::command]
pub fn pause_shortcuts(app: AppHandle, paused: bool) -> Result<(), String> {
    if cfg!(feature = "acceptance") {
        return Ok(());
    }
    if paused {
        let state = app.state::<Bindings>();
        state.pause();
        let registry = app.global_shortcut();
        let mut old = state.map.lock().unwrap();
        for key in old.keys() {
            let _ = registry.unregister(*key);
        }
        old.clear();
        Ok(())
    } else {
        resume(&app)
    }
}

/// Ends a pause, if there is one, with the settings saved by now. Also run
/// when the settings window loses focus or closes, in case the field never
/// heard its own blur.
pub fn resume(app: &AppHandle) -> Result<(), String> {
    if !app.state::<Bindings>().end_pause() {
        return Ok(());
    }
    let s = app
        .state::<crate::companion::Companion>()
        .settings
        .lock()
        .unwrap()
        .clone();
    apply(app, &s)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn disabled_and_colliding_shortcuts() {
        let mut s = Settings::default();
        assert_eq!(
            desired(&s).unwrap().values().copied().collect::<Vec<_>>(),
            vec!["clipboard"]
        );
        s.enabled = true;
        // Side panel, clipboard, snip and translation; chat is optional and blank by default.
        assert_eq!(desired(&s).unwrap().len(), 4);
        s.chat_shortcut = "Super+Shift+K".into();
        assert_eq!(desired(&s).unwrap().len(), 5);
        s.chat_snip_shortcut = "Super+Shift+A".into();
        assert_eq!(desired(&s).unwrap().len(), 6);
        s.vision = false;
        assert_eq!(desired(&s).unwrap().len(), 4);
        s.vision = true;
        s.chat_snip_shortcut = s.vision_shortcut.clone();
        assert!(desired(&s).is_err());
        s.chat_snip_shortcut.clear();
        s.panel_shortcut = s.chat_shortcut.clone();
        assert!(desired(&s).is_err());
    }
    #[test]
    fn defaults_are_short_and_parse() {
        let s = Settings::default();
        assert_eq!(s.chat_shortcut, "");
        assert_eq!(s.panel_shortcut, "Control+Shift+1");
        assert_eq!(s.clipboard_shortcut, "Control+Shift+2");
        assert_eq!(s.translation_shortcut, "Control+Shift+3");
        assert_eq!(s.vision_shortcut, "Control+Shift+4");
        for key in [
            &s.panel_shortcut,
            &s.clipboard_shortcut,
            &s.translation_shortcut,
            &s.vision_shortcut,
        ] {
            assert!(key.parse::<Shortcut>().is_ok(), "{key}");
        }
    }
    #[test]
    fn old_defaults_of_every_build_become_the_new_ones() {
        let new = Settings::default();
        for old in [
            "Control+Alt+",
            "Control+Alt+Shift+",
            "Control+Alt+Shift+Super+",
        ] {
            let mut s = Settings {
                chat_shortcut: format!("{old}Space"),
                panel_shortcut: format!("{old}C"),
                vision_shortcut: format!("{old}S"),
                ..Settings::default()
            };
            assert!(refresh_defaults(&mut s), "{old}");
            assert_eq!(s.chat_shortcut, new.chat_shortcut);
            assert_eq!(s.panel_shortcut, new.panel_shortcut);
            assert_eq!(s.vision_shortcut, new.vision_shortcut);
        }
        // plan/38 and plan/41 defaults also migrate cleanly.
        let mut prev = Settings {
            chat_shortcut: "Alt+Space".into(),
            panel_shortcut: "Alt+Shift+Space".into(),
            clipboard_shortcut: "Alt+Shift+V".into(),
            translation_shortcut: "Alt+Shift+T".into(),
            vision_shortcut: "Shift+Super+2".into(),
            ..Settings::default()
        };
        assert!(refresh_defaults(&mut prev));
        assert_eq!(prev.chat_shortcut, new.chat_shortcut);
        assert_eq!(prev.panel_shortcut, new.panel_shortcut);
        assert_eq!(prev.clipboard_shortcut, new.clipboard_shortcut);
        assert_eq!(prev.translation_shortcut, new.translation_shortcut);
        assert_eq!(prev.vision_shortcut, new.vision_shortcut);
        assert!(!refresh_defaults(&mut prev));
    }
    #[test]
    fn a_shortcut_the_user_chose_stays() {
        let mut s = Settings {
            chat_shortcut: "Super+Shift+K".into(),
            // An old default under another name: chosen, not given.
            panel_shortcut: "Control+Alt+Space".into(),
            vision_shortcut: "Control+Alt+S".into(),
            clipboard_shortcut: "Super+Shift+V".into(),
            ..Settings::default()
        };
        assert!(refresh_defaults(&mut s));
        assert_eq!(s.chat_shortcut, "Super+Shift+K");
        assert_eq!(s.panel_shortcut, "Control+Alt+Space");
        assert_eq!(s.vision_shortcut, Settings::default().vision_shortcut);
        assert_eq!(s.clipboard_shortcut, "Super+Shift+V");
        assert!(!refresh_defaults(&mut s), "nothing left to change");
    }
    #[test]
    fn translation_gets_its_shortcut_unless_one_was_chosen() {
        // Older files: the field missing (read as empty) or an old default.
        for old in ["", "Control+Alt+T", "Control+Alt+Shift+Super+T", "Alt+Shift+T"] {
            let mut s = Settings {
                translation_shortcut: old.into(),
                ..Settings::default()
            };
            assert!(refresh_defaults(&mut s), "{old:?}");
            assert_eq!(s.translation_shortcut, TRANSLATE);
        }
        let mut s = Settings {
            translation_shortcut: "Super+Shift+Y".into(),
            ..Settings::default()
        };
        assert!(!refresh_defaults(&mut s));
        assert_eq!(s.translation_shortcut, "Super+Shift+Y");
        // Registered only while translation is on, and never on another key.
        let on = Settings {
            enabled: true,
            ..Settings::default()
        };
        assert!(desired(&on).unwrap().values().any(|a| *a == "translate"));
        let off = Settings {
            translation: false,
            ..on.clone()
        };
        assert!(!desired(&off).unwrap().values().any(|a| *a == "translate"));
        let same = Settings {
            translation_shortcut: on.panel_shortcut.clone(),
            ..on.clone()
        };
        assert!(desired(&same).is_err());
    }
    #[test]
    fn a_save_while_recording_waits_for_the_one_resume() {
        let b = Bindings::default();
        assert!(b.registers_now());
        assert!(!b.end_pause(), "nothing to resume");
        b.pause();
        assert!(!b.registers_now(), "a save now only checks the settings");
        assert!(b.end_pause(), "resume registers what is saved by then");
        assert!(b.registers_now());
        assert!(!b.end_pause(), "blur and window close resume only once");
    }
}
