//! The phone page's server: one thread waits for requests and hands each to
//! a thread of its own (uploads and the long poll take a while). Every path
//! starts with the current code; anything else, or any address outside the
//! local network, gets nothing.
use super::{rules, Device, Spec};
use serde::Deserialize;
use serde_json::{json, Value};
use std::io::Read;
use std::sync::atomic::{AtomicBool, AtomicI64, Ordering};
use std::sync::{Arc, Mutex};
use tauri::AppHandle;
use tiny_http::{Header, Method, Request, Response, Server};

const PAGE: &str = include_str!("../../phone/index.html");
const SCRIPT: &str = include_str!("../../phone/app.js");
const STYLE: &str = include_str!("../../phone/app.css");

/// How often the computer's own address is checked while receiving.
const RECHECK_S: u32 = 5;

pub fn serve(
    app: AppHandle,
    server: Server,
    code: Arc<Mutex<String>>,
    stop: Arc<AtomicBool>,
    last: Arc<AtomicI64>,
) {
    let mut ticks = 0u32;
    std::thread::spawn(move || loop {
        if stop.load(Ordering::Relaxed) || super::idle(&app, &last) {
            break;
        }
        ticks += 1;
        if ticks % RECHECK_S == 0 {
            super::recheck_address(&app);
        }
        match server.recv_timeout(std::time::Duration::from_secs(1)) {
            Ok(Some(request)) => {
                let (app, code, last) = (app.clone(), code.lock().unwrap().clone(), last.clone());
                std::thread::spawn(move || handle(&app, request, &code, &last));
            }
            Ok(None) => {}
            Err(_) => break,
        }
    });
}

fn header(name: &str, value: &str) -> Header {
    Header::from_bytes(name.as_bytes(), value.as_bytes()).unwrap()
}
fn send(request: Request, status: u16, kind: &str, body: Vec<u8>) {
    let response = Response::from_data(body)
        .with_status_code(status)
        .with_header(header("Content-Type", kind))
        .with_header(header("Cache-Control", "no-store"))
        .with_header(header("X-Content-Type-Options", "nosniff"));
    let _ = request.respond(response);
}
fn send_json(request: Request, status: u16, value: Value) {
    send(
        request,
        status,
        "application/json; charset=utf-8",
        value.to_string().into_bytes(),
    );
}
fn fail(request: Request, status: u16, message: &str) {
    send_json(request, status, json!({"error": message}));
}

#[derive(Deserialize)]
struct OfferBody {
    device: Device,
    #[serde(default)]
    files: Vec<Spec>,
    text: Option<String>,
}

/// What a phone says about itself, cut to size.
fn trimmed(d: Device) -> Device {
    Device {
        id: d.id.chars().take(64).collect(),
        name: d.name.chars().take(40).collect(),
        seen: 0,
    }
}

