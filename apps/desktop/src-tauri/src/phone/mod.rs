//! 手机传文件 (plan/18, plan/20): a phone on the same Wi-Fi scans the pet's QR
//! code, opens a page served from here, and sends photos, files or a piece
//! of text. Nothing is written until the user says 收下 on the computer, or
//! the phone was trusted before. What arrives goes to a visible folder and
//! onto the pet's file pile; the page can also download what is on the pet.
//! The server runs only while asked for and stops after 10 idle minutes.
mod outbox;
mod rules;
mod server;
pub(crate) mod trash;
mod zip;

use crate::locale::{t, tf};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use tauri::{AppHandle, Emitter, Manager};

/// The first port tried; the next few if it is taken. A stable port keeps a
/// page saved to the phone's home screen working.
const PORT: u16 = 53318;
const IDLE_MS: i64 = 10 * 60_000;

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Where things land; empty means 下载/随伴.
    pub folder: String,
    /// The largest single file, in MB.
    pub max_mb: u64,
    /// What a removal from the pet does to a file the phone sent: "keep"
    /// (the default) leaves it in the folder, "trash" puts it in the
    /// system trash.
    pub discard: String,
    /// Phones whose files come straight in.
    pub trusted: Vec<Device>,
    /// The system's firewall question has been explained once.
    pub explained: bool,
    /// The code in the address. It stays, so a page saved to the phone's
    /// home screen keeps working, until the user asks for a new one.
    #[serde(skip_serializing_if = "String::is_empty")]
    pub code: String,
    /// Files saved from a phone and still on the pet: only these may be
    /// put in the trash on a removal.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub received: Vec<String>,
    /// 发到手机: the phone page's list, so it is still there after a
    /// restart. Only paths; nothing is copied.
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub sent: Vec<outbox::Sent>,
}
impl Default for Settings {
    fn default() -> Self {
        Settings {
            folder: String::new(),
            max_mb: 2048,
            discard: "keep".into(),
            trusted: vec![],
            explained: false,
            code: String::new(),
            received: vec![],
            sent: vec![],
        }
    }
}
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Device {
    pub id: String,
    pub name: String,
    /// A trusted phone's last visit, in ms; 0 for never since trusting.
    #[serde(default, skip_serializing_if = "is_zero")]
    pub seen: i64,
}
fn is_zero(n: &i64) -> bool {
    *n == 0
}
/// A trusted phone was here now: remembered for the settings list.
fn visited(s: &mut Settings, id: &str, at: i64) -> bool {
    match s.trusted.iter_mut().find(|d| d.id == id) {
        Some(d) => {
            d.seen = at;
            true
        }
        None => false,
    }
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Spec {
    pub name: String,
    pub size: u64,
}
#[derive(Serialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Pending,
    Accepted,
    Rejected,
}
#[derive(Clone, Debug)]
struct Offer {
    device: Device,
    files: Vec<Spec>,
    text: Option<String>,
    status: Status,
}

struct Run {
    code: Arc<Mutex<String>>,
    port: u16,
    /// This computer on the local network; None while it is on none.
    host: Option<String>,
    stop: Arc<AtomicBool>,
    last: Arc<AtomicI64>,
}

#[derive(Default)]
pub struct Phone {
    run: Mutex<Option<Run>>,
    offers: Mutex<HashMap<String, Offer>>,
    decided: Condvar,
    avatar: Mutex<Option<Vec<u8>>>,
    /// 发到手机: what the phone page lists to download.
    outbox: outbox::Outbox,
    /// When the phone page last asked for that list: it asks every 25
    /// seconds while it is open on screen.
    seen: AtomicI64,
}

/// The phone page is open on a phone right now.
fn page_open(app: &AppHandle) -> bool {
    let phone = app.state::<Phone>();
    phone.run.lock().unwrap().is_some() && now() - phone.seen.load(Ordering::Relaxed) < 35_000
}

