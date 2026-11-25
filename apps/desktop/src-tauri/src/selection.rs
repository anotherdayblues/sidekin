use crate::locale::t;
use crate::{chat, companion::Companion};
use serde_json::{json, Value};
use std::{
    ffi::{c_char, CStr, CString},
    sync::{
        atomic::{AtomicU64, Ordering},
        Mutex,
    },
};
use tauri::{AppHandle, Emitter, Manager};

static GENERATION: AtomicU64 = AtomicU64::new(0);
pub(crate) static CLIPBOARD: Mutex<()> = Mutex::new(());
#[cfg(any(windows, target_os = "macos"))]
extern "C" {
    fn companion_previous_target() -> isize;
    fn companion_watch_apps();
    fn companion_selection(target: isize, status: *mut i32) -> *mut c_char;
    fn companion_clipboard_text() -> *mut c_char;
    fn companion_free(text: *mut c_char);
    fn companion_copy(text: *const c_char) -> i32;
    fn companion_replace(target: isize, text: *const c_char) -> i32;
}
#[tauri::command]
pub fn selection_access() -> bool {
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn companion_access() -> i32;
        }
        unsafe { companion_access() != 0 }
    }
    #[cfg(not(target_os = "macos"))]
    {
        true
    }
}
fn source(target: isize) -> Result<(String, &'static str), &'static str> {
    #[cfg(any(windows, target_os = "macos"))]
    {
        let mut status = 0;
        let ptr = unsafe { companion_selection(target, &mut status) };
        let text = if ptr.is_null() {
            String::new()
        } else {
            let result = unsafe { CStr::from_ptr(ptr) }
                .to_string_lossy()
                .into_owned();
            unsafe { companion_free(ptr) };
            result
        };
        match status {
            -1 => Err("permission"),
            -2 => Err("clipboard"),
            1 => Ok((text, "accessibility")),
            2 => Ok((text, "copy")),
            _ => Ok((text, "empty")),
        }
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        let _ = target;
        Err("clipboard")
    }
}
/// True while 随伴 itself is using the clipboard.
pub fn clipboard_busy() -> bool {
    CLIPBOARD.try_lock().is_err()
}
pub fn invalidate() {
    GENERATION.fetch_add(1, Ordering::SeqCst);
}
/// Start noticing which app the user works in, for the pet's menu.
pub fn watch_apps() {
    #[cfg(any(windows, target_os = "macos"))]
    unsafe {
        companion_watch_apps()
    };
}
/// The pet's menu: clicking the pet brought 随伴 forward, so read the
/// selection in the app the user was in just before; with nothing selected,
/// open the translation input bubble ready to type or paste.
#[tauri::command]
pub fn translate_selection_from_menu(app: AppHandle) {
    if !enabled(&app) {
        return;
    }
    crate::tips::used(&app, "menu-translate");
    #[cfg(any(windows, target_os = "macos"))]
    let target = unsafe { companion_previous_target() };
    #[cfg(not(any(windows, target_os = "macos")))]
    let target = 0;
    translate_from(app, target, true);
}

/// Read plain text currently on the system clipboard without writing or
/// mutating clipboard history (used by the paste button in translate boxes).
#[tauri::command]
pub fn read_clipboard_text() -> String {
    let _guard = CLIPBOARD.lock().unwrap();
    #[cfg(any(windows, target_os = "macos"))]
    {
        let ptr = unsafe { companion_clipboard_text() };
        if ptr.is_null() {
            return String::new();
        }
        let text = unsafe { CStr::from_ptr(ptr) }
            .to_string_lossy()
            .into_owned();
        unsafe { companion_free(ptr) };
        text
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        String::new()
    }
}
/// The translation shortcut (plan/41): the selection, as from the menu; with
/// nothing selected, an empty translation bubble to type into.
pub fn translate_shortcut(app: AppHandle) {
    if !enabled(&app) {
        return;
    }
    crate::tips::used(&app, "menu-translate");
    #[cfg(any(windows, target_os = "macos"))]
    let target = unsafe { companion_previous_target() };
    #[cfg(not(any(windows, target_os = "macos")))]
    let target = 0;
    translate_from(app, target, true);
}
/// 输入要翻译的话 in the pet's menu: the translation bubble, ready to type.
#[tauri::command]
pub fn open_translate_input(app: AppHandle) -> Result<(), String> {
    if !enabled(&app) {
        return Err("disabled".into());
    }
    invalidate();
    chat::show(&app, json!({"mode":"translate-input","at":chat::now()}), true)
}
fn translate_from(app: AppHandle, target: isize, empty_types: bool) {
    let at = chat::now();
    let gen = GENERATION.fetch_add(1, Ordering::SeqCst) + 1;
    std::thread::spawn(move || {
        if !enabled(&app) {
            return;
        }
        #[cfg(target_os = "macos")]
        if !crate::permissions::is_enabled(&app, "accessibility") {
            let _ = chat::show(
                &app,
                json!({"mode":"error","reason":"permissionOff","at":at}),
                false,
            );
            return;
        }
        // Capture the foreground identity before presenting the non-activating window.
        if chat::show(
            &app,
            json!({"mode":"selecting","at":at,"generation":gen}),
            false,
        )
        .is_err()
        {
            return;
        }
        let result = {
            let _guard = CLIPBOARD.lock().unwrap();
            if GENERATION.load(Ordering::SeqCst) != gen {
                return;
            }
            let read = source(target);
            // Reading by copy changes the clipboard and puts it back; that
            // is not the user copying twice.
            crate::copy_twice::OWN_WRITE.store(crate::copy_twice::count(), Ordering::SeqCst);
            read
        };
        if GENERATION.load(Ordering::SeqCst) != gen || !enabled(&app) {
            return;
        }
        let intent = match result {
            Ok((text, method)) if !text.trim().is_empty() => {
                crate::brain::log(
                    &app.state::<Companion>().dir.join("logs"),
                    &format!("selection {method}"),
                );
                json!({"mode":"translate","source":text,"at":at,"generation":gen,"target":target})
            }
            Ok(_) if empty_types => {
                let _ = chat::show(&app, json!({"mode":"translate-input","at":at}), true);
                return;
            }
            Ok(_) => {
                let _ = app.emit_to("pet", "companion-motion", json!({"kind":"empty-selection"}));
                json!({"mode":"empty-selection","at":at})
            }
            Err(reason) => json!({"mode":"error","reason":reason,"at":at}),
        };
        let _ = chat::show(&app, intent, false);
    });
}
fn enabled(app: &AppHandle) -> bool {
    let state = app.state::<Companion>();
    let s = state.settings.lock().unwrap();
    s.enabled && s.translation
}
#[tauri::command]
pub async fn translate_selection(
    app: AppHandle,
    text: String,
    token: String,
    action: Option<String>,
    tone: Option<String>,
) -> Result<Value, String> {
    if !enabled(&app) {
        return Err("disabled".into());
    }
    let state = app.state::<Companion>();
    let client = state.client()?;
    let target = state.settings.lock().unwrap().translation_target.clone();
    let dir = state.dir.clone();
    let kind = action.unwrap_or_else(|| "translate".to_owned());
    let record_translation = kind == "translate";
    let _ = app.emit_to("pet", "companion-motion", json!({"kind":"thinking"}));
    let source = text.clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        client.call(
            "translate",
            json!({"text":text,"target":target,"token":token,"action":kind,"tone":tone}),
        )
    })
    .await
    .map_err(|e| e.to_string())?;
    // Kept in 翻译记录, apart from chat; a failed record never fails the translation.
    if record_translation {
        if let Ok(v) = result.as_ref() {
            if let Some(done) = v["text"].as_str() {
                let into = v["into"].as_str();
                let now = chat::now();
                let _ = crate::translations::record(&dir, &source, done, into, now);
            }
        }
    }
    let _ = app.emit_to(
        "pet",
        "companion-motion",
        json!({"kind":if result.as_ref().err().is_some_and(|e|e!="stopped"){"error"}else{"idle"}}),
    );
    result
}
#[tauri::command]
pub fn copy_translation(text: String) -> Result<(), String> {
    let data = CString::new(text).map_err(|_| t("host.badChars"))?;
    let _guard = CLIPBOARD.lock().unwrap();
    #[cfg(any(windows, target_os = "macos"))]
    if unsafe { companion_copy(data.as_ptr()) } == 1 {
        crate::copy_twice::OWN_WRITE.store(crate::copy_twice::count(), Ordering::SeqCst);
        return Ok(());
    }
    Err(t("host.clipboardBusy").into())
}
/// 替换为译文 (plan/41): the translation goes where the selection was, in the
/// app it came from, and the clipboard is put back. Err means it could not;
/// the bubble then copies instead and says so.
#[tauri::command]
pub async fn replace_with_translation(text: String, target: isize) -> Result<(), String> {
    let data = CString::new(text).map_err(|_| t("host.badChars"))?;
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = CLIPBOARD.lock().unwrap();
        #[cfg(any(windows, target_os = "macos"))]
        {
            let done =
                target != 0 && unsafe { companion_replace(target, data.as_ptr()) } == 1;
            crate::copy_twice::OWN_WRITE.store(crate::copy_twice::count(), Ordering::SeqCst);
            if done {
                return Ok(());
            }
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        let _ = (data, target);
        Err(t("host.replaceFailed").to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub fn selection_preferences() -> Result<(), String> {
    crate::permissions::open_os_settings("accessibility")
}

#[tauri::command]
pub fn retry_selection(app: AppHandle) {
    // The bubble's 再试一次 was clicked, so 随伴 is in front: read the app before it.
    translate_selection_from_menu(app);
}
#[tauri::command]
/// 看全部 or 展开 on a translation: the side panel's 翻译记录 page.
pub fn open_translations(app: AppHandle) -> Result<(), String> {
    crate::chat_window::show_translations(&app)
}

#[cfg(all(windows, test))]
#[path = "windows_selection_test.rs"]
mod windows_selection_test;
