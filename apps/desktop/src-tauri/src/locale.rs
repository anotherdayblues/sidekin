// The language Suiby shows to the user, driven by apps/shared/locales/registry.json.
// Text meant for the model keeps the Chinese core prompt verbatim (plan/15).

use serde::Deserialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::OnceLock;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Registry {
    default: String,
    system_fallback: String,
    locales: Vec<LocaleEntry>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct LocaleEntry {
    id: String,
    html_lang: String,
    date_locale: String,
    match_tags: Vec<String>,
    fallback: Vec<String>,
}

static CURRENT: AtomicUsize = AtomicUsize::new(0);

fn registry() -> &'static Registry {
    static REG: OnceLock<Registry> = OnceLock::new();
    REG.get_or_init(|| {
        serde_json::from_str(include_str!("../../../shared/locales/registry.json"))
            .expect("valid apps/shared/locales/registry.json")
    })
}

fn raw_table(id: &str) -> Option<&'static str> {
    match id {
        "zh" => Some(include_str!("../../../shared/locales/zh.json")),
        "en" => Some(include_str!("../../../shared/locales/en.json")),
        "zh-TW" => Some(include_str!("../../../shared/locales/zh-TW.json")),
        "ja" => Some(include_str!("../../../shared/locales/ja.json")),
        "ko" => Some(include_str!("../../../shared/locales/ko.json")),
        _ => None,
    }
}

fn tables() -> &'static Vec<HashMap<String, String>> {
    static TABLES: OnceLock<Vec<HashMap<String, String>>> = OnceLock::new();
    TABLES.get_or_init(|| {
        registry()
            .locales
            .iter()
            .map(|entry| {
                let raw = raw_table(&entry.id)
                    .unwrap_or_else(|| panic!("missing embedded locale table for {}", entry.id));
                serde_json::from_str(raw)
                    .unwrap_or_else(|e| panic!("invalid locale JSON for {}: {e}", entry.id))
            })
            .collect()
    })
}

fn index_of_in(reg: &Registry, id: &str) -> Option<usize> {
    reg.locales.iter().position(|l| l.id == id)
}

fn default_index_in(reg: &Registry) -> usize {
    index_of_in(reg, &reg.default).unwrap_or(0)
}

fn entry_at(idx: usize) -> &'static LocaleEntry {
    let reg = registry();
    reg.locales
        .get(idx)
        .unwrap_or_else(|| &reg.locales[default_index_in(reg)])
}

/// From now on, text for the user follows this setting ("system" or any registered locale id).
pub fn set(choice: &str) {
    let id = resolve(choice);
    let reg = registry();
    let idx = index_of_in(reg, id).unwrap_or_else(|| default_index_in(reg));
    CURRENT.store(idx, Ordering::Relaxed);
}

/// Whether `choice` is "system" or a registered locale id.
pub fn is_valid_choice(choice: &str) -> bool {
    choice == "system" || index_of_in(registry(), choice).is_some()
}

/// Active locale id (e.g. "zh", "en").
pub fn current() -> &'static str {
    &entry_at(CURRENT.load(Ordering::Relaxed)).id
}

/// BCP-47 `lang` attribute for HTML documents (e.g. "zh-CN", "en").
pub fn html_lang() -> &'static str {
    &entry_at(CURRENT.load(Ordering::Relaxed)).html_lang
}

/// Locale tag for Intl date/number formatting (e.g. "zh-CN", "en-US").
pub fn date_locale() -> &'static str {
    &entry_at(CURRENT.load(Ordering::Relaxed)).date_locale
}

/// Ordered lookup fallback chain for a locale id, always terminating at the registry default.
pub fn fallback_chain(id: &str) -> Vec<&'static str> {
    let reg = registry();
    let entry = index_of_in(reg, id)
        .map(|i| &reg.locales[i])
        .unwrap_or_else(|| &reg.locales[default_index_in(reg)]);
    let mut chain = Vec::with_capacity(entry.fallback.len() + 1);
    for fb in &entry.fallback {
        if !chain.contains(&fb.as_str()) {
            chain.push(fb.as_str());
        }
    }
    if !chain.contains(&reg.default.as_str()) {
        chain.push(reg.default.as_str());
    }
    chain
}

fn lookup_in(id: &str, key: &str) -> Option<&'static str> {
    let reg = registry();
    let all = tables();
    for fb in fallback_chain(id) {
        if let Some(idx) = index_of_in(reg, fb) {
            if let Some(val) = all[idx].get(key) {
                return Some(val.as_str());
            }
        }
    }
    None
}

/// The user's text for `key` in a specific locale, walking its fallback chain.
pub fn t_in(locale_id: &str, key: &str) -> String {
    lookup_in(locale_id, key)
        .map(str::to_owned)
        .unwrap_or_else(|| key.to_string())
}