fn now() -> i64 {
    crate::chat::now()
}
fn store(app: &AppHandle) -> PathBuf {
    app.state::<crate::companion::Companion>()
        .dir
        .join("phone.json")
}
/// One change of the settings file at a time: two uploads finish together,
/// a phone says hello while the user changes a setting.
static FILE: Mutex<()> = Mutex::new(());
fn read(path: &std::path::Path) -> Settings {
    std::fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or_default()
}
pub fn settings(app: &AppHandle) -> Settings {
    let _one = FILE.lock().unwrap_or_else(|e| e.into_inner());
    read(&store(app))
}
/// Reads, changes and writes back as one step, so no other change in
/// between is lost. Written to a side file and moved into place, so a
/// reader never sees half a file.
fn update<T>(app: &AppHandle, change: impl FnOnce(&mut Settings) -> T) -> Result<T, String> {
    update_at(&store(app), change)
}
fn update_at<T>(
    path: &std::path::Path,
    change: impl FnOnce(&mut Settings) -> T,
) -> Result<T, String> {
    let _one = FILE.lock().unwrap_or_else(|e| e.into_inner());
    let mut s = read(path);
    let out = change(&mut s);
    let side = path.with_extension("json.tmp");
    std::fs::write(
        &side,
        serde_json::to_vec_pretty(&s).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&side, path).map_err(|e| e.to_string())?;
    Ok(out)
}
/// The folder things land in, made if missing.
pub fn folder(app: &AppHandle, s: &Settings) -> Result<PathBuf, String> {
    let dir = if s.folder.is_empty() {
        app.path()
            .download_dir()
            .map_err(|e| e.to_string())?
            .join(t("app.name"))
    } else {
        PathBuf::from(&s.folder)
    };
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(dir)
}

/// This computer's address on the local network: among its real network
/// cards, the one a connection out would use (asking sends nothing).
fn lan_address() -> Option<String> {
    let route = std::net::UdpSocket::bind("0.0.0.0:0")
        .and_then(|s| s.connect("8.8.8.8:80").map(|_| s))
        .and_then(|s| s.local_addr())
        .ok()
        .and_then(|a| match a.ip() {
            std::net::IpAddr::V4(v4) => Some(v4),
            _ => None,
        });
    let cards: Vec<(String, std::net::Ipv4Addr)> = if_addrs::get_if_addrs()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|i| match i.ip() {
            std::net::IpAddr::V4(v4) => Some((i.name, v4)),
            _ => None,
        })
        .collect();
    rules::pick_address(&cards, route).map(|ip| ip.to_string())
}
/// Called now and then while receiving: a new network means a new code
/// picture, shown at once.
pub(crate) fn recheck_address(app: &AppHandle) {
    let now = lan_address();
    let moved = {
        let phone = app.state::<Phone>();
        let mut run = phone.run.lock().unwrap();
        match run.as_mut() {
            Some(r) if r.host != now => {
                r.host = now;
                true
            }
            _ => false,
        }
    };
    if moved {
        changed(app);
    }
}

fn qr(url: &str) -> String {
    use qrcode::render::svg;
    qrcode::QrCode::new(url.as_bytes())
        .map(|code| {
            code.render::<svg::Color>()
                .min_dimensions(180, 180)
                .quiet_zone(false)
                .dark_color(svg::Color("currentColor"))
                .light_color(svg::Color("transparent"))
                .build()
        })
        .unwrap_or_default()
}

/// What the windows show: whether it is on, the address and its QR code.
fn status(app: &AppHandle) -> Value {
    let phone = app.state::<Phone>();
    let run = phone.run.lock().unwrap();
    match run.as_ref() {
        Some(Run { host: None, .. }) => json!({"running": true, "noNetwork": true}),
        Some(r) => {
            let host = r.host.as_deref().unwrap_or_default();
            let url = format!("http://{}:{}/t/{}/", host, r.port, r.code.lock().unwrap());
            json!({"running": true, "qr": qr(&url), "url": url})
        }
        None => json!({"running": false}),
    }
}
fn changed(app: &AppHandle) {
    let _ = app.emit("phone-changed", status(app));
}

