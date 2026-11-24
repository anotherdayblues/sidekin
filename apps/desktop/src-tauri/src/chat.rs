use crate::locale::t;
use crate::{
    attachments, attachments::AttachedFile, brain, companion::Companion, history, library, State,
};
use serde_json::{json, Value};
use std::{
    sync::Mutex,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Emitter, LogicalSize, Manager, WebviewUrl, WebviewWindowBuilder};
#[derive(Default)]
pub struct Chat {
    pub intent: Mutex<Option<Value>>,
    active: Mutex<Option<(String, String, Value)>>,
}
pub fn now() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}
pub fn ensure(app: &AppHandle) -> Result<(), String> {
    if app.get_webview_window("bubble").is_none() {
        WebviewWindowBuilder::new(app, "bubble", WebviewUrl::App("index.html?bubble".into()))
            .incognito(cfg!(any(feature = "acceptance", feature = "trial")))
            .title(t("host.titleChat"))
            .accept_first_mouse(true)
            .transparent(true)
            .decorations(false)
            .shadow(false)
            .always_on_top(true)
            .skip_taskbar(true)
            .resizable(false)
            .visible(false)
            .focused(false)
            .inner_size(320., 140.)
            .build()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[path = "bubble_position.rs"]
mod bubble_position;
pub use bubble_position::place;
pub fn show(app: &AppHandle, intent: Value, focus: bool) -> Result<(), String> {
    ensure(app)?;
    let w = app.get_webview_window("bubble").ok_or("disabled")?;
    *app.state::<Chat>().intent.lock().unwrap() = Some(intent.clone());
    if crate::clipboard::active(app) {
        crate::clipboard::keep_underlay(app, focus);
        return app
            .emit_to("bubble", "bubble-open", intent)
            .map_err(|e| e.to_string());
    }
    place(app)?;
    w.set_focusable(focus).map_err(|e| e.to_string())?;
    w.show().map_err(|e| e.to_string())?;
    crate::window_memory::shown(&w);
    if focus {
        w.set_focus().map_err(|e| e.to_string())?;
    }
    app.emit_to("bubble", "bubble-open", intent)
        .map_err(|e| e.to_string())
}
#[tauri::command]
pub fn open_chat(app: AppHandle, from_pet: Option<bool>) -> Result<(), String> {
    if from_pet == Some(true) {
        if let Some(bubble) = app.get_webview_window("bubble") {
            if bubble.is_visible().map_err(|e| e.to_string())? {
                return app
                    .emit_to("bubble", "bubble-pet-click", ())
                    .map_err(|e| e.to_string());
            }
        }
    }
    crate::selection::invalidate();
    // With the chat window open, the chat shortcut goes there instead of a bubble.
    if let Some(w) = app.get_webview_window("chat") {
        if w.is_visible().unwrap_or(false) {
            return w.set_focus().map_err(|e| e.to_string());
        }
    }
    show(&app, json!({"mode":"input","at":now()}), true)
}
/// A bubble shown without focus (a translation) takes the keyboard once the
/// user goes to type in it.
#[tauri::command]
pub fn focus_bubble(app: AppHandle) -> Result<(), String> {
    let w = app.get_webview_window("bubble").ok_or("disabled")?;
    w.set_focusable(true).map_err(|e| e.to_string())?;
    w.set_focus().map_err(|e| e.to_string())
}
#[tauri::command]
pub fn bubble_intent(app: AppHandle) -> Option<Value> {
    app.state::<Chat>().intent.lock().unwrap().clone()
}
#[tauri::command]
pub fn hide_bubble(app: AppHandle) -> Result<(), String> {
    if crate::clipboard::active(&app) {
        return Ok(());
    }
    crate::selection::invalidate();
    *app.state::<Chat>().intent.lock().unwrap() = None;
    if let Some(w) = app.get_webview_window("bubble") {
        w.hide().map_err(|e| e.to_string())?;
        crate::window_memory::hidden(&w);
    }
    Ok(())
}
#[tauri::command]
pub fn size_bubble(app: AppHandle, width: f64, height: f64) -> Result<(), String> {
    if crate::clipboard::active(&app) {
        return Ok(());
    }
    if let Some(w) = app.get_webview_window("bubble") {
        w.set_size(LogicalSize::new(
            // 待办's cards are wider than a chat line (plan/27, roomier in
            // plan/30).
            width.clamp(240., 460.),
            height.clamp(40., 650.),
        ))
        .map_err(|e| e.to_string())?;
        place(&app)?;
    }
    Ok(())
}
/// Whether a chat turn is running now.
pub fn answering(app: &AppHandle) -> bool {
    app.state::<Chat>().active.lock().unwrap().is_some()
}
pub fn pet(app: &AppHandle) -> Result<(String, String, String), String> {
    let s = app.state::<State>();
    let id = s
        .settings
        .lock()
        .unwrap()
        .active_id
        .clone()
        .ok_or(t("host.pickPet"))?;
    let p = library::pet(&s.root, &id)?;
    Ok((id, p.display_name, p.description))
}
pub fn notify(app: &AppHandle, method: &str, params: &Value) {
    if method == "chat.steps" {
        if let Some((token, _, steps)) = app.state::<Chat>().active.lock().unwrap().as_mut() {
            if params["token"] == *token {
                *steps = params["steps"].clone();
            }
        }
    }
    if method == "chat.rewind" {
        if let Some((token, text, _)) = app.state::<Chat>().active.lock().unwrap().as_mut() {
            if params["token"] == *token {
                *text = params["text"].as_str().unwrap_or("").into();
            }
        }
    }
    if method == "chat.delta" {
        let state = app.state::<Chat>();
        let mut job = state.active.lock().unwrap();
        if let Some((token, text, _)) = job.as_mut() {
            if params["token"] == *token {
                if let Some(delta) = params["delta"].as_str() {
                    text.push_str(delta);
                }
            }
        }
    }
    if method == "approval.ask" {
        let _ = show(
            app,
            json!({"mode":"authorization","request":params,"at":now()}),
            true,
        );
        let _ = app.emit_to("pet", "companion-motion", json!({"kind":"authorization"}));
    }
    if method == "crash" {
        crate::snip::clear(app);
        let _ = show(
            app,
            json!({"mode":"error","reason":"crash","at":now()}),
            false,
        );
    }
}
#[tauri::command]
pub async fn send_chat(
    app: AppHandle,
    token: String,
    text: String,
    at: i64,
    image: Option<String>,
    files: Option<Vec<AttachedFile>>,
    force_search: Option<bool>,
    screenshot: Option<u64>,
    screenshot_topic: Option<i64>,
) -> Result<Value, String> {
    if text.trim().is_empty() {
        return Err(t("host.enterMessage").into());
    }
    let (image, files, picture) = if let Some(generation) = screenshot {
        let (can_see, files, picture) = crate::snip_card::chat_input(&app, generation)?;
        (can_see.then(|| picture.part()), files, Some(picture))
    } else {
        let picture = image
            .map(|data| crate::chat_window::attached_picture(&data))
            .transpose()?;
        (
            picture.as_ref().map(|p| p.part()),
            files.unwrap_or_default(),
            picture,
        )
    };
    // The record keeps a marker, so later turns know a picture or file was shown.
    let file_mark = if files.is_empty() {
        String::new()
    } else {
        let names: Vec<_> = files.iter().map(|f| f.name.as_str()).collect();
        format!("［文件：{}］", names.join("、"))
    };
    let stored = format!(
        "{}{file_mark}{text}",
        if screenshot.is_some() {
            "［截图］"
        } else if image.is_some() {
            "［图片］"
        } else {
            ""
        }
    );
    let client = app.state::<Companion>().client()?;
    let (pet, name, desc) = pet(&app)?;
    {
        let state = app.state::<Chat>();
        let mut active = state.active.lock().unwrap();
        if active.is_some() {
            return Err(t("chat.stopFirst").into());
        }
        *active = Some((token.clone(), String::new(), json!([])));
    }
    let _ = app.emit_to(
        "pet",
        "companion-motion",
        json!({"kind":"thinking","at":at}),
    );
    let runtime = app.clone();
    let turn_pet = pet.clone();
    // For 上手引导: what this turn showed the pet, kept before `turn` moves.
    let shown = (
        text.clone(),
        image.is_some() && screenshot.is_none(),
        files.iter().map(crate::tips::file_hash).collect::<Vec<_>>(),
    );
    let turn = Turn {
        token,
        pet,
        name,
        desc,
        stored,
        text,
        files: attachments::bounded(files),
        screenshot: screenshot.is_some(),
        screenshot_topic,
        picture,
        image,
        force_search: force_search.unwrap_or(false),
    };
    let answer = tauri::async_runtime::spawn_blocking(move || run(&runtime, client, turn))
        .await
        .unwrap_or_else(|_| Err("crash".into()));
    app.state::<Chat>().active.lock().unwrap().take();
    let kind = if answer.as_ref().err().is_some_and(|e| e != "stopped") {
        "error"
    } else {
        "idle"
    };
    let mut motion = json!({"kind":kind});
    // An action the answer picked plays once it is done, on the same pet.
    if let Some(pick) = answer.as_ref().ok().and_then(|v| v.get("petAction")) {
        if kind == "idle" && crate::chat::pet(&app).is_ok_and(|p| p.0 == turn_pet) {
            let root = app.state::<State>().root.clone();
            if let Some(play) = crate::pet_action::after_answer(&root, &turn_pet, pick, now()) {
                motion["action"] = play["action"].clone();
                motion["sleep"] = play["sleep"].clone();
            }
        }
    }
    let _ = app.emit_to("pet", "companion-motion", motion);
    let _ = app.emit("chat-updated", ());
    if answer.is_ok() {
        let search_ready = app
            .state::<Companion>()
            .settings
            .lock()
            .unwrap()
            .search
            .is_some();
        crate::tips::after_turn(
            &app,
            crate::tips::Turn {
                text: &shown.0,
                image: shown.1,
                files: &shown.2,
                search_ready,
            },
        );
    }
    answer
}
/// One chat turn, as sent from the chat window or the bubble.
struct Turn {
    token: String,
    pet: String,
    name: String,
    desc: String,
    /// What the history keeps: the text with its picture and file marks.
    stored: String,
    text: String,
    files: Vec<AttachedFile>,
    image: Option<Value>,
    force_search: bool,
    picture: Option<crate::chat_images::Picture>,
    screenshot: bool,
    screenshot_topic: Option<i64>,
}

/// Records the turn, asks the brain, and saves the answer.
fn run(runtime: &AppHandle, client: brain::Client, turn: Turn) -> Result<Value, String> {
    let state = runtime.state::<Companion>();
    let _lease = state.host.lease(&turn.token, &turn.pet)?;
    let target = match (turn.screenshot, turn.screenshot_topic) {
        (true, Some(id)) => history::TopicTarget::Selected(id),
        (true, None) => history::TopicTarget::New,
        _ => history::TopicTarget::Current,
    };
    let (id, previous) = history::begin_topic_turn(
        &state.dir,
        &turn.pet,
        &turn.stored,
        now(),
        target,
        turn.picture.as_ref(),
    )
    .map_err(|e| match e {
        rusqlite::Error::QueryReturnedNoRows => t("host.topicGone"),
        _ => t("host.historyWrite"),
    })?;
    state.host.bind_turn(&turn.token, id)?;
    if !turn.files.is_empty() {
        history::save_files(&state.dir, id, &turn.files).map_err(|_| t("host.historyWrite"))?;
    }
    let settings = state.settings.lock().unwrap().clone();
    let (prompt, topic) = context(runtime, &settings, id, previous, &turn)?;
    let result = client.call("chat", prompt);
    let (partial, mut steps) = runtime
        .state::<Chat>()
        .active
        .lock()
        .unwrap()
        .as_ref()
        .map(|x| (x.1.clone(), x.2.clone()))
        .unwrap_or_default();
    let answer = result
        .as_ref()
        .ok()
        .and_then(|v| v["text"].as_str())
        .unwrap_or(&partial);
    if let Some(items) = steps.as_array_mut() {
        for step in items {
            if step["status"] == "running" {
                step["status"] = json!("failed");
                step["reason"] = json!(t("host.interrupted"));
            }
        }
    }
    if let Some(answers) = result.as_ref().ok().and_then(|v| v["answers"].as_array()) {
        let mut full = turn.stored.clone();
        for a in answers {
            if let (Some(q), Some(v)) = (a["question"].as_str(), a["answer"].as_str()) {
                full.push_str(&format!("\n栗子问：{q}\n我的回答：{v}"));
            }
        }
        if full != turn.stored {
            history::open(&state.dir)
                .and_then(|db| {
                    db.execute(
                        "UPDATE turns SET question=? WHERE id=?",
                        rusqlite::params![full, id],
                    )
                })
                .map_err(|_| t("host.choiceSave"))?;
        }
    }
    let sources = result.as_ref().ok().and_then(|v| v.get("sources"));
    history::finish_with_tools(
        &state.dir,
        id,
        answer,
        sources,
        result
            .as_ref()
            .ok()
            .and_then(|v| v.get("steps"))
            .or(Some(&steps)),
    )
    .map_err(|_| t("host.answerSave"))?;
    if result.is_ok() && settings.memory {
        schedule_review(&state, client, &turn.pet, id);
    }
    result.map(|mut value| {
        value["turnId"] = json!(id);
        value["topicId"] = json!(topic);
        value
    })
}

/// What the brain gets for one turn, and the topic it belongs to.
fn context(
    runtime: &AppHandle,
    settings: &crate::companion::Settings,
    id: i64,
    previous: Vec<history::Turn>,
    turn: &Turn,
) -> Result<(Value, i64), String> {
    let state = runtime.state::<Companion>();
    let root = &runtime.state::<State>().root;
    let web_urls = if settings.search.is_some() || settings.follow_search {
        Some(history::urls(&state.dir, id).map_err(|_| t("host.sourcesRead"))?)
    } else {
        None
    };
    let personality = crate::persona::get(&state.dir, &turn.pet, &turn.desc)?;
    let books = crate::memory::read(&state.dir, &turn.pet)?;
    let memory = |text: String| if settings.memory { text } else { String::new() };
    let current = json!({"personality":personality,"profile":books.profile,"user":memory(books.user_text()),"notes":memory(books.notes_text())});
    let frozen = history::snapshot(&state.dir, id, &current.to_string())
        .map_err(|_| t("host.topicDataRead"))?;
    let frozen: Value = serde_json::from_str(&frozen).map_err(|_| t("host.topicDataBad"))?;
    let catalog = crate::documents::catalog(&state.host.library)?;
    let (topic, note) =
        history::topic_and_note(&state.dir, id).map_err(|_| t("host.topicNoteRead"))?;
    let mut servers = json!(state.host.external.config().enabled);
    servers
        .as_array_mut()
        .unwrap()
        .extend(crate::tool_cards::servers(root)?);
    let section = |key: &str| frozen[key].as_str().unwrap_or("").to_owned();
    let mut prompt = json!({"text":turn.text,"topic":topic,"webUrls":web_urls,"timeNote":note,"token":turn.token,"history":previous,"mcpServers":servers,"remindersEnabled":settings.reminders,
        "memoryEnabled":settings.memory,"libraryEnabled":true,"sections":{"profile":section("profile"),"user":memory(section("user")),"notes":memory(section("notes")),"catalog":catalog},
        "pet":{"displayName":turn.name,"description":turn.desc,"personality":frozen["personality"]}});
    prompt["forceSearch"] = json!(turn.force_search);
    prompt["petActions"] = json!(crate::pet_action::choices(root, &turn.pet));
    if !turn.files.is_empty() {
        prompt["files"] = json!(turn.files);
    }
    if let Some(voice) = crate::voice::config(&state.dir, false) {
        prompt["speak"] = voice;
    }
    if let Some(image) = &turn.image {
        prompt["image"] = image.clone();
        prompt["imageSource"] = if turn.screenshot { "snip" } else { "upload" }.into();
    }
    Ok((prompt, topic))
}
#[tauri::command]
pub async fn answer_question(
    app: AppHandle,
    token: String,
    id: String,
    answer: String,
) -> Result<Value, String> {
    let client = app.state::<Companion>().client()?;
    tauri::async_runtime::spawn_blocking(move || {
        client.call(
            "answer_question",
            json!({"token":token,"id":id,"answer":answer}),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
pub fn busy(app: &AppHandle) -> bool {
    app.state::<Chat>().active.lock().unwrap().is_some()
}
fn schedule_review(state: &Companion, client: brain::Client, pet: &str, id: i64) {
    if !crate::usage::allowed(&state.dir, state.settings.lock().unwrap().daily_limit) {
        return;
    }
    let turns = match history::review_due(&state.dir, pet) {
        Ok(Some(turns)) => turns,
        Ok(None) => return,
        Err(_) => {
            brain::log(&state.dir.join("logs"), "memory review unavailable");
            return;
        }
    };
    let host = state.host.clone();
    let dir = state.dir.clone();
    let pet = pet.to_owned();
    std::thread::spawn(move || {
        if !host.memory.load(std::sync::atomic::Ordering::Acquire) {
            return;
        }
        let token = format!("review-{id}");
        let Ok(_lease) = host.lease(&token, &pet) else {
            return;
        };
        let Ok(books) = crate::memory::read(&dir, &pet) else {
            return;
        };
        let prompt = json!({"text":"回顾这六轮对话。","token":token,"memoryEnabled":true,"sections":{"profile":books.profile,"user":books.user_text(),"notes":books.notes_text()},"history":turns});
        let _ = client.call("review", prompt);
    });
}
#[tauri::command]
pub async fn cancel_chat(app: AppHandle, token: String) -> Result<(), String> {
    let c = app.state::<Companion>().client()?;
    tauri::async_runtime::spawn_blocking(move || c.call("cancel", json!({"id":token})))
        .await
        .map_err(|e| e.to_string())??;
    Ok(())
}
#[tauri::command]
pub fn new_topic(app: AppHandle) -> Result<(), String> {
    if app.state::<Chat>().active.lock().unwrap().is_some() {
        return Err(t("chat.stopFirst").into());
    }
    history::close(&app.state::<Companion>().dir, &pet(&app)?.0).map_err(|e| e.to_string())?;
    let _ = app.emit("chat-updated", ());
    Ok(())
}
#[tauri::command]
pub fn chat_history(app: AppHandle) -> Result<Vec<history::Turn>, String> {
    history::list(&app.state::<Companion>().dir, &pet(&app)?.0).map_err(|e| e.to_string())
}
#[tauri::command]
pub fn companion_timing(app: AppHandle, kind: String, at: i64) {
    if ["reaction", "translate-visible"].contains(&kind.as_str()) {
        let ms = now() - at;
        if (0..60000).contains(&ms) {
            brain::log(
                &app.state::<Companion>().dir.join("logs"),
                &format!("{kind} {ms} ms"),
            );
        }
    }
}
#[tauri::command]
pub fn open_companion_page(
    app: AppHandle,
    history: bool,
    section: Option<String>,
) -> Result<(), String> {
    crate::open_studio(app.clone())?;
    if let Some(id) = section.filter(|s| matches!(s.as_str(), "online" | "tools")) {
        crate::studio_window::emit(&app, "settings-section", id);
        return Ok(());
    }
    crate::studio_window::emit(&app, "companion-open", history);
    Ok(())
}

#[tauri::command]
pub fn open_bubble_link(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| t("host.badLink"))?;
    if !matches!(parsed.scheme(), "http" | "https") || parsed.host().is_none() {
        return Err(t("host.webOnly").into());
    }
    #[cfg(target_os = "macos")]
    let mut launch = std::process::Command::new("/usr/bin/open");
    #[cfg(windows)]
    let mut launch = {
        let mut p = std::process::Command::new("rundll32.exe");
        p.arg("url.dll,FileProtocolHandler");
        p
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut launch = std::process::Command::new("xdg-open");
    launch
        .arg(parsed.as_str())
        .spawn()
        .map_err(|_| t("host.noBrowser"))?;
    Ok(())
}