/// The user's text for `key` in apps/shared/locales, walking the active locale's fallback chain.
pub fn t(key: &str) -> String {
    t_in(current(), key)
}

/// Every text whose key starts with `prefix`, for a page served outside the
/// app (the phone page of 手机传文件).
pub fn starting_with(prefix: &str) -> serde_json::Map<String, serde_json::Value> {
    let def_idx = default_index_in(registry());
    tables()[def_idx]
        .keys()
        .filter(|k| k.starts_with(prefix))
        .map(|k| (k.clone(), serde_json::Value::String(t(k))))
        .collect()
}

/// t_in() with `{name}` replaced by the matching value.
pub fn tf_in(locale_id: &str, key: &str, vars: &[(&str, &dyn std::fmt::Display)]) -> String {
    let mut text = t_in(locale_id, key);
    for (name, value) in vars {
        text = text.replace(&format!("{{{name}}}"), &value.to_string());
    }
    text
}

/// t() with `{name}` replaced by the matching value.
pub fn tf(key: &str, vars: &[(&str, &dyn std::fmt::Display)]) -> String {
    tf_in(current(), key, vars)
}

/// The user's choice, or the first matching preferred OS language when left to "system".
pub fn resolve(choice: &str) -> &'static str {
    let reg = registry();
    if choice != "system" {
        if let Some(idx) = index_of_in(reg, choice) {
            return &reg.locales[idx].id;
        }
    }
    match_tags_in(reg, &system_tags())
}

fn normalize_tag(tag: &str) -> String {
    let trimmed = tag.trim();
    let head = trimmed.split(['.', '@']).next().unwrap_or("");
    head.replace('_', "-").to_ascii_lowercase()
}

fn match_single_tag_in<'a>(reg: &'a Registry, raw_tag: &str) -> Option<&'a str> {
    let normalized = normalize_tag(raw_tag);
    if normalized.is_empty() {
        return None;
    }
    let mut best: Option<(&'a str, usize)> = None;
    for locale in &reg.locales {
        for pattern in &locale.match_tags {
            let p = normalize_tag(pattern);
            if p.is_empty() {
                continue;
            }
            let matches = normalized == p
                || (normalized.starts_with(&p)
                    && normalized.as_bytes().get(p.len()) == Some(&b'-'));
            if matches && best.is_none_or(|(_, len)| p.len() > len) {
                best = Some((locale.id.as_str(), p.len()));
            }
        }
    }
    best.map(|(id, _)| id)
}

fn match_tags_in<'a>(reg: &'a Registry, tags: &[String]) -> &'a str {
    for tag in tags {
        if let Some(matched) = match_single_tag_in(reg, tag) {
            return matched;
        }
    }
    index_of_in(reg, &reg.system_fallback)
        .map(|i| reg.locales[i].id.as_str())
        .unwrap_or_else(|| reg.locales[default_index_in(reg)].id.as_str())
}

#[cfg(target_os = "macos")]
fn system_tags() -> Vec<String> {
    extern "C" {
        fn companion_preferred_language(out: *mut std::ffi::c_char, len: usize);
    }
    let mut buf = [0 as std::ffi::c_char; 512];
    // SAFETY: the native side writes at most `len` bytes, NUL included.
    let joined = unsafe {
        companion_preferred_language(buf.as_mut_ptr(), buf.len());
        std::ffi::CStr::from_ptr(buf.as_ptr())
    }
    .to_string_lossy()
    .into_owned();
    joined
        .split(',')
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .map(str::to_owned)
        .collect()
}

#[cfg(windows)]
fn system_tags() -> Vec<String> {
    let mut buf = [0u16; 85];
    // SAFETY: writes at most buf.len() UTF-16 code units, NUL-terminated.
    let len = unsafe {
        windows_sys::Win32::Globalization::GetUserDefaultLocaleName(
            buf.as_mut_ptr(),
            buf.len() as i32,
        )
    };
    if len > 1 {
        let name = String::from_utf16_lossy(&buf[..(len as usize - 1)]);
        if !name.is_empty() {
            return vec![name];
        }
    }
    // SAFETY: takes no arguments and only reads the user's profile.
    let id = unsafe { windows_sys::Win32::Globalization::GetUserDefaultUILanguage() };
    let tag = match id & 0x3ff {
        0x04 => match id >> 10 {
            0x01 | 0x03 | 0x05 => "zh-TW",
            _ => "zh-CN",
        },
        0x11 => "ja-JP",
        0x12 => "ko-KR",
        _ => "en-US",
    };
    vec![tag.into()]
}

