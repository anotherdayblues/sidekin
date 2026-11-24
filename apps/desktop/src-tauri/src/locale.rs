// The language 随伴 shows to the user (plan/15): "zh" or "en". Text meant for
// the model stays in Chinese whatever this says.

use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::OnceLock;

static ENGLISH: AtomicBool = AtomicBool::new(false);

/// From now on, text for the user follows this setting.
pub fn set(choice: &str) {
    ENGLISH.store(resolve(choice) == "en", Ordering::Relaxed);
}

fn table(english: bool) -> &'static HashMap<String, String> {
    static ZH: OnceLock<HashMap<String, String>> = OnceLock::new();
    static EN: OnceLock<HashMap<String, String>> = OnceLock::new();
    let (cell, text) = if english {
        (&EN, include_str!("../../../shared/locales/en.json"))
    } else {
        (&ZH, include_str!("../../../shared/locales/zh.json"))
    };
    cell.get_or_init(|| serde_json::from_str(text).unwrap())
}

/// Whether the user reads English.
pub fn english() -> bool {
    ENGLISH.load(Ordering::Relaxed)
}

/// The user's text for `key` in apps/shared/locales, Chinese when English
/// lacks it. The same tables as the windows' t().
pub fn t(key: &str) -> String {
    let english = ENGLISH.load(Ordering::Relaxed);
    table(english)
        .get(key)
        .or_else(|| table(false).get(key))
        .cloned()
        .unwrap_or_else(|| key.to_string())
}

/// Every text whose key starts with `prefix`, for a page served outside the
/// app (the phone page of 手机传文件).
pub fn starting_with(prefix: &str) -> serde_json::Map<String, serde_json::Value> {
    table(false)
        .keys()
        .filter(|k| k.starts_with(prefix))
        .map(|k| (k.clone(), serde_json::Value::String(t(k))))
        .collect()
}

/// t() with `{name}` replaced by the matching value.
pub fn tf(key: &str, vars: &[(&str, &dyn std::fmt::Display)]) -> String {
    let mut text = t(key);
    for (name, value) in vars {
        text = text.replace(&format!("{{{name}}}"), &value.to_string());
    }
    text
}

/// The setting: "system", "zh" or "en".
pub const CHOICES: [&str; 3] = ["system", "zh", "en"];

/// The user's choice, or the system's first preferred language when they
/// left it to the system. Anything but Chinese is shown in English.
pub fn resolve(choice: &str) -> &'static str {
    match choice {
        "zh" => "zh",
        "en" => "en",
        _ => from_tag(&system()),
    }
}

fn from_tag(tag: &str) -> &'static str {
    if tag.trim().to_ascii_lowercase().starts_with("zh") {
        "zh"
    } else {
        "en"
    }
}

#[cfg(target_os = "macos")]
fn system() -> String {
    extern "C" {
        fn companion_preferred_language(out: *mut std::ffi::c_char, len: usize);
    }
    let mut buf = [0 as std::ffi::c_char; 64];
    // SAFETY: the native side writes at most `len` bytes, NUL included.
    unsafe {
        companion_preferred_language(buf.as_mut_ptr(), buf.len());
        std::ffi::CStr::from_ptr(buf.as_ptr())
    }
    .to_string_lossy()
    .into_owned()
}

#[cfg(windows)]
fn system() -> String {
    // SAFETY: takes no arguments and only reads the user's profile.
    let id = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
    // The low ten bits are the primary language; 0x04 is Chinese.
    if id & 0x3ff == 0x04 { "zh" } else { "en" }.into()
}

// Cloud development on Linux.
#[cfg(not(any(target_os = "macos", windows)))]
fn system() -> String {
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .find(|v| !v.is_empty())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chinese_tags_are_chinese_and_everything_else_is_english() {
        for tag in ["zh-Hans-CN", "zh-Hant-TW", "zh_CN.UTF-8", "ZH"] {
            assert_eq!(from_tag(tag), "zh", "{tag}");
        }
        for tag in ["en-US", "ja-JP", "fr", "", "C.UTF-8"] {
            assert_eq!(from_tag(tag), "en", "{tag}");
        }
        assert_eq!(resolve("zh"), "zh");
        assert_eq!(resolve("en"), "en");
    }
    #[test]
    fn every_key_the_host_uses_is_in_both_tables() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let used = regex::Regex::new(r#"\btf?\("([\w.]+)""#).unwrap();
        let mut stack = vec![src];
        let mut seen = 0;
        while let Some(dir) = stack.pop() {
            for entry in std::fs::read_dir(dir).unwrap().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    stack.push(path);
                } else if path.extension().is_some_and(|e| e == "rs") {
                    let code = std::fs::read_to_string(&path).unwrap();
                    for m in used.captures_iter(&code) {
                        seen += 1;
                        for english in [false, true] {
                            assert!(
                                table(english).contains_key(&m[1]),
                                "{} {}",
                                path.display(),
                                &m[1]
                            );
                        }
                    }
                }
            }
        }
        assert!(seen > 0);
        assert_eq!(table(false)["app.name"], "随伴");
        assert_eq!(table(true)["app.name"], "Sidekin");
    }
}
