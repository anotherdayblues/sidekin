//! Only Rust assigns tool calls to a pet and a live turn. Model arguments cannot
//! select a different pet, data directory or permission set.
use crate::{history, memory};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::PathBuf,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
pub struct Host {
    dir: PathBuf,
    pub library: PathBuf,
    pub external: crate::external::External,
    scopes: Mutex<HashMap<String, (String, Option<i64>)>>,
    pub recent_write: Mutex<memory::RecentWrite>,
    pub memory: AtomicBool,
    pub search_limit: std::sync::atomic::AtomicU64,
    pub daily_limit: std::sync::atomic::AtomicU64,
    pub reminders: AtomicBool,
    pub alarm: Arc<crate::reminders::Alarm>,
    /// For the tools that drive the app itself (the 番茄钟), set at start.
    pub app: std::sync::OnceLock<tauri::AppHandle>,
}
pub struct Lease {
    host: Arc<Host>,
    token: String,
}
impl Drop for Lease {
    fn drop(&mut self) {
        self.host.scopes.lock().unwrap().remove(&self.token);
        self.host.external.cancel(&self.token);
    }
}
impl Host {
    pub fn new(dir: PathBuf, library: PathBuf) -> Result<Self, String> {
        Ok(Self {
            library,
            external: crate::external::External::open(&dir)?,
            dir,
            scopes: Mutex::new(HashMap::new()),
            recent_write: Default::default(),
            search_limit: 20.into(),
            daily_limit: Default::default(),
            memory: AtomicBool::new(false),
            reminders: AtomicBool::new(false),
            alarm: Arc::default(),
            app: Default::default(),
        })
    }
    pub fn lease(self: &Arc<Self>, token: &str, pet: &str) -> Result<Lease, String> {
        let mut scopes = self.scopes.lock().unwrap();
        if scopes.contains_key(token) {
            return Err("重复的请求编号".into());
        }
        scopes.insert(token.to_owned(), (pet.to_owned(), None));
        Ok(Lease {
            host: self.clone(),
            token: token.into(),
        })
    }
    pub fn bind_turn(&self, token: &str, id: i64) -> Result<(), String> {
        self.scopes
            .lock()
            .unwrap()
            .get_mut(token)
            .ok_or("对话已结束")?
            .1 = Some(id);
        Ok(())
    }
    pub fn has_token(&self, token: &str) -> bool {
        self.scopes.lock().unwrap().contains_key(token)
    }
    pub fn call(&self, method: &str, args: &Value) -> Result<Value, String> {
        if matches!(method, "host.usage" | "host.budget") {
            return crate::usage::host(
                &self.dir,
                method,
                args,
                self.daily_limit.load(Ordering::Acquire),
            );
        }
        let token = args["token"].as_str().ok_or("缺少对话编号")?;
        let (pet, turn) = self
            .scopes
            .lock()
            .unwrap()
            .get(token)
            .cloned()
            .ok_or("对话已结束")?;
        match method {
            "host.mcpConnection" if turn.is_some() => {
                let server: crate::external::Server =
                    serde_json::from_value(args["server"].clone()).map_err(|_| "无效服务")?;
                if let Some(id) = server.name.strip_prefix("catalog:") {
                    let root = self.library.parent().ok_or("缺少工具目录")?;
                    let config = crate::tool_cards::connection(root, id)?;
                    if server.url != config["url"].as_str().unwrap_or("") || !server.args.is_empty()
                    {
                        return Err("工具地址不符".into());
                    }
                    Ok(config)
                } else if self.external.config().enabled.contains(&server) {
                    Ok(json!({}))
                } else {
                    Err("工具已停用".into())
                }
            }
            "host.catalogAllowed" if turn.is_some() => {
                let id = args["id"].as_str().ok_or("缺少工具编号")?;
                let root = self.library.parent().ok_or("缺少工具目录")?;
                Ok(json!(crate::tool_cards::allowed(
                    root,
                    id,
                    args["tool"].as_str().unwrap_or("")
                )?))
            }
            "host.reserveSearch" if turn.is_some() => {
                let day = chrono::Local::now().format("%Y-%m-%d").to_string();
                Ok(json!(crate::search_quota::reserve(
                    &self.dir,
                    &day,
                    self.search_limit.load(Ordering::Acquire)
                )?))
            }
            "host.webResults" => {
                let values = serde_json::from_value::<Vec<String>>(args["urls"].clone())
                    .map_err(|_| "无效搜索结果")?;
                if values.len() > 5
                    || values.iter().any(|v| {
                        v.len() > 8192
                            || !tauri::Url::parse(v).is_ok_and(|u| {
                                matches!(u.scheme(), "http" | "https")
                                    && u.host().is_some()
                                    && u.username().is_empty()
                                    && u.password().is_none()
                            })
                    })
                {
                    return Err("无效搜索结果".into());
                }
                history::save_urls(&self.dir, turn.ok_or("没有当前话题")?, &values)
                    .map_err(|e| e.to_string())?;
                Ok(Value::Null)
            }
            "host.library_search" => {
                crate::documents::search(&self.library, args["query"].as_str().ok_or("需要关键词")?)
            }
            "host.library_read" => crate::documents::read(
                &self.library,
                args["file"].as_i64().ok_or("文件编号无效")?,
                args["section"].as_i64().ok_or("段号无效")?,
                args["count"].as_i64().unwrap_or(1),
            ),

            // 专注做某条待办 (plan/27): the tomato counts on it.
            "host.focus" if args["todo_id"].as_i64().is_some() && args["action"] == "start" => {
                let app = self.app.get().ok_or("应用还没准备好")?;
                crate::todo::focus_on(app, args["todo_id"].as_i64())?;
                crate::focus::from_brain(app, "start", args["minutes"].as_u64().map(|m| m as u32))
            }
            "host.focus" => crate::focus::from_brain(
                self.app.get().ok_or("应用还没准备好")?,
                args["action"].as_str().unwrap_or(""),
                args["minutes"].as_u64().map(|m| m as u32),
            ),
            "host.todo" => crate::todo::from_brain(self.app.get().ok_or("应用还没准备好")?, args),
            "host.cancelApproval" => {
                self.external.cancel(token);
                Ok(Value::Null)
            }
            "host.reminder_edit"
            | "host.reminder_create"
            | "host.reminder_list"
            | "host.reminder_manage"
                if !self.reminders.load(Ordering::Acquire) =>
            {
                Err("提醒已关闭".into())
            }
            "host.reminder_edit" => {
                let rule = args
                    .get("schedule")
                    .map(|s| serde_json::from_value(s.clone()))
                    .transpose()
                    .map_err(|_| "时间规则无效")?;
                crate::reminders::patch(
                    &self.dir,
                    args["id"].as_i64().ok_or("需要任务编号")?,
                    args["message"].as_str(),
                    args["mode"].as_str(),
                    rule,
                    crate::chat::now(),
                    args["name"].as_str(),
                )?;
                self.alarm.changed();
                Ok(json!({"updated":true}))
            }
            "host.reminder_create" => {
                let rule = serde_json::from_value(args["schedule"].clone())
                    .map_err(|_| "提醒时间规则无效")?;
                let key = format!(
                    "{}:{}",
                    token,
                    args["callId"].as_str().ok_or("缺少调用编号")?
                );
                let reply = crate::reminders::create_mode(
                    &self.dir,
                    &pet,
                    args["message"].as_str().ok_or("缺少提醒内容")?,
                    rule,
                    &key,
                    crate::chat::now(),
                    args["mode"].as_str().unwrap_or("agent"),
                    turn.map(|id| history::topic_and_note(&self.dir, id))
                        .transpose()
                        .map_err(|e| e.to_string())?
                        .map(|v| v.0),
                    args["name"].as_str(),
                )?;
                self.alarm.changed();
                Ok(reply)
            }
            "host.reminder_list" => crate::reminders::list(&self.dir, &pet),
            "host.reminder_manage" => {
                let id = args["id"].as_i64().ok_or("提醒编号无效")?;
                let action = match args["action"].as_str() {
                    Some("remove") => "delete",
                    Some(v @ ("pause" | "resume" | "run")) => v,
                    _ => return Err("未知任务操作".into()),
                };
                crate::reminders::manage(&self.dir, &pet, id, action, crate::chat::now())?;
                self.alarm.changed();
                Ok(json!({"id":id,"action":args["action"],"ok":true}))
            }
            "host.memory" | "host.search" if !self.memory.load(Ordering::Acquire) => {
                Err("记忆已关闭".into())
            }
            "host.memory" => {
                let ops =
                    serde_json::from_value::<Vec<memory::Operation>>(args["operations"].clone())
                        .map_err(|_| "记忆操作参数错误")?;
                let books = self.recent_write.lock().unwrap().apply(
                    &self.dir,
                    &pet,
                    &ops,
                    false,
                    turn.map(|_| token),
                )?;
                Ok(
                    json!({"saved":true,"userUsed":memory::Books::used(&books.user),"notesUsed":memory::Books::used(&books.notes)}),
                )
            }
            "host.search" => {
                let words = args["query"].as_str().ok_or("需要关键词")?;
                history::search(&self.dir, &pet, words).map_err(|_| "无法搜索历史".into())
            }
            _ => Err("未知后台方法".into()),
        }
    }
}
