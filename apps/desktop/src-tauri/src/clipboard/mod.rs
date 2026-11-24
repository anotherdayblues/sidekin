mod media;
mod panel;
mod store;
use crate::{chat, copy_twice, selection};
pub use panel::*;
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use std::{
    collections::VecDeque,
    ffi::{c_char, CStr},
    path::PathBuf,
    sync::{mpsc, Mutex, OnceLock},
    time::{Duration, Instant},
};
use tauri::{AppHandle, Emitter, Manager};

fn default_true() -> bool {
    true
}

#[derive(Clone, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Preferences {
    pub enabled: bool,
    pub excluded: String,
    pub retention_days: u16,
    #[serde(default = "default_true")]
    pub save_images: bool,
    #[serde(default = "default_true")]
    pub ocr_images: bool,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            enabled: false,
            excluded: String::new(),
            retention_days: 7,
            save_images: true,
            ocr_images: true,
        }
    }
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PreferenceChange {
    enabled: Option<bool>,
    excluded: Option<String>,
    retention_days: Option<u16>,
    save_images: Option<bool>,
    ocr_images: Option<bool>,
}
impl PreferenceChange {
    fn apply(self, mut previous: Preferences) -> Result<Preferences, String> {
        if let Some(days) = self.retention_days {
            if ![0, 1, 7, 30, 90].contains(&days) {
                return Err(failed());
            }
            previous.retention_days = days;
        }
        if let Some(excluded) = self.excluded {
            if excluded.len() > 4096 {
                return Err(failed());
            }
            previous.excluded = excluded;
        }
        if let Some(enabled) = self.enabled {
            previous.enabled = enabled;
        }
        if let Some(save_images) = self.save_images {
            previous.save_images = save_images;
        }
        if let Some(ocr_images) = self.ocr_images {
            previous.ocr_images = ocr_images;
        }
        Ok(previous)
    }
}

enum SampleKind {
    Text(String),
    Image { raw: Vec<u8>, format: i32 },
}

struct Sample {
    seq: isize,
    kind: SampleKind,
    source: String,
    ready: Instant,
}
#[derive(Default)]
struct Pending {
    items: VecDeque<Sample>,
    suppressed: VecDeque<isize>,
}
impl Pending {
    fn add(&mut self, s: Sample) {
        if !self.suppressed.contains(&s.seq) && !self.items.iter().any(|v| v.seq == s.seq) {
            self.items.push_back(s);
        }
    }
    fn suppress(&mut self, a: isize, b: isize) {
        self.items.retain(|s| s.seq != a && s.seq != b);
        self.suppressed.extend([a, b]);
        while self.suppressed.len() > 16 {
            self.suppressed.pop_front();
        }
    }
}
struct Recording {
    prefs: Preferences,
    seen: isize,
    pending: Pending,
}
pub struct Clipboard {
    file: PathBuf,
    recording: Mutex<Recording>,
    configure: Mutex<()>,
    panel: Mutex<Option<panel::Session>>,
}
static WAKE: OnceLock<mpsc::SyncSender<()>> = OnceLock::new();
#[no_mangle]
pub extern "C" fn clip_changed() {
    if let Some(tx) = WAKE.get() {
        let _ = tx.try_send(());
    }
}

struct OcrJob {
    app: AppHandle,
    file: PathBuf,
    id: i64,
    png: Vec<u8>,
}

static OCR_QUEUE: OnceLock<mpsc::SyncSender<OcrJob>> = OnceLock::new();