#[tauri::command]
pub fn phone_status(app: AppHandle) -> Value {
    status(&app)
}
/// 文件互传: starts the server if needed and shows the QR code in the bubble.
#[tauri::command]
pub fn phone_start(app: AppHandle) -> Result<Value, String> {
    start(&app)
}
fn start(app: &AppHandle) -> Result<Value, String> {
    if !crate::permissions::is_enabled(app, "localNetwork") {
        let out = json!({"running": false, "permissionOff": true});
        let _ = crate::chat::show(
            app,
            json!({"mode": "phone", "phone": out, "at": now()}),
            false,
        );
        return Ok(out);
    }
    let app = app.clone();
    let mut first = false;
    {
        let phone = app.state::<Phone>();
        let mut run = phone.run.lock().unwrap();
        if run.is_none() {
            let (server, port) = (PORT..PORT + 10)
                .chain([0])
                .find_map(|p| tiny_http::Server::http(("0.0.0.0", p)).ok().map(|s| (s, p)))
                .ok_or_else(|| t("phone.cannotStart"))?;
            let port = if port == 0 {
                server.server_addr().to_ip().map(|a| a.port()).unwrap_or(0)
            } else {
                port
            };
            let (code, was) = update(&app, |s| {
                if s.code.len() != 24 {
                    s.code = rules::code();
                }
                let was = s.explained;
                s.explained = true;
                (s.code.clone(), was)
            })?;
            first = !was;
            let next = Run {
                code: Arc::new(Mutex::new(code)),
                port,
                host: lan_address(),
                stop: Arc::new(AtomicBool::new(false)),
                last: Arc::new(AtomicI64::new(now())),
            };
            server::serve(
                app.clone(),
                server,
                next.code.clone(),
                next.stop.clone(),
                next.last.clone(),
            );
            *run = Some(next);
        }
    }
    changed(&app);
    let mut out = status(&app);
    out["firstTime"] = json!(first);
    let _ = crate::chat::show(
        &app,
        json!({"mode": "phone", "phone": out, "at": now()}),
        false,
    );
    crate::tips::used(&app, "phone");
    Ok(out)
}
/// 停止接收: the server stops and anything still waiting is turned down.
#[tauri::command]
pub fn phone_stop(app: AppHandle) {
    stop(&app);
}
pub(crate) fn stop(app: &AppHandle) {
    let phone = app.state::<Phone>();
    if let Some(run) = phone.run.lock().unwrap().take() {
        run.stop.store(true, Ordering::Relaxed);
    }
    for offer in phone.offers.lock().unwrap().values_mut() {
        if offer.status == Status::Pending {
            offer.status = Status::Rejected;
        }
    }
    phone.decided.notify_all();
    changed(app);
}
/// 换一个二维码: the old address stops working at once.
#[tauri::command]
pub fn phone_renew(app: AppHandle) -> Value {
    let code = rules::code();
    let _ = update(&app, |s| s.code = code.clone());
    if let Some(run) = app.state::<Phone>().run.lock().unwrap().as_ref() {
        *run.code.lock().unwrap() = code;
    }
    changed(&app);
    status(&app)
}
/// The phone page's list, read back from the settings file the first time
/// it is needed after a start.
fn restore_sent(app: &AppHandle) {
    let phone = app.state::<Phone>();
    if !phone.outbox.restored.swap(true, Ordering::Relaxed) {
        phone
            .outbox
            .list
            .lock()
            .unwrap()
            .restore(settings(app).sent);
    }
}
/// Keeps the phone page's list in the settings file.
fn save_sent(app: &AppHandle) {
    let items = app
        .state::<Phone>()
        .outbox
        .list
        .lock()
        .unwrap()
        .items()
        .to_vec();
    let _ = update(app, |s| s.sent = items);
}

