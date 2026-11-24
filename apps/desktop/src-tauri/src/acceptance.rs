//! This module is compiled only with the explicit acceptance feature. The capture
//! source is the fixture window itself, even if another app covers that window.
use base64::{engine::general_purpose::STANDARD, Engine};
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};
use xcap::Monitor;
fn workspace() -> Result<PathBuf, String> {
    let runs = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../runs")
        .canonicalize()
        .map_err(|_| "缺少 runs")?;
    let dir = std::env::var_os("QA")
        .map(PathBuf::from)
        .and_then(|p| p.canonicalize().ok())
        .ok_or("需要独立验收目录")?;
    if dir.parent() != Some(runs.as_path())
        || !dir
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with("companion-456."))
        || dir.join("STOP").exists()
    {
        return Err("验收目录无效或已停止".into());
    }
    Ok(dir)
}
pub fn data_root(app: &AppHandle) -> Result<PathBuf, String> {
    if app.config().identifier != "studio.pet.companion.qa456"
        || !app.config().app.windows.iter().all(|w| w.incognito)
    {
        return Err("验收需要独立应用标识和非持久化窗口".into());
    }

    let case = std::env::var("QA_CASE").map_err(|_| "缺少验收编号")?;
    if case.is_empty() || !case.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
        return Err("无效验收编号".into());
    }
    Ok(workspace()?.join(case))
}
#[cfg(target_os = "macos")]
fn window_pixels(window: &WebviewWindow) -> Result<image::RgbaImage, String> {
    use std::ffi::c_void;
    unsafe extern "C" {
        fn qa_window_png(window: *mut c_void, bytes: *mut *mut u8) -> usize;
        fn companion_free(bytes: *mut std::ffi::c_char);
    }
    if !crate::snip::screen_access() {
        return Err("screenPermission".into());
    }
    let mut ptr = std::ptr::null_mut();
    let count =
        unsafe { qa_window_png(window.ns_window().map_err(|_| "无测试窗口")?, &mut ptr) };
    if ptr.is_null() || count == 0 {
        return Err("无法采样测试窗口".into());
    }
    let image = image::load_from_memory(unsafe { std::slice::from_raw_parts(ptr, count) })
        .map(|im| im.to_rgba8())
        .map_err(|_| "测试像素无效".into());
    unsafe {
        companion_free(ptr.cast());
    }
    image
}
#[cfg(not(target_os = "macos"))]
fn window_pixels(_: &WebviewWindow) -> Result<image::RgbaImage, String> {
    Err("此隔离取样器在 Mac 上运行".into())
}
pub fn capture_fixture(
    app: &AppHandle,
    m: &Monitor,
    (x, y, w, h): (u32, u32, u32, u32),
) -> Result<image::RgbaImage, String> {
    let window = app
        .get_webview_window("fixture")
        .ok_or("缺少专用测试窗口")?;
    let pos = window.outer_position().map_err(|_| "测试窗口位置无效")?;
    let scale = window.scale_factor().map_err(|_| "测试缩放无效")?;
    let image = window_pixels(&window)?;
    let local = |v: i32, p: i32| ((v as f64 * scale).round() as i64) - i64::from(p);
    let left = local(m.x().map_err(|_| "无显示器")? + x as i32, pos.x);
    let top = local(m.y().map_err(|_| "无显示器")? + y as i32, pos.y);
    let width = (w as f64 * scale).round() as u32;
    let height = (h as f64 * scale).round() as u32;
    if left < 0
        || top < 0
        || width == 0
        || height == 0
        || left + width as i64 > image.width() as i64
        || top + height as i64 > image.height() as i64
    {
        return Err("选区超出测试画面".into());
    }
    Ok(image::imageops::crop_imm(&image, left as u32, top as u32, width, height).to_image())
}
pub fn launch(app: &AppHandle) -> Result<(), String> {
    let root = workspace()?;
    let win =
        WebviewWindowBuilder::new(app, "fixture", WebviewUrl::App("index.html?fixture".into()))
            .incognito(true)
            .title("随伴 QA 测试图")
            .visible(false)
            .focused(false)
            .skip_taskbar(true)
            .decorations(false)
            .position(80., 100.)
            .inner_size(900., 260.)
            .build()
            .map_err(|_| "测试窗口创建失败")?;
    let asset = STANDARD.encode(include_bytes!(
        "../../../../tests/fixtures/desktop-capture-sample.png"
    ));
    let app = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(std::time::Duration::from_secs(1));
        let _=win.eval(format!("document.body.innerHTML='<img style=\"width:100vw;height:100vh;display:block\" src=\"data:image/png;base64,{asset}\">'"));
        // Private file mailbox: test-only commands cannot select any foreign window or arbitrary region.
        let request = root.join("command.json");
        let reply = root.join("result.json");
        loop {
            if root.join("STOP").exists() {
                app.exit(1);
                break;
            }
            if let Ok(data) = std::fs::read(&request) {
                if let Ok(msg) = serde_json::from_slice::<serde_json::Value>(&data) {
                    let _ = std::fs::remove_file(&request);
                    let result = run_step(&app, &root, &msg).map_err(|e| e.to_string());
                    if let Ok(data) = serde_json::to_vec(&result) {
                        let tmp = root.join("reply.tmp");
                        if std::fs::write(&tmp, data).is_ok() {
                            let _ = std::fs::rename(tmp, &reply);
                        }
                    }
                }
            }
            std::thread::sleep(std::time::Duration::from_millis(25));
        }
    });
    Ok(())
}
fn run_step(
    app: &AppHandle,
    root: &Path,
    msg: &serde_json::Value,
) -> Result<serde_json::Value, String> {
    use serde_json::{json, Value};
    let label = msg["window"].as_str().unwrap_or("bubble");
    if !["fixture", "studio", "pet", "bubble"].contains(&label) {
        return Err("仅允许指定测试窗口".into());
    }
    match msg["op"].as_str() {
        #[cfg(target_os = "macos")]
        Some("clipboard-fixture") => {
            extern "C" {
                fn clip_fixture_copy(value: *const std::ffi::c_char, concealed: i32);
                fn companion_target() -> isize;
            }
            let value = std::ffi::CString::new(msg["text"].as_str().ok_or("missing fixture text")?)
                .map_err(|_| "invalid fixture")?;
            if let Some(ms) = msg["copyKeyAt"].as_u64() {
                let state = app.state::<crate::companion::Companion>();
                // No supervisor or model is started. Only the gesture recognizer is enabled.
                let mut s = state.settings.lock().unwrap();
                s.enabled = true;
                s.translation = true;
                s.copy_twice = true;
                crate::copy_twice::companion_copy_press(
                    ms,
                    unsafe { companion_target() },
                    crate::copy_twice::count(),
                );
            }
            unsafe {
                clip_fixture_copy(
                    value.as_ptr(),
                    msg["concealed"].as_bool().unwrap_or(false).into(),
                )
            };
            Ok(Value::Null)
        }
        #[cfg(target_os = "macos")]
        Some("clipboard-fixture-content") => Ok(json!(crate::clipboard::fixture_contents())),
        Some("fixture-windows") => Ok(json!(app
            .webview_windows()
            .keys()
            .cloned()
            .collect::<Vec<_>>())),
        Some("quit") => {
            app.exit(0);
            Ok(Value::Null)
        }
        Some("show-capture-sample") => {
            let window = app
                .get_webview_window("fixture")
                .ok_or("缺少专用测试窗口")?;
            window.show().map_err(|e| e.to_string())?;
            Ok(Value::Null)
        }
        Some("hide-capture-sample") => {
            if let Some(window) = app.get_webview_window("fixture") {
                window.hide().map_err(|e| e.to_string())?;
            }
            Ok(Value::Null)
        }
        Some("capture-sample-visible") => {
            let window = app
                .get_webview_window("fixture")
                .ok_or("缺少专用测试窗口")?;
            Ok(json!(window.is_visible().map_err(|e| e.to_string())?))
        }
        Some("snip") => {
            crate::snip::start(app.clone());
            Ok(Value::Null)
        }
        Some("select") => {
            let win = app.get_webview_window("fixture").ok_or("缺少测试窗口")?;
            let position = win.outer_position().map_err(|_| "测试窗口不可用")?;
            let scale = win.scale_factor().map_err(|_| "无缩放")?;
            let gx = (position.x as f64 / scale).round() as i32;
            let gy = (position.y as f64 / scale).round() as i32;
            let monitor = Monitor::from_point(gx + 1, gy + 1).map_err(|_| "无显示器")?;
            let id = monitor.id().map_err(|_| "无显示器")?;
            let mw = monitor.width().map_err(|_| "无尺寸")? as f64;
            let mh = monitor.height().map_err(|_| "无尺寸")? as f64;
            let x = (gx - monitor.x().map_err(|_| "无位置")?) as f64;
            let y = (gy - monitor.y().map_err(|_| "无位置")?) as f64;
            let overlay = app
                .webview_windows()
                .into_iter()
                .find(|(k, _)| k.starts_with("snip-") && k.ends_with(&format!("-{id}")))
                .ok_or("框选窗口未就绪")?;
            let g = overlay
                .0
                .split('-')
                .nth(1)
                .and_then(|g| g.parse::<u64>().ok())
                .ok_or("无会话")?;
            let region = serde_json::from_value(
                json!({"left":(x+2.)/mw,"top":(y+2.)/mh,"right":(x+898.)/mw,"bottom":(y+258.)/mh}),
            )
            .map_err(|_| "无效选区")?;
            tauri::async_runtime::block_on(crate::snip::finish_snip(
                app.clone(),
                overlay.1,
                g,
                region,
            ))?;
            Ok(Value::Null)
        }
        Some("eval") => {
            use tauri::Listener;
            let w = app.get_webview_window(label).ok_or("测试窗口未就绪")?;
            let (tx, rx) = std::sync::mpsc::channel();
            let event = format!(
                "qa-result-{}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            );
            let listener = app.once(&event, move |e| {
                let _ = tx.send(e.payload().to_owned());
            });
            let script = msg["script"].as_str().ok_or("缺少脚本")?;
            let code=format!("(async()=>{{let payload;try{{payload={{ok:true,value:await(async()=>{{{script}}})()}};}}catch{{payload={{ok:false}};}}await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{{event:'{event}',payload}});}})()");
            w.eval(code).map_err(|_| "测试脚本失败")?;
            let result = rx.recv_timeout(std::time::Duration::from_secs(15));
            app.unlisten(listener);
            let result: Value = serde_json::from_str(&result.map_err(|_| "验收窗口没有应答")?)
                .map_err(|_| "无效结果")?;
            if result["ok"] != true {
                return Err("测试窗口操作失败".into());
            }
            Ok(result["value"].clone())
        }
        Some("frame") => {
            let name = msg["name"].as_str().ok_or("缺少名称")?;
            if !name.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
                return Err("文件名无效".into());
            }
            let w = app.get_webview_window(label).ok_or("无测试窗口")?;
            window_pixels(&w)?
                .save(root.join(format!("{name}.png")))
                .map_err(|_| "记录失败")?;
            Ok(Value::Null)
        }
        Some("intent") => Ok(crate::chat::bubble_intent(app.clone()).unwrap_or(Value::Null)),
        _ => Err("未知验收操作".into()),
    }
}