fn handle(app: &AppHandle, mut request: Request, code: &str, last: &AtomicI64) {
    if !request.remote_addr().is_some_and(|a| rules::local(a.ip())) {
        return fail(request, 403, "");
    }
    let url = request.url().to_string();
    let path = url.split('?').next().unwrap_or("");
    let Some(rest) = path.strip_prefix(&format!("/t/{code}/")) else {
        return fail(request, 404, "");
    };
    last.store(crate::chat::now(), Ordering::Relaxed);
    let parts: Vec<&str> = rest.split('/').collect();
    match (request.method().clone(), parts.as_slice()) {
        (Method::Get, [""] | ["index.html"]) => {
            let pet = crate::chat::pet(app)
                .map(|p| p.1)
                .unwrap_or_else(|_| crate::locale::t("app.name"));
            let config = json!({
                "t": crate::locale::starting_with("phone.page."),
                "pet": pet,
                "lang": crate::locale::current(),
                "dateLocale": crate::locale::date_locale(),
            });
            // The config is JSON inside a script tag: no "</" can end it early.
            let config = config.to_string().replace("</", "<\\/");
            let html = PAGE
                .replace("__CONFIG__", &config)
                .replace("__LANG__", crate::locale::html_lang());
            send(request, 200, "text/html; charset=utf-8", html.into_bytes());
        }
        (Method::Get, ["app.js"]) => send(
            request,
            200,
            rules::media_type("app.js"),
            SCRIPT.as_bytes().to_vec(),
        ),
        (Method::Get, ["app.css"]) => send(
            request,
            200,
            rules::media_type("app.css"),
            STYLE.as_bytes().to_vec(),
        ),
        (Method::Get, ["manifest.webmanifest"]) => {
            let pet = crate::chat::pet(app).map(|p| p.1).unwrap_or_default();
            let manifest = json!({
                "name": crate::locale::tf("phone.page.title", &[("pet", &pet)]),
                "short_name": pet,
                "start_url": "./",
                "display": "standalone",
                "background_color": "#f6f4ef",
                "icons": [{"src": "avatar.png", "sizes": "192x192", "type": "image/png"}],
            });
            send(
                request,
                200,
                "application/manifest+json",
                manifest.to_string().into_bytes(),
            );
        }
        (Method::Get, ["avatar.png"]) => match super::avatar(app) {
            Some(png) => send(request, 200, "image/png", png),
            None => fail(request, 404, ""),
        },
        (Method::Post, ["hello"]) => {
            let mut body = String::new();
            let _ = request.as_reader().take(4096).read_to_string(&mut body);
            let device = serde_json::from_str::<Value>(&body)
                .ok()
                .and_then(|v| serde_json::from_value::<Device>(v["device"].clone()).ok())
                .map(trimmed)
                .unwrap_or(Device {
                    id: String::new(),
                    name: String::new(),
                    seen: 0,
                });
            super::hello(app, &device);
            send_json(request, 200, json!({"ok": true}));
        }
        (Method::Post, ["offer"]) => {
            let mut body = String::new();
            if request
                .as_reader()
                .take(512 * 1024)
                .read_to_string(&mut body)
                .is_err()
            {
                return fail(request, 400, "");
            }
            let Ok(offer) = serde_json::from_str::<OfferBody>(&body) else {
                return fail(request, 400, "");
            };
            match super::offer(app, trimmed(offer.device), offer.files, offer.text) {
                Ok((id, status)) => send_json(request, 200, json!({"id": id, "status": status})),
                Err(message) => fail(request, 413, &message),
            }
        }
        (Method::Get, ["offer", id]) => match super::wait(app, id, 25_000) {
            Some(status) => send_json(request, 200, json!({"status": status})),
            None => fail(request, 404, ""),
        },
        (Method::Put, ["file", id, index]) => {
            let Ok(index) = index.parse::<usize>() else {
                return fail(request, 400, "");
            };
            let length = request.body_length();
            let id = id.to_string();
            match super::receive(app, &id, index, request.as_reader(), length) {
                Ok(()) => send_json(request, 200, json!({"ok": true})),
                Err(message) => fail(request, 409, &message),
            }
        }
        (Method::Get, ["desk"]) => {
            // ?v=N waits for something newer than N (the long poll); none
            // answers at once.
            let query = url.split_once('?').map(|q| q.1).unwrap_or("");
            let seen = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("v="))
                .and_then(|v| v.parse::<u64>().ok());
            let value = match seen {
                Some(v) => super::desk(app, v, 25_000),
                None => super::desk(app, 0, 0),
            };
            send_json(request, 200, value);
        }
        // 全部下载: one zip, streamed as it is made.
        (Method::Get, ["desk", "all.zip"]) => {
            let query = url.split_once('?').map(|q| q.1).unwrap_or("");
            let ids: Vec<&str> = query
                .split('&')
                .find_map(|kv| kv.strip_prefix("ids="))
                .map(|v| v.split(',').filter(|s| !s.is_empty()).collect())
                .unwrap_or_default();
            let files = super::sent_files(app, &ids);
            let total: u64 = files
                .iter()
                .filter_map(|(_, p)| std::fs::metadata(p).ok())
                .map(|m| m.len())
                .sum();
            if files.is_empty() || total > super::zip::LIMIT {
                return fail(request, 413, &crate::locale::t("phone.zipTooBig"));
            }
            let Ok((reader, mut writer)) = std::io::pipe() else {
                return fail(request, 500, "");
            };
            std::thread::spawn(move || {
                let _ = super::zip::write(&mut writer, &files);
            });
            let pet = crate::chat::pet(app).map(|p| p.1).unwrap_or_default();
            let name = crate::locale::tf("phone.zipName", &[("pet", &pet)]);
            let response = Response::new(
                tiny_http::StatusCode(200),
                vec![
                    header("Content-Type", "application/zip"),
                    header("Cache-Control", "no-store"),
                    header("Content-Disposition", &rules::disposition(&name)),
                ],
                reader,
                None,
                None,
            );
            let _ = request.respond(response);
        }
        (Method::Get, ["desk", id]) => {
            let Some(path) = super::sent_file(app, id) else {
                return fail(request, 404, "");
            };
            let Ok(file) = std::fs::File::open(&path) else {
                return fail(request, 404, "");
            };
            let name = path
                .file_name()
                .map(|n| n.to_string_lossy().to_string())
                .unwrap_or_default();
            let inline = url.contains("view=1");
            let response = Response::from_file(file)
                .with_header(header("Content-Type", rules::media_type(&name)))
                .with_header(header("Cache-Control", "no-store"))
                .with_header(header(
                    "Content-Disposition",
                    &if inline {
                        "inline".into()
                    } else {
                        rules::disposition(&name)
                    },
                ));
            let _ = request.respond(response);
        }
        _ => fail(request, 404, ""),
    }
}