// Cloud development on Linux.
#[cfg(not(any(target_os = "macos", windows)))]
fn system_tags() -> Vec<String> {
    if let Ok(langs) = std::env::var("LANGUAGE") {
        let list: Vec<String> = langs
            .split(':')
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .collect();
        if !list.is_empty() {
            return list;
        }
    }
    ["LC_ALL", "LC_MESSAGES", "LANG"]
        .iter()
        .filter_map(|k| std::env::var(k).ok())
        .filter(|v| !v.is_empty())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn from_tag(tag: &str) -> &'static str {
        match_tags_in(registry(), &[tag.to_string()])
    }

    #[test]
    fn chinese_tags_are_chinese_and_everything_else_is_english() {
        for tag in ["zh-Hans-CN", "zh_CN.UTF-8", "ZH"] {
            assert_eq!(from_tag(tag), "zh", "{tag}");
        }
        for tag in ["zh-Hant-TW", "zh-TW", "zh-HK"] {
            assert_eq!(from_tag(tag), "zh-TW", "{tag}");
        }
        for tag in ["ja-JP", "ja"] {
            assert_eq!(from_tag(tag), "ja", "{tag}");
        }
        for tag in ["ko-KR", "ko"] {
            assert_eq!(from_tag(tag), "ko", "{tag}");
        }
        for tag in ["en-US", "fr", "", "C.UTF-8"] {
            assert_eq!(from_tag(tag), "en", "{tag}");
        }
        assert_eq!(resolve("zh"), "zh");
        assert_eq!(resolve("en"), "en");
        assert_eq!(resolve("zh-TW"), "zh-TW");
        assert_eq!(resolve("ja"), "ja");
        assert_eq!(resolve("ko"), "ko");
        assert!(is_valid_choice("system"));
        assert!(is_valid_choice("zh"));
        assert!(is_valid_choice("en"));
        assert!(is_valid_choice("zh-TW"));
        assert!(is_valid_choice("ja"));
        assert!(is_valid_choice("ko"));
        assert!(!is_valid_choice("fr"));
    }

    #[test]
    fn longest_prefix_and_preference_order_work_for_future_locales() {
        let mock = Registry {
            default: "zh".into(),
            system_fallback: "en".into(),
            locales: vec![
                LocaleEntry {
                    id: "zh".into(),
                    html_lang: "zh-CN".into(),
                    date_locale: "zh-CN".into(),
                    match_tags: vec!["zh".into()],
                    fallback: vec!["zh".into()],
                },
                LocaleEntry {
                    id: "en".into(),
                    html_lang: "en".into(),
                    date_locale: "en-US".into(),
                    match_tags: vec!["en".into()],
                    fallback: vec!["en".into(), "zh".into()],
                },
                LocaleEntry {
                    id: "zh-TW".into(),
                    html_lang: "zh-Hant-TW".into(),
                    date_locale: "zh-TW".into(),
                    match_tags: vec!["zh-hant".into(), "zh-tw".into(), "zh-hk".into()],
                    fallback: vec!["zh-TW".into(), "zh".into(), "en".into()],
                },
                LocaleEntry {
                    id: "ja".into(),
                    html_lang: "ja".into(),
                    date_locale: "ja-JP".into(),
                    match_tags: vec!["ja".into()],
                    fallback: vec!["ja".into(), "en".into(), "zh".into()],
                },
            ],
        };
        assert_eq!(match_tags_in(&mock, &["zh-Hant-TW".into()]), "zh-TW");
        assert_eq!(match_tags_in(&mock, &["zh_TW.UTF-8".into()]), "zh-TW");
        assert_eq!(match_tags_in(&mock, &["zh-Hans-CN".into()]), "zh");
        assert_eq!(
            match_tags_in(&mock, &["fr-FR".into(), "ja-JP".into(), "en-US".into()]),
            "ja"
        );
        assert_eq!(match_tags_in(&mock, &["fr-FR".into()]), "en");
    }

    #[test]
    fn every_key_the_host_uses_is_in_every_registered_table() {
        let src = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("src");
        let used = regex::Regex::new(r#"\b(?:tf?\(|tf?_in\([^,]+,\s*)"([\w.]+)""#).unwrap();
        let all = tables();
        let reg = registry();
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
                        for (idx, locale) in reg.locales.iter().enumerate() {
                            assert!(
                                all[idx].contains_key(&m[1]),
                                "{} {} ({})",
                                path.display(),
                                &m[1],
                                locale.id
                            );
                        }
                    }
                }
            }
        }
        assert!(seen > 0);
        assert_eq!(lookup_in("zh", "app.name"), Some("随伴"));
        assert_eq!(lookup_in("en", "app.name"), Some("Suiby"));
    }
}