/// 发到手机: the files go on the phone page's list. With the page open on
/// the phone they show there at once; otherwise the bubble shows the code,
/// and scanning it opens the page with them on top.
#[tauri::command]
pub fn phone_send(app: AppHandle, paths: Vec<String>) -> Result<Value, String> {
    // Only files on the pet, so nothing else on the computer can be put
    // within the phone's reach.
    let staged = crate::file_transfer::staged_paths(&app);
    let files: Vec<PathBuf> = paths
        .iter()
        .filter(|p| staged.contains(p))
        .map(PathBuf::from)
        .filter(|p| p.is_file())
        .collect();
    if files.is_empty() {
        return Err(t("phone.sendNone"));
    }
    restore_sent(&app);
    let n = app.state::<Phone>().outbox.add(&files, rules::code, now());
    save_sent(&app);
    let open = page_open(&app);
    if !open {
        start(&app)?;
    }
    Ok(json!({"sent": n, "open": open}))
}
/// The phone page's list: waits up to `ms` for something newer than
/// `seen`, then gives the version and the files still there.
pub(crate) fn desk(app: &AppHandle, seen: u64, ms: u64) -> Value {
    restore_sent(app);
    let phone = app.state::<Phone>();
    phone.seen.store(now(), Ordering::Relaxed);
    let version = phone.outbox.wait(seen, ms);
    phone.seen.store(now(), Ordering::Relaxed);
    let list = phone.outbox.list.lock().unwrap();
    let items: Vec<Value> = list
        .items()
        .iter()
        .filter_map(|s| {
            let meta = std::fs::metadata(&s.path).ok().filter(|m| m.is_file())?;
            let name = s.path.file_name()?.to_string_lossy().to_string();
            // Short text files are shown on the page as they are.
            let text = (name.to_lowercase().ends_with(".txt") && meta.len() <= 8192)
                .then(|| std::fs::read_to_string(&s.path).ok())
                .flatten();
            Some(json!({"id": s.id, "at": s.at, "name": name, "size": meta.len(), "type": rules::media_type(&name), "text": text}))
        })
        .collect();
    json!({"version": version, "items": items})
}
/// Files of that list for 全部下载: these ids, or all when none is given,
/// with their names; missing files left out.
pub(crate) fn sent_files(app: &AppHandle, ids: &[&str]) -> Vec<(String, PathBuf)> {
    restore_sent(app);
    let phone = app.state::<Phone>();
    let list = phone.outbox.list.lock().unwrap();
    list.items()
        .iter()
        .filter(|s| ids.is_empty() || ids.contains(&s.id.as_str()))
        .filter(|s| s.path.is_file())
        .filter_map(|s| {
            Some((
                s.path.file_name()?.to_string_lossy().to_string(),
                s.path.clone(),
            ))
        })
        .collect()
}
/// One file of that list, by its id.
pub(crate) fn sent_file(app: &AppHandle, id: &str) -> Option<PathBuf> {
    restore_sent(app);
    let phone = app.state::<Phone>();
    let list = phone.outbox.list.lock().unwrap();
    list.get(id).map(PathBuf::from)
}

/// A phone opened the page: the bubble shows it is connected, so both sides
/// know the code worked.
pub(crate) fn hello(app: &AppHandle, device: &Device) {
    let _ = update(app, |s| visited(s, &device.id, now()));
    let _ = app.emit("phone-connected", json!({"device": device.name}));
    let _ = app.emit_to("pet", "phone-incoming", ());
}

/// The pet window sends a picture of the pet for the phone page's header.
#[tauri::command]
pub fn phone_avatar(app: AppHandle, png: Vec<u8>) {
    if png.len() < 2_000_000 {
        *app.state::<Phone>().avatar.lock().unwrap() = Some(png);
    }
}