fn enqueue_ocr(app: AppHandle, file: PathBuf, id: i64, png: Vec<u8>) {
    let tx = OCR_QUEUE.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel::<OcrJob>(8);
        std::thread::Builder::new()
            .name("clip-ocr".into())
            .spawn(move || {
                while let Ok(job) = rx.recv() {
                    let enabled = job
                        .app
                        .try_state::<Clipboard>()
                        .is_some_and(|s| s.recording.lock().unwrap().prefs.ocr_images);
                    if !enabled {
                        continue;
                    }
                    let recognized = crate::ocr::recognize(&job.png);
                    if recognized.error.is_some() {
                        continue;
                    }
                    let trimmed = recognized.text.trim();
                    if trimmed.is_empty() {
                        continue;
                    }
                    let mut capped = String::new();
                    for ch in trimmed.chars() {
                        if capped.len() + ch.len_utf8() > 16 * 1024 {
                            break;
                        }
                        capped.push(ch);
                    }
                    if let Ok(db) = store::open(&job.file) {
                        if store::update_ocr(&db, job.id, &capped).unwrap_or(0) > 0 {
                            notify_views(&job.app, "clip-updated");
                        }
                    }
                }
            })
            .expect("spawn clip-ocr worker");
        tx
    });
    let _ = tx.try_send(OcrJob { app, file, id, png });
}

extern "C" {
    fn companion_temporary_sequence() -> isize;
    fn clip_source(allow_image: i32) -> *mut c_char;
    fn clip_plain() -> *mut c_char;
    fn clip_image(out_len: *mut usize, out_format: *mut i32) -> *mut u8;
    fn companion_free(text: *mut c_char);
}
fn owned(ptr: *mut c_char) -> Option<String> {
    if ptr.is_null() {
        return None;
    }
    let s = unsafe { CStr::from_ptr(ptr) }
        .to_string_lossy()
        .into_owned();
    unsafe { companion_free(ptr) };
    Some(s)
}
fn owned_image() -> Option<(Vec<u8>, i32)> {
    let mut len: usize = 0;
    let mut format: i32 = 0;
    let ptr = unsafe { clip_image(&mut len, &mut format) };
    if ptr.is_null() || len == 0 || format == 0 {
        if !ptr.is_null() {
            unsafe { companion_free(ptr.cast()) };
        }
        return None;
    }
    let bytes = unsafe { std::slice::from_raw_parts(ptr, len) }.to_vec();
    unsafe { companion_free(ptr.cast()) };
    Some((bytes, format))
}
#[cfg(all(target_os = "macos", feature = "acceptance"))]
pub(crate) fn fixture_contents() -> Option<String> {
    // The acceptance build links clip_plain to its own named pasteboard.
    owned(unsafe { clip_plain() })
}
pub(crate) fn is_password_manager(source: &str) -> bool {
    let app = source.to_lowercase();
    [
        "1password",
        "onepassword",
        "keepass",
        "bitwarden",
        "keychainaccess",
        "com.apple.passwords",
        "lastpass",
        "dashlane",
    ]
    .iter()
    .any(|s| app.contains(s))
}
fn excluded(source: &str, prefs: &Preferences) -> bool {
    let app = source.to_lowercase();
    is_password_manager(source)
        || prefs
            .excluded
            .lines()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .any(|s| app.contains(&s.to_lowercase()))
}

pub fn enabled(app: &AppHandle) -> bool {
    app.state::<Clipboard>()
        .recording
        .lock()
        .unwrap()
        .prefs
        .enabled
}

enum Captured {
    Text(String),
    Image,
}

