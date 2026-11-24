//! The screenshot card: a small window of its own that shows the capture
//! large, with the recognized text laid over it so it can be selected right
//! on the picture, and a few clear actions. Asking and translating hand off
//! to the pet's bubble; the card itself never talks to the model.
use crate::locale::t;
use crate::{capture_image, chat, companion::Companion, ocr};
use base64::{engine::general_purpose::STANDARD, Engine};
use image::RgbaImage;
use serde_json::{json, Value};
use std::sync::Mutex;
use tauri::{
    AppHandle, Emitter, LogicalPosition, LogicalSize, Manager, PhysicalPosition, PhysicalSize,
    WebviewUrl, WebviewWindow, WebviewWindowBuilder,
};

const LABEL: &str = "snipcard";

/// Where the selection was, as (x, y, width, height) in the display's own
/// units (points on a Mac, pixels on Windows), so the card can open beside
/// it on the same screen.
#[derive(Clone, Copy)]
pub struct Anchor {
    pub selection: (f64, f64, f64, f64),
    pub screen: (f64, f64, f64, f64),
    pub units_per_css: f64,
}

impl Anchor {
    fn window_size(self, width: f64, height: f64) -> (f64, f64) {
        (
            (width.clamp(320., 900.) * self.units_per_css).ceil(),
            (height.clamp(160., 900.) * self.units_per_css).ceil(),
        )
    }
}

struct Card {
    generation: u64,
    png: Vec<u8>,
    preview: String,
    ocr: Option<ocr::Recognized>,
    can_vision: bool,
    brain: bool,
    translation: bool,
    anchor: Anchor,
}

#[derive(Default)]
pub struct Cards(Mutex<Option<Card>>);

fn payload(c: &Card) -> Value {
    json!({
        "generation": c.generation,
        "preview": c.preview,
        "canVision": c.can_vision,
        "brainEnabled": c.brain,
        "translation": c.translation,
        "ocr": c.ocr,
    })
}

/// The pet wears its glasses from the start of a snip until the card closes.
pub(crate) fn glasses(app: &AppHandle, on: bool) {
    let _ = app.emit_to("pet", "companion-glasses", on);
}