/// A phone asks to send. Too big is refused before anything moves; a
/// trusted phone is let in, anyone else waits for the user.
pub(crate) fn offer(
    app: &AppHandle,
    device: Device,
    files: Vec<Spec>,
    text: Option<String>,
) -> Result<(String, Status), String> {
    let s = settings(app);
    let text = text
        .map(|t| t.chars().take(100_000).collect::<String>())
        .filter(|t| !t.trim().is_empty());
    if files.is_empty() && text.is_none() || files.len() > 500 {
        return Err(t("phone.nothing"));
    }
    if let Some(big) = files.iter().find(|f| f.size > s.max_mb * 1024 * 1024) {
        return Err(tf(
            "phone.tooBig",
            &[("name", &big.name), ("max", &(s.max_mb / 1024).max(1))],
        ));
    }
    let trusted = update(app, |s| visited(s, &device.id, now())).unwrap_or(false);
    let id = rules::code();
    let status = if trusted {
        Status::Accepted
    } else {
        Status::Pending
    };
    let offer = Offer {
        device,
        files,
        text,
        status,
    };
    app.state::<Phone>()
        .offers
        .lock()
        .unwrap()
        .insert(id.clone(), offer.clone());
    if trusted {
        accepted(app, &offer);
    } else {
        ask(app, &id, &offer);
    }
    Ok((id, status))
}
fn ask(app: &AppHandle, id: &str, offer: &Offer) {
    let question = json!({
        "id": id,
        "device": offer.device.name,
        "files": offer.files,
        "text": offer.text.as_ref().map(|t| t.chars().take(80).collect::<String>()),
    });
    let visible = app
        .get_webview_window("bubble")
        .is_some_and(|w| w.is_visible().unwrap_or(false));
    if visible {
        let _ = app.emit_to("bubble", "phone-offer", question);
    } else {
        let _ = crate::chat::show(
            app,
            json!({"mode": "phone-offer", "offer": question, "at": now()}),
            false,
        );
    }
    let _ = app.emit_to("pet", "phone-incoming", ());
}
/// Text is saved at once; files follow as the phone uploads them.
fn accepted(app: &AppHandle, offer: &Offer) {
    let _ = app.emit_to("pet", "phone-incoming", ());
    let Some(text) = &offer.text else { return };
    let Ok(dir) = folder(app, &settings(app)) else {
        return;
    };
    let name = format!(
        "{} {}.txt",
        t("phone.textName"),
        chrono::Local::now().format("%Y-%m-%d %H.%M.%S")
    );
    let path = rules::unique(&dir, &name);
    if std::fs::write(&path, text).is_ok() {
        arrived(app, path, true);
        let _ = crate::chat::show(
            app,
            json!({"mode": "phone-text", "text": text.chars().take(2000).collect::<String>(), "link": rules::link(text), "at": now()}),
            false,
        );
    }
}
/// Onto the pet's file pile, with its flight in.
fn arrived(app: &AppHandle, path: PathBuf, text: bool) {
    let _ = update(app, |s| {
        s.received.push(path.display().to_string());
        let excess = s.received.len().saturating_sub(5000);
        s.received.drain(..excess);
    });
    let _ = app.emit_to("pet", "phone-arrived", json!({"path": path, "text": text}));
}

/// Waits a while for the user's answer, for the phone page's long poll.
pub(crate) fn wait(app: &AppHandle, id: &str, ms: u64) -> Option<Status> {
    let phone = app.state::<Phone>();
    let offers = phone.offers.lock().unwrap();
    let (offers, _) = phone
        .decided
        .wait_timeout_while(offers, std::time::Duration::from_millis(ms), |o| {
            o.get(id).is_some_and(|x| x.status == Status::Pending)
        })
        .unwrap();
    offers.get(id).map(|o| o.status)
}

/// 收下, 不要, or 这台手机以后直接收.
#[tauri::command]
pub fn phone_answer(app: AppHandle, id: String, answer: String) -> Result<(), String> {
    let offer = {
        let phone = app.state::<Phone>();
        let mut offers = phone.offers.lock().unwrap();
        let offer = offers.get_mut(&id).ok_or_else(|| t("phone.gone"))?;
        if offer.status != Status::Pending {
            return Ok(());
        }
        offer.status = if answer == "reject" {
            Status::Rejected
        } else {
            Status::Accepted
        };
        phone.decided.notify_all();
        offer.clone()
    };
    if answer == "trust" {
        update(&app, |s| {
            if !s.trusted.iter().any(|d| d.id == offer.device.id) {
                s.trusted.push(Device {
                    seen: now(),
                    ..offer.device.clone()
                });
            }
        })?;
    }
    if offer.status == Status::Accepted {
        accepted(&app, &offer);
    }
    Ok(())
}

/// One file of an accepted offer, streamed to a hidden part file first and
/// renamed when complete, so a broken transfer leaves nothing behind.
pub(crate) fn receive(
    app: &AppHandle,
    id: &str,
    index: usize,
    body: &mut dyn std::io::Read,
    length: Option<usize>,
) -> Result<(), String> {
    let spec = {
        let phone = app.state::<Phone>();
        let offers = phone.offers.lock().unwrap();
        let offer = offers
            .get(id)
            .filter(|o| o.status == Status::Accepted)
            .ok_or_else(|| t("phone.notAccepted"))?;
        offer
            .files
            .get(index)
            .cloned()
            .ok_or_else(|| t("phone.gone"))?
    };
    let dir = folder(app, &settings(app))?;
    let path = rules::store(
        &dir,
        &format!(".{id}-{index}.part"),
        &spec.name,
        spec.size,
        body,
        length,
    )
    .map_err(|_| t("phone.broken"))?;
    arrived(app, path, false);
    Ok(())
}