fn capture(r: &mut Recording, seq: isize) -> Option<Captured> {
    // Reading and verifying a sample is serialized with temporary translation writes.
    let _guard = selection::CLIPBOARD.try_lock().ok()?;
    if seq != copy_twice::count() || seq == unsafe { companion_temporary_sequence() } {
        return None;
    }
    let source = owned(unsafe { clip_source(r.prefs.save_images.into()) })?;
    if excluded(&source, &r.prefs) {
        return None;
    }
    if let Some(body) = owned(unsafe { clip_plain() }) {
        if body.len() <= store::MAX_BYTES && !body.trim().is_empty() && seq == copy_twice::count() {
            // Allow both key presses (800ms) plus the source app's delayed second write.
            r.pending.add(Sample {
                seq,
                kind: SampleKind::Text(body.clone()),
                source,
                ready: Instant::now() + Duration::from_millis(1120),
            });
            return Some(Captured::Text(body));
        }
    }
    if r.prefs.save_images {
        let (raw, format) = owned_image()?;
        if seq != copy_twice::count() {
            return None;
        }
        // Images do not trigger double-copy translation, so flush quickly.
        r.pending.add(Sample {
            seq,
            kind: SampleKind::Image { raw, format },
            source,
            ready: Instant::now() + Duration::from_millis(200),
        });
        return Some(Captured::Image);
    }
    None
}
pub fn key_sample(app: &AppHandle, seq: isize) -> Option<String> {
    let state = app.state::<Clipboard>();
    let mut r = state.recording.lock().unwrap();
    if !r.prefs.enabled {
        return None;
    }
    if let Some(s) = r.pending.items.iter().find(|s| s.seq == seq) {
        return match &s.kind {
            SampleKind::Text(body) => Some(body.clone()),
            SampleKind::Image { .. } => None,
        };
    }
    let value = capture(&mut r, seq);
    if value.is_some() {
        clip_changed();
    }
    match value {
        Some(Captured::Text(body)) => Some(body),
        _ => None,
    }
}
pub fn translated(app: &AppHandle, first: isize, second: isize) {
    let state = app.state::<Clipboard>();
    let mut r = state.recording.lock().unwrap();
    if r.prefs.enabled {
        r.pending.suppress(first, second);
    }
}
#[cfg(windows)]
fn listen(app: &AppHandle, enabled: bool) -> Result<(), String> {
    extern "C" {
        fn clip_listen(window: isize, on: i32) -> i32;
    }
    let window = app.get_webview_window("pet").ok_or_else(failed)?;
    let hwnd = window.hwnd().map_err(|_| failed())?.0 as isize;
    // SetWindowSubclass must run on the thread that owns the window.
    let toggle = move || unsafe { clip_listen(hwnd, enabled.into()) };
    let (tx, rx) = mpsc::channel();
    app.run_on_main_thread(move || {
        let _ = tx.send(toggle());
    })
    .map_err(|_| failed())?;
    if rx.recv().unwrap_or(0) == 0 {
        return Err(failed());
    }
    Ok(())
}
pub fn setup(app: &AppHandle, root: PathBuf) {
    let file = root.join("clipboard.sqlite3");
    let prefs = store::preferences(&file).unwrap_or_default();
    let enabled = prefs.enabled;
    let initial = if enabled { copy_twice::count() } else { -1 };
    app.manage(Clipboard {
        file,
        configure: Mutex::new(()),
        recording: Mutex::new(Recording {
            prefs,
            seen: initial,
            pending: Pending::default(),
        }),
        panel: Mutex::default(),
    });
    let (tx, rx) = mpsc::sync_channel(1);
    let _ = WAKE.set(tx);
    let app = app.clone();
    std::thread::spawn(move || {
        #[cfg(windows)]
        if enabled && !cfg!(feature = "acceptance") {
            let _ = listen(&app, true);
        }
        let s = app.state::<Clipboard>();
        let media_root = media::media_dir(&s.file);
        let mut cleanup = Instant::now();
        let mut attempts = 0;
        let mut retry_seq = -1;
        loop {
            let mut retry = false;
            if Instant::now() >= cleanup {
                if s.file.exists() {
                    if let Ok(db) = store::open(&s.file) {
                        if let Ok(removed) = store::prune(&db, chat::now() as i64) {
                            media::delete_unused(&media_root, &db, &removed);
                        }
                        media::sweep_orphans(&media_root, &db);
                    }
                }
                cleanup = Instant::now() + Duration::from_secs(3600);
            }
            let (ready_items, ocr_enabled, wait) = {
                let mut r = s.recording.lock().unwrap();
                let mut popped = Vec::new();
                let ocr_on = r.prefs.ocr_images;
                if r.prefs.enabled && (cfg!(target_os = "macos") || !cfg!(feature = "acceptance")) {
                    let seq = copy_twice::count();
                    if seq != r.seen {
                        if seq != retry_seq {
                            retry_seq = seq;
                            attempts = 0;
                        }
                        if selection::clipboard_busy() {
                            retry = true;
                        } else if capture(&mut r, seq).is_some() || attempts >= 2 {
                            r.seen = seq;
                        } else {
                            attempts += 1;
                            retry = true;
                        }
                    }
                    let now = Instant::now();
                    while r.pending.items.front().is_some_and(|v| v.ready <= now) {
                        popped.push(r.pending.items.pop_front().unwrap());
                    }
                    let deadline = r
                        .pending
                        .items
                        .front()
                        .map(|v| v.ready.saturating_duration_since(now));
                    #[cfg(target_os = "macos")]
                    let deadline = Some(
                        deadline
                            .unwrap_or(Duration::MAX)
                            .min(Duration::from_millis(500)),
                    );
                    (popped, ocr_on, deadline)
                } else {
                    (popped, ocr_on, None)
                }
            };
            if !ready_items.is_empty() {
                let mut changed = false;
                for v in ready_items {
                    match v.kind {
                        SampleKind::Text(body) => {
                            if let Ok(mut db) = store::open(&s.file) {
                                if let Ok(removed) =
                                    store::insert(&mut db, &body, &v.source, chat::now() as i64)
                                {
                                    media::delete_unused(&media_root, &db, &removed);
                                    changed = true;
                                }
                            }
                        }
                        SampleKind::Image { raw, format } => {
                            let png = match format {
                                1 => Some(raw),
                                2 => media::dib_to_png(&raw),
                                _ => None,
                            };
                            let Some(prepared) = png.and_then(media::prepare_png) else {
                                continue;
                            };
                            if media::write_media_files(&media_root, &prepared).is_err() {
                                continue;
                            }
                            if let Ok(mut db) = store::open(&s.file) {
                                if let Ok(ins) = store::insert_image(
                                    &mut db,
                                    &prepared,
                                    &v.source,
                                    chat::now() as i64,
                                ) {
                                    media::delete_unused(&media_root, &db, &ins.removed);
                                    changed = true;
                                    if ocr_enabled && ins.needs_ocr {
                                        enqueue_ocr(
                                            app.clone(),
                                            s.file.clone(),
                                            ins.id,
                                            prepared.png,
                                        );
                                    }
                                }
                            }
                        }
                    }
                }
                if changed {
                    notify_views(&app, "clip-updated");
                }
            }
            let mut delay = wait
                .unwrap_or(Duration::MAX)
                .min(cleanup.saturating_duration_since(Instant::now()));
            if retry {
                delay = delay.min(Duration::from_millis(35));
            }
            if matches!(
                rx.recv_timeout(delay),
                Err(mpsc::RecvTimeoutError::Disconnected)
            ) {
                break;
            }
        }
    });
}
fn failed() -> String {
    crate::locale::t("clip.failed").to_string()
}
#[tauri::command]
pub fn clip_preferences(app: AppHandle) -> Preferences {
    app.state::<Clipboard>()
        .recording
        .lock()
        .unwrap()
        .prefs
        .clone()
}
fn notify_views(app: &AppHandle, event: &str) {
    if panel::active(app) {
        let _ = app.emit_to("bubble", event, ());
    }
    let _ = app.emit_to("studio", event, ());
}
#[tauri::command]
pub async fn clip_configure(
    app: AppHandle,
    prefs: PreferenceChange,
) -> Result<Preferences, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let state = app.state::<Clipboard>();
        let _update = state.configure.lock().unwrap();
        let prev = state.recording.lock().unwrap().prefs.clone();
        let next = prefs.apply(prev.clone())?;
        if prev == next {
            return Ok(next);
        }
        // Window subclassing must run on the UI thread. Do not hold the
        // recording lock while waiting for that thread.
        #[cfg(windows)]
        let switch_listener = prev.enabled != next.enabled && !cfg!(feature = "acceptance");
        #[cfg(windows)]
        if switch_listener {
            listen(&app, next.enabled)?;
        }
        let mut r = state.recording.lock().unwrap();
        let media_root = media::media_dir(&state.file);
        let save = || -> rusqlite::Result<()> {
            let mut db = store::open(&state.file)?;
            let tx = db.transaction()?;
            store::configure(&tx, &next)?;
            let removed = if next.retention_days != prev.retention_days {
                store::prune(&tx, chat::now() as i64)?
            } else {
                vec![]
            };
            tx.commit()?;
            media::delete_unused(&media_root, &db, &removed);
            Ok(())
        };
        if save().is_err() {
            drop(r);
            #[cfg(windows)]
            if switch_listener {
                let _ = listen(&app, prev.enabled);
            }
            return Err(failed());
        }
        if prev.enabled != next.enabled
            || prev.excluded != next.excluded
            || prev.save_images != next.save_images
        {
            r.pending = Pending::default();
            r.seen = if next.enabled {
                copy_twice::count()
            } else {
                -1
            };
        }
        r.prefs = next.clone();
        drop(r);
        clip_changed();
        if panel::active(&app) {
            let _ = app.emit_to("bubble", "clip-preferences-updated", &next);
        }
        let _ = app.emit_to("studio", "clip-preferences-updated", &next);
        Ok(next)
    })
    .await
    .map_err(|_| failed())?
}
#[tauri::command]
pub async fn clip_search(
    app: AppHandle,
    query: String,
    offset: usize,
    kind: Option<String>,
) -> Result<Vec<store::Entry>, String> {
    let file = app.state::<Clipboard>().file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !file.exists() {
            return Ok(vec![]);
        }
        let media_root = media::media_dir(&file);
        store::search(
            &store::open(&file)?,
            &media_root,
            &query,
            kind.as_deref(),
            chat::now() as i64,
            offset,
        )
    })
    .await
    .map_err(|_| failed())?
    .map_err(|_| failed())
}
#[tauri::command]
pub fn clip_edit(app: AppHandle, id: Option<i64>, action: &str) -> Result<(), String> {
    let s = app.state::<Clipboard>();
    let mut r = s.recording.lock().unwrap();
    let db = store::open(&s.file).map_err(|_| failed())?;
    let media_root = media::media_dir(&s.file);
    let removed = match (action, id) {
        ("clear", None) => {
            r.pending = Pending::default();
            r.seen = copy_twice::count();
            store::clear_all(&db).map_err(|_| failed())?
        }
        ("pin", Some(id)) => {
            db.execute("UPDATE clips SET pinned=1-pinned WHERE id=?1", [id])
                .map_err(|_| failed())?;
            vec![]
        }
        ("delete", Some(id)) => store::delete_by_id(&db, id).map_err(|_| failed())?,
        _ => return Err(failed()),
    };
    media::delete_unused(&media_root, &db, &removed);
    drop(r);
    notify_views(&app, "clip-updated");
    Ok(())
}
#[tauri::command]
pub fn clip_delete_batch(app: AppHandle, ids: Vec<i64>) -> Result<(), String> {
    if ids.is_empty() {
        return Ok(());
    }
    let s = app.state::<Clipboard>();
    let r = s.recording.lock().unwrap();
    let mut db = store::open(&s.file).map_err(|_| failed())?;
    let media_root = media::media_dir(&s.file);
    let removed = store::delete_many(&mut db, &ids).map_err(|_| failed())?;
    media::delete_unused(&media_root, &db, &removed);
    drop(r);
    notify_views(&app, "clip-updated");
    Ok(())
}
pub(super) fn payload(app: &AppHandle, id: i64) -> Result<store::ClipPayload, String> {
    let file = &app.state::<Clipboard>().file;
    let db = store::open(file).map_err(|_| failed())?;
    let media_root = media::media_dir(file);
    store::get_payload(&db, &media_root, id, chat::now() as i64)
        .map_err(|_| failed())?
        .ok_or_else(failed)
}
fn body(app: &AppHandle, id: i64) -> Result<String, String> {
    let file = &app.state::<Clipboard>().file;
    let db = store::open(file).map_err(|_| failed())?;
    let media_root = media::media_dir(file);
    let removed = store::prune(&db, chat::now() as i64).map_err(|_| failed())?;
    media::delete_unused(&media_root, &db, &removed);
    db.query_row("SELECT body FROM clips WHERE id=?1", params![id], |r| {
        r.get(0)
    })
    .optional()
    .map_err(|_| failed())?
    .ok_or_else(failed)
}
#[tauri::command]
pub fn clip_full(app: AppHandle, id: i64) -> Result<String, String> {
    body(&app, id)
}
#[tauri::command]
pub async fn clip_detail(app: AppHandle, id: i64) -> Result<store::Detail, String> {
    let file = app.state::<Clipboard>().file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let db = store::open(&file).map_err(|_| failed())?;
        let media_root = media::media_dir(&file);
        store::get_detail(&db, &media_root, id, chat::now() as i64)
            .map_err(|_| failed())?
            .ok_or_else(failed)
    })
    .await
    .map_err(|_| failed())?
}
#[tauri::command]
pub async fn clip_usage(app: AppHandle) -> Result<store::ImageUsage, String> {
    let file = app.state::<Clipboard>().file.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !file.exists() {
            return Ok(store::ImageUsage {
                count: 0,
                bytes: 0,
                limit_count: store::IMAGE_LIMIT,
                limit_bytes: store::IMAGE_QUOTA_BYTES as u64,
            });
        }
        let db = store::open(&file).map_err(|_| failed())?;
        store::image_usage(&db).map_err(|_| failed())
    })
    .await
    .map_err(|_| failed())?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_settings_changes_keep_the_other_windows_choices() {
        let base: Preferences =
            serde_json::from_value(serde_json::json!({"enabled":true,"excluded":"Safari"}))
                .unwrap();
        assert_eq!(base.retention_days, 7);
        assert!(base.save_images);
        assert!(base.ocr_images);
        let change: PreferenceChange =
            serde_json::from_value(serde_json::json!({"retentionDays":90,"ocrImages":false}))
                .unwrap();
        let updated = change.apply(base).unwrap();
        let pause: PreferenceChange =
            serde_json::from_value(serde_json::json!({"enabled":false,"saveImages":false}))
                .unwrap();
        let result = pause.apply(updated).unwrap();
        assert_eq!(result.retention_days, 90);
        assert_eq!(result.excluded, "Safari");
        assert!(!result.enabled);
        assert!(!result.save_images);
        assert!(!result.ocr_images);
        let invalid: PreferenceChange =
            serde_json::from_value(serde_json::json!({"retentionDays":42})).unwrap();
        assert!(invalid.apply(result).is_err());
    }
    fn item(seq: isize) -> Sample {
        Sample {
            seq,
            kind: SampleKind::Text("fixture".into()),
            source: "Notes".into(),
            ready: Instant::now(),
        }
    }
    #[test]
    fn translation_removes_only_its_two_writes_in_any_delivery_order() {
        let mut p = Pending::default();
        p.add(item(1));
        p.add(item(2));
        p.suppress(2, 3);
        p.add(item(3));
        p.add(item(4));
        p.add(item(4));
        assert_eq!(
            p.items.iter().map(|s| s.seq).collect::<Vec<_>>(),
            vec![1, 4]
        );
    }
    #[test]
    fn skips_password_apps_and_user_exclusions() {
        let p = Preferences {
            enabled: true,
            excluded: "Safari\nPrivateApp".into(),
            ..Preferences::default()
        };
        assert!(excluded("com.apple.Safari", &p));
        assert!(excluded("Bitwarden.exe", &p));
        assert!(!excluded("notepad.exe", &p));
    }
}