fn ensure(app: &AppHandle) -> Result<WebviewWindow, String> {
    if let Some(w) = app.get_webview_window(LABEL) {
        return Ok(w);
    }
    WebviewWindowBuilder::new(app, LABEL, WebviewUrl::App("index.html?snipcard".into()))
        .incognito(cfg!(any(feature = "acceptance", feature = "trial")))
        .title(t("host.titleSnipCard"))
        .transparent(true)
        .decorations(false)
        .shadow(false)
        .resizable(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .accept_first_mouse(true)
        .visible(false)
        .inner_size(420., 320.)
        .build()
        .map_err(|_| t("host.cardWindow").into())
}

/// Builds the window ahead of time while the user is still selecting, and
/// hides any previous card so it is not frozen into the new screenshot.
/// True when a card was on screen and had to be put away.
pub fn prepare(app: &AppHandle) -> bool {
    let shown = app
        .get_webview_window(LABEL)
        .is_some_and(|w| w.is_visible().unwrap_or(false) && w.hide().is_ok());
    let _ = ensure(app);
    shown
}

pub fn present(
    app: &AppHandle,
    generation: u64,
    image: RgbaImage,
    anchor: Anchor,
) -> Result<(), String> {
    let png = capture_image::png(image.clone())?;
    let preview = format!("data:image/png;base64,{}", STANDARD.encode(&png));
    let (brain, vision, translation) = {
        let state = app.state::<Companion>();
        let s = state.settings.lock().unwrap();
        (s.enabled, s.enabled && s.vision, s.enabled && s.translation)
    };
    let can_vision = vision
        && app
            .state::<Companion>()
            .client()
            .ok()
            .and_then(|c| c.call("visionInfo", json!({})).ok())
            .and_then(|v| v["canSee"].as_bool())
            .unwrap_or(false);
    let card = Card {
        generation,
        png,
        preview,
        ocr: None,
        can_vision,
        brain,
        translation,
        anchor,
    };
    let data = payload(&card);
    *app.state::<Cards>().0.lock().unwrap() = Some(card);
    ensure(app)?;
    // The page sizes itself to the picture, then asks to be shown.
    app.emit_to(LABEL, "snip-card", data)
        .map_err(|e| e.to_string())?;
    let app = app.clone();
    std::thread::spawn(move || {
        let result = capture_image::encode(&image)
            .map(|full| ocr::recognize(&full))
            .unwrap_or_else(|e| ocr::Recognized {
                error: Some(e),
                ..Default::default()
            });
        let state = app.state::<Cards>();
        let mut slot = state.0.lock().unwrap();
        let Some(card) = slot.as_mut().filter(|c| c.generation == generation) else {
            return;
        };
        card.ocr = Some(result.clone());
        drop(slot);
        let _ = app.emit_to(
            LABEL,
            "snip-card-ocr",
            json!({"generation": generation, "ocr": result}),
        );
    });
    Ok(())
}

/// The picture for asking a model that can see (shrunk by `png`).
pub fn image(app: &AppHandle, generation: u64) -> Option<Vec<u8>> {
    app.state::<Cards>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .filter(|c| c.generation == generation)
        .map(|c| c.png.clone())
}

#[tauri::command]
pub fn snip_card(app: AppHandle) -> Option<Value> {
    app.state::<Cards>().0.lock().unwrap().as_ref().map(payload)
}

fn release_window(app: &AppHandle) {
    if let Some(w) = app.get_webview_window(LABEL) {
        let _ = w.hide();
        crate::idle_release::destroy_later(w);
    }
    glasses(app, false);
}

/// Closes any open screenshot card and releases its WebView immediately.
/// `prepare()` builds a fresh window while the user drags the next capture.
pub fn dismiss(app: &AppHandle) {
    *app.state::<Cards>().0.lock().unwrap() = None;
    release_window(app);
}

#[tauri::command]
pub fn snip_card_close(app: AppHandle, generation: u64) {
    let state = app.state::<Cards>();
    let mut slot = state.0.lock().unwrap();
    if slot.as_ref().is_some_and(|c| c.generation == generation) {
        *slot = None;
        drop(slot);
        release_window(&app);
    }
}

/// Sizes the card to its content and opens it beside the selection,
/// kept inside that screen.
#[tauri::command]
pub fn size_snip_card(
    app: AppHandle,
    generation: u64,
    width: f64,
    height: f64,
) -> Result<(), String> {
    let anchor = {
        let slot = app.state::<Cards>();
        let slot = slot.0.lock().unwrap();
        match slot.as_ref().filter(|c| c.generation == generation) {
            Some(c) => c.anchor,
            None => return Ok(()),
        }
    };
    let w = ensure(&app)?;
    let (lw, lh) = anchor.window_size(width, height);
    let (x, y) = place(anchor, (lw, lh));
    // Size first, then place: a Mac resize keeps the bottom-left corner.
    if cfg!(target_os = "macos") {
        w.set_size(LogicalSize::new(lw, lh))
            .and_then(|_| w.set_position(LogicalPosition::new(x, y)))
    } else {
        // Move onto the target monitor before the final size. WM_DPICHANGED
        // can otherwise rescale the already-sized card during the move.
        w.set_position(PhysicalPosition::new(x as i32, y as i32))
            .and_then(|_| w.set_size(PhysicalSize::new(lw as u32, lh as u32)))
    }
    .map_err(|e| e.to_string())?;
    if !w.is_visible().unwrap_or(false) {
        w.show().map_err(|e| e.to_string())?;
        let _ = w.set_focus();
    }
    Ok(())
}

/// Centered on the selection horizontally, its top at the selection's top,
/// then clamped inside the screen (leaving the menu bar alone).
fn place(a: Anchor, (w, h): (f64, f64)) -> (f64, f64) {
    let (sx, sy, sw, _) = a.selection;
    let (left, top, width, height) = a.screen;
    let (right, bottom) = (left + width, top + height);
    let top = top + if cfg!(target_os = "macos") { 28. } else { 0. };
    let x = (sx + sw / 2. - w / 2.).clamp(left, (right - w).max(left));
    let y = sy.clamp(top, (bottom - h).max(top));
    (x, y)
}

/// Get the selected capture and its recognized text for the first chat turn.
pub fn chat_input(
    app: &AppHandle,
    generation: u64,
) -> Result<
    (
        bool,
        Vec<crate::attachments::AttachedFile>,
        crate::chat_images::Picture,
    ),
    String,
> {
    let state = app.state::<Companion>();
    let settings = state.settings.lock().unwrap();
    if !settings.enabled || !settings.vision {
        return Err("disabled".into());
    }
    drop(settings);
    let cards = app.state::<Cards>();
    let slot = cards.0.lock().unwrap();
    let card = slot
        .as_ref()
        .filter(|c| c.generation == generation)
        .ok_or(t("host.snipAgain"))?;
    let can_see = card.can_vision;
    let files: Vec<_> = card
        .ocr
        .as_ref()
        .filter(|r| !r.text.trim().is_empty())
        .map(|r| crate::attachments::AttachedFile {
            name: "截图文字".into(),
            text: r.text.clone(),
        })
        .into_iter()
        .collect();
    if !can_see && files.is_empty() {
        return Err(if card.ocr.is_none() {
            t("host.ocrBusy")
        } else {
            t("host.cantSee")
        }
        .into());
    }
    let bytes = card.png.clone();
    drop(slot);
    Ok((can_see, files, crate::chat_images::Picture::new(bytes)?))
}
#[tauri::command]
pub fn snip_topics(app: AppHandle) -> Result<Value, String> {
    let pet = chat::pet(&app)?.0;
    let dir = &app.state::<Companion>().dir;
    let topics = crate::topics::list_for(dir, "", Some(&pet)).map_err(|_| t("host.topicsRead"))?;
    let current =
        crate::topics::current(dir, &pet, chat::now()).map_err(|_| t("host.topicsRead"))?;
    Ok(json!({"current":current, "topics":topics}))
}

#[tauri::command]
pub fn snip_card_ask(
    app: AppHandle,
    generation: u64,
    question: String,
    topic: Option<i64>,
) -> Result<(), String> {
    let question = question.trim().to_owned();
    if question.is_empty() {
        return Err(t("host.enterQuestion").into());
    }
    if chat::busy(&app) {
        return Err(t("host.waitReply").into());
    }
    if !app
        .state::<Cards>()
        .0
        .lock()
        .unwrap()
        .as_ref()
        .is_some_and(|c| c.generation == generation)
    {
        return Err(t("host.snipAgain").into());
    }
    chat::show(
        &app,
        json!({
            "mode": "snip-ask",
            "topic": topic,
            "generation": generation,
            "question": question,
            "at": chat::now(),
        }),
        false,
    )
}

#[tauri::command]
pub fn snip_card_translate(app: AppHandle, text: String) -> Result<(), String> {
    let text = text.trim().to_owned();
    if text.is_empty() {
        return Err(t("host.nothingToTranslate").into());
    }
    let at = chat::now();
    chat::show(
        &app,
        json!({"mode": "translate", "source": text, "at": at, "generation": at}),
        false,
    )
}

#[tauri::command]
pub fn snip_copy_image(app: AppHandle, generation: u64) -> Result<(), String> {
    let png = image(&app, generation).ok_or(t("host.snipAgain"))?;
    #[cfg(target_os = "macos")]
    {
        extern "C" {
            fn companion_copy_png(bytes: *const u8, len: usize) -> i32;
        }
        if unsafe { companion_copy_png(png.as_ptr(), png.len()) } == 1 {
            crate::copy_twice::OWN_WRITE.store(
                crate::copy_twice::count(),
                std::sync::atomic::Ordering::SeqCst,
            );
            return Ok(());
        }
    }
    #[cfg(windows)]
    {
        let image = image::load_from_memory(&png)
            .map_err(|_| t("host.snipRead"))?
            .into_rgba8();
        extern "C" {
            fn companion_copy_rgba(pixels: *const u8, width: u32, height: u32) -> i32;
        }
        if unsafe { companion_copy_rgba(image.as_ptr(), image.width(), image.height()) } == 1 {
            crate::copy_twice::OWN_WRITE.store(
                crate::copy_twice::count(),
                std::sync::atomic::Ordering::SeqCst,
            );
            return Ok(());
        }
    }
    let _ = png;
    Err(t("host.clipboardBusy").into())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn windows_card_uses_the_selection_monitors_dpi() {
        for (scale, expected) in [(1.25, (525., 400.)), (1.5, (630., 480.))] {
            let anchor = Anchor {
                selection: (-10., 820., 10., 20.),
                screen: (-1600., 0., 1600., 900.),
                units_per_css: scale,
            };
            let size = anchor.window_size(420., 320.);
            assert_eq!(size, expected);
            assert_eq!(place(anchor, size), (-size.0, 900. - size.1));
        }
    }
    #[test]
    fn card_opens_beside_the_selection_and_stays_on_its_screen() {
        // Points, as the Mac reports them: the built-in screen to the left
        // of the main one (negative x), as on the user's desk.
        let a = Anchor {
            selection: (500., 300., 200., 100.),
            screen: (0., 0., 1280., 720.),
            units_per_css: 1.,
        };
        // Centered on the selection, top aligned.
        assert_eq!(place(a, (300., 200.)), (450., 300.));
        // Near the bottom-right corner: pushed back inside.
        let corner = Anchor {
            selection: (1250., 700., 20., 10.),
            ..a
        };
        assert_eq!(place(corner, (300., 200.)), (980., 520.));
        let left = Anchor {
            selection: (-1270., 0., 50., 50.),
            screen: (-1280., 0., 1280., 832.),
            ..a
        };
        let (x, y) = place(left, (300., 200.));
        assert_eq!(x, -1280.);
        assert!(y >= 0. && y + 200. <= 832.);
    }
}

#[cfg(all(windows, test))]
mod windows_native_tests {
    use std::ffi::c_void;

    // Run only on the disposable Windows CI desktop.
    #[test]
    fn windows_clipboard_preserves_pixel_order() {
        if std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true") {
            return;
        }
        extern "C" {
            fn companion_copy_rgba(data: *const u8, w: u32, h: u32) -> i32;
        }
        #[link(name = "user32")]
        extern "system" {
            fn OpenClipboard(owner: *mut c_void) -> i32;
            fn GetClipboardData(format: u32) -> *mut c_void;
            fn CloseClipboard() -> i32;
        }
        #[link(name = "kernel32")]
        extern "system" {
            fn GlobalLock(mem: *mut c_void) -> *const u8;
            fn GlobalUnlock(mem: *mut c_void) -> i32;
        }
        let rgba = [1, 2, 3, 255, 10, 20, 30, 255];
        unsafe {
            assert_eq!(companion_copy_rgba(rgba.as_ptr(), 1, 2), 1);
            assert_ne!(OpenClipboard(std::ptr::null_mut()), 0);
            let dib = GetClipboardData(8);
            assert!(!dib.is_null());
            let ptr = GlobalLock(dib);
            assert!(!ptr.is_null());
            let data = std::slice::from_raw_parts(ptr, 48).to_vec();
            GlobalUnlock(dib);
            CloseClipboard();
            assert_eq!(i32::from_le_bytes(data[8..12].try_into().unwrap()), -2);
            assert_eq!(&data[40..], &[3, 2, 1, 255, 30, 20, 10, 255]);
        }
    }
}
