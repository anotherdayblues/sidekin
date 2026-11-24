use crate::locale::t;
use crate::{brain::Events, companion::Companion, library};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    path::{Path, PathBuf},
    sync::{mpsc, Mutex},
    time::Duration,
};
use tauri::{AppHandle, Manager};
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Server {
    pub name: String,
    pub url: String,
    #[serde(default)]
    pub args: Vec<String>,
}
impl Server {
    pub fn validate(&self) -> Result<(), String> {
        if self.name.starts_with("catalog:")
            || self.name == "网页读取"
            || self.name.is_empty()
            || self.name.len() > 80
            || self.url.trim().is_empty()
        {
            return Err(t("host.toolNeeds").into());
        }
        if self.url.contains("://") {
            let u = tauri::Url::parse(&self.url).map_err(|_| t("host.addressBad"))?;
            if !matches!(u.scheme(), "http" | "https")
                || u.host().is_none()
                || !u.username().is_empty()
                || u.password().is_some()
                || u.query().is_some()
                || !self.args.is_empty()
            {
                return Err(t("host.httpEndpoint").into());
            }
        }
        Ok(())
    }
}
#[derive(Clone, Serialize, Deserialize, Debug, PartialEq, Eq)]
pub struct Grant {
    pub server: Server,
    pub tool: String,
}
#[derive(Clone, Default, Serialize, Deserialize)]
pub struct Config {
    pub servers: Vec<Server>,
    pub grants: Vec<Grant>,
    #[serde(default)]
    pub enabled: Vec<Server>,
}
fn web_grant(g: &Grant) -> bool {
    g.tool == "web_read"
        && g.server.name == "网页读取"
        && g.server.args.is_empty()
        && tauri::Url::parse(&g.server.url).is_ok_and(|u| {
            matches!(u.scheme(), "http" | "https")
                && u.host().is_some()
                && u.username().is_empty()
                && u.password().is_none()
        })
}
struct Pending {
    token: String,
    grant: Grant,
    reply: mpsc::Sender<bool>,
    deadline: std::time::Instant,
}
pub struct External {
    dir: PathBuf,
    config: Mutex<Config>,
    pending: Mutex<HashMap<String, Pending>>,
}
impl External {
    pub fn open(dir: &Path) -> Result<Self, String> {
        let config = match std::fs::read(dir.join("external.json")) {
            Ok(v) => serde_json::from_slice(&v).map_err(|_| t("host.toolsBroken"))?,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Config::default(),
            Err(e) => return Err(e.to_string()),
        };
        Ok(Self {
            dir: dir.into(),
            config: Mutex::new(config),
            pending: Mutex::new(HashMap::new()),
        })
    }
    pub fn config(&self) -> Config {
        self.config.lock().unwrap().clone()
    }
    pub fn edit(&self, f: impl FnOnce(&mut Config) -> Result<(), String>) -> Result<(), String> {
        let mut saved = self.config.lock().unwrap();
        let mut next = saved.clone();
        f(&mut next)?;
        next.enabled.retain(|s| next.servers.contains(s));
        next.grants
            .retain(|g| web_grant(g) || next.servers.contains(&g.server));
        library::write_json(&self.dir.join("external.json"), &next)?;
        self.pending
            .lock()
            .unwrap()
            .retain(|_, p| web_grant(&p.grant) || next.enabled.contains(&p.grant.server));
        *saved = next;
        Ok(())
    }
    pub fn authorize(
        &self,
        args: &Value,
        events: &Events,
        timeout: Duration,
        alive: impl Fn() -> bool,
    ) -> Result<bool, String> {
        let token = args["token"].as_str().ok_or("缺少对话编号")?;
        let id = args["ticket"].as_str().ok_or("缺少授权编号")?;
        let grant: Grant =
            serde_json::from_value(args["grant"].clone()).map_err(|_| "工具标识错误")?;
        let rx = {
            let cfg = self.config.lock().unwrap();
            if !web_grant(&grant) && !cfg.enabled.contains(&grant.server) {
                return Ok(false);
            }
            if !alive() {
                return Ok(false);
            }
            if web_grant(&grant) && cfg.grants.contains(&grant) {
                return Ok(true);
            }
            let (tx, rx) = mpsc::channel();
            let mut pending = self.pending.lock().unwrap();
            if !alive() {
                return Ok(false);
            }
            if pending.contains_key(id) {
                return Err("授权请求重复".into());
            }
            pending.insert(
                id.into(),
                Pending {
                    token: token.into(),
                    grant: grant.clone(),
                    reply: tx,
                    deadline: std::time::Instant::now() + timeout,
                },
            );
            rx
        };
        events(
            "approval.ask",
            json!({"token":token,"id":id,"service":grant.server.name,"tool":grant.tool,"args":args["summary"]}),
        );
        let yes = rx.recv_timeout(timeout).unwrap_or(false);
        self.pending.lock().unwrap().remove(id);
        events("approval.closed", json!({"token":token,"id":id}));
        Ok(yes)
    }
    pub fn cancel(&self, token: &str) {
        self.pending.lock().unwrap().retain(|_, p| p.token != token);
    }
    pub fn decide(&self, id: &str, choice: &str) -> Result<(), String> {
        if !["once", "deny", "always"].contains(&choice) {
            return Err("未知授权选择".into());
        }
        let mut cfg = self.config.lock().unwrap();
        let p = self
            .pending
            .lock()
            .unwrap()
            .remove(id)
            .ok_or("请求已结束")?;
        if std::time::Instant::now() >= p.deadline {
            return Err("请求已超时".into());
        }
        if choice == "always" && web_grant(&p.grant) && !cfg.grants.contains(&p.grant) {
            let mut next = cfg.clone();
            next.grants.push(p.grant.clone());
            library::write_json(&self.dir.join("external.json"), &next)?;
            *cfg = next;
        }
        p.reply
            .send(choice != "deny")
            .map_err(|_| "请求已结束".into())
    }
}
#[tauri::command]
pub fn external_config(app: AppHandle) -> Config {
    app.state::<Companion>().host.external.config()
}
#[tauri::command]
pub fn set_mcp(
    app: AppHandle,
    window: tauri::WebviewWindow,
    server: Server,
    remove: bool,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err(t("host.toolsInSettings").into());
    }
    server.validate()?;
    #[cfg(feature = "acceptance")]
    if !server.url.starts_with("http://127.0.0.1:") {
        return Err("验收 MCP 只允许本地测试地址".into());
    }
    let name = server.name.clone();
    let state = app.state::<Companion>();
    state.host.external.edit(|c| {
        c.enabled.retain(|s| s.name != server.name);
        c.servers.retain(|s| s.name != server.name);
        if !remove {
            c.servers.push(server);
        }
        Ok(())
    })?;
    disconnect(&state, &name)
}
#[tauri::command]
pub fn enable_mcp(
    app: AppHandle,
    window: tauri::WebviewWindow,
    server: Server,
    enabled: bool,
) -> Result<(), String> {
    if window.label() != "studio" {
        return Err(t("host.confirmInSettings").into());
    }
    let state = app.state::<Companion>();
    state.host.external.edit(|c| {
        if !c.servers.contains(&server) {
            return Err(t("host.serviceMissing").into());
        }
        c.enabled.retain(|s| s != &server);
        if enabled {
            c.enabled.push(server.clone());
        } else {
            c.grants.retain(|g| g.server != server);
        }
        Ok(())
    })?;
    if !enabled {
        disconnect(&state, &server.name)?;
    }
    Ok(())
}
pub fn disconnect(state: &Companion, name: &str) -> Result<(), String> {
    if let Ok(client) = state.client() {
        client.call("disconnect_mcp", json!({"name":name}))?;
    }
    Ok(())
}
#[tauri::command]
pub fn revoke_tool(app: AppHandle, grant: Grant) -> Result<(), String> {
    app.state::<Companion>().host.external.edit(|c| {
        c.grants.retain(|g| g != &grant);
        Ok(())
    })
}
#[tauri::command]
pub fn approve_tool(app: AppHandle, id: String, choice: String) -> Result<(), String> {
    app.state::<Companion>().host.external.decide(&id, &choice)
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;
    #[test]
    fn once_deny_always_revoke_timeout_and_change() {
        let root = tempfile::tempdir().unwrap();
        let service = Server {
            name: "test".into(),
            url: "http://127.0.0.1:1".into(),
            args: vec![],
        };
        let registry = Arc::new(External::open(root.path()).unwrap());
        registry
            .edit(|c| {
                c.servers.push(service.clone());
                c.enabled.push(service.clone());
                Ok(())
            })
            .unwrap();
        let grant = Grant {
            server: service,
            tool: "badge".into(),
        };
        let args = json!({"token":"turn","ticket":"id","grant":grant});
        for (choice, expected) in [("once", true), ("deny", false), ("always", true)] {
            let r = registry.clone();
            let events: Events = Arc::new(move |kind, data| {
                if kind == "approval.ask" {
                    r.decide(data["id"].as_str().unwrap(), choice).unwrap();
                }
            });
            assert_eq!(
                registry
                    .authorize(&args, &events, Duration::from_secs(1), || true)
                    .unwrap(),
                expected
            );
        }
        let restored = External::open(root.path()).unwrap();
        let quiet: Events = Arc::new(|_, _| {});
        assert!(!restored
            .authorize(&args, &quiet, Duration::ZERO, || true)
            .unwrap());
        restored
            .edit(|c| {
                c.grants.clear();
                Ok(())
            })
            .unwrap();
        assert!(!restored
            .authorize(&args, &quiet, Duration::ZERO, || true)
            .unwrap());
        registry
            .edit(|c| {
                c.servers[0].url = "http://127.0.0.1:2".into();
                Ok(())
            })
            .unwrap();
        assert!(registry.config().grants.is_empty());
    }
}