/// A removal from the pet: files the phone sent go to the trash when the
/// user chose that. Nothing outside the folder is ever touched.
#[tauri::command]
pub fn phone_discard(app: AppHandle, paths: Vec<String>) {
    let Ok((ours, s)) = update(&app, |s| {
        let ours: Vec<String> = paths
            .into_iter()
            .filter(|p| s.received.contains(p))
            .collect();
        s.received.retain(|p| !ours.contains(p));
        (ours, s.clone())
    }) else {
        return;
    };
    if ours.is_empty() || s.discard != "trash" {
        return;
    }
    let Ok(dir) = folder(&app, &s) else { return };
    for path in ours.iter().map(PathBuf::from) {
        if rules::inside(&path, &dir) {
            let _ = trash::trash(&path);
        }
    }
}

#[tauri::command]
pub fn phone_settings(app: AppHandle) -> Value {
    let s = settings(&app);
    let shown = folder(&app, &s)
        .map(|p| p.display().to_string())
        .unwrap_or_default();
    json!({"settings": s, "folder": shown})
}
#[tauri::command]
pub fn phone_save_settings(app: AppHandle, settings: Settings) -> Result<Value, String> {
    update(&app, |stored| {
        let mut next = settings;
        next.received = std::mem::take(&mut stored.received);
        next.sent = std::mem::take(&mut stored.sent);
        // The page can only take phones off the list, never add one.
        next.trusted
            .retain(|d| stored.trusted.iter().any(|t| t.id == d.id));
        next.code = std::mem::take(&mut stored.code);
        next.max_mb = next.max_mb.clamp(10, 20_480);
        if next.discard != "trash" {
            next.discard = "keep".into();
        }
        *stored = next;
    })?;
    Ok(phone_settings(app))
}

/// 打开: the folder things land in, in Finder or Explorer.
#[tauri::command]
pub fn phone_open_folder(app: AppHandle) -> Result<(), String> {
    crate::reveal::open_folder(&folder(&app, &settings(&app))?)
}

/// What the server needs from the app, kept here so it stays dumb.
pub(crate) fn avatar(app: &AppHandle) -> Option<Vec<u8>> {
    app.state::<Phone>().avatar.lock().unwrap().clone()
}
pub(crate) fn idle(app: &AppHandle, last: &AtomicI64) -> bool {
    if now() - last.load(Ordering::Relaxed) > IDLE_MS {
        stop(app);
        return true;
    }
    false
}

#[cfg(test)]
mod tests {
    use super::*;

    fn phone(id: &str) -> Device {
        Device {
            id: id.into(),
            name: "iPhone".into(),
            seen: 0,
        }
    }

    #[test]
    fn a_trusted_phone_is_remembered_when_it_visits() {
        let mut s = Settings {
            trusted: vec![phone("a"), phone("b")],
            ..Settings::default()
        };
        assert!(visited(&mut s, "b", 42));
        assert_eq!(s.trusted[1].seen, 42);
        assert_eq!(s.trusted[0].seen, 0);
        // A phone not on the list is not let in by visiting.
        assert!(!visited(&mut s, "c", 43));
        assert_eq!(s.trusted.len(), 2);
    }

    #[test]
    fn changes_made_at_the_same_moment_are_all_kept() {
        // Two uploads finishing together used to read the same file, and
        // the later write dropped the earlier one's record.
        let dir = std::env::temp_dir().join(format!("suiban-phone-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = std::sync::Arc::new(dir.join("phone.json"));
        let threads: Vec<_> = (0..16)
            .map(|n| {
                let path = path.clone();
                std::thread::spawn(move || {
                    update_at(&path, |s| s.received.push(format!("/f/{n}"))).unwrap();
                })
            })
            .collect();
        for t in threads {
            t.join().unwrap();
        }
        assert_eq!(read(&path).received.len(), 16);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_stay_in_the_folder_unless_asked() {
        assert_eq!(Settings::default().discard, "keep");
        // Older settings without the field read the same way.
        let old: Settings = serde_json::from_str(r#"{"trusted":[{"id":"a","name":"x"}]}"#).unwrap();
        assert_eq!(old.discard, "keep");
        assert_eq!(old.trusted[0].seen, 0);
    }
}
