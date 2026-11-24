// A catalogue proposal is inert until accepted in the studio window.
use crate::locale::t;
use crate::{
    credentials::{self, Secrets, SystemSecrets},
    library, State,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Deserialize;
use serde_json::{json, Value};
use std::{fs, path::Path, sync::LazyLock};
use tauri::{AppHandle, Manager, WebviewWindow};
type R<T> = Result<T, String>;
pub static CATALOG: LazyLock<Vec<Value>> = LazyLock::new(|| {
    serde_json::from_str(include_str!(
        "../../../../skills/find-pet-tool/catalog.json"
    ))
    .expect("built-in tool catalogue")
});
fn entry(id: &str) -> R<&'static Value> {
    CATALOG
        .iter()
        .find(|x| x["id"] == id)
        .ok_or(t("host.toolNotListed").into())
}
fn db(root: &Path) -> R<Connection> {
    let c = Connection::open(root.join("tool-cards.sqlite3")).map_err(|e| e.to_string())?;
    c.busy_timeout(std::time::Duration::from_secs(3))
        .map_err(|e| e.to_string())?;
    c.execute_batch("CREATE TABLE IF NOT EXISTS proposals(ticket TEXT PRIMARY KEY,id TEXT NOT NULL,reason TEXT NOT NULL,status TEXT NOT NULL DEFAULT 'received');
    CREATE TABLE IF NOT EXISTS tools(id TEXT PRIMARY KEY,enabled INTEGER NOT NULL);").map_err(|e|e.to_string())?;
    Ok(c)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Proposal {
    id: String,
    reason: String,
}
pub fn receive(root: &Path, dir: &Path, ticket: &str) -> R<String> {
    if !ticket
        .strip_prefix("tool-")
        .is_some_and(|v| v.len() == 32 && v.bytes().all(|b| b.is_ascii_hexdigit()))
    {
        return Err(t("host.cardId").into());
    }
    let path = dir.join("tool.json");
    let meta = fs::symlink_metadata(&path).map_err(|_| t("host.cardMissing"))?;
    if dir.is_symlink()
        || !meta.is_file()
        || meta.len() > 2048
        || fs::read_dir(dir)
            .map_err(|_| t("host.cardUnreadable"))?
            .count()
            != 1
    {
        return Err(t("host.cardOneFile").into());
    }
    let p: Proposal =
        serde_json::from_slice(&fs::read(path).map_err(|_| t("host.cardUnreadable"))?)
            .map_err(|_| t("host.cardFields"))?;
    entry(&p.id)?;
    if !plain_reason(&p.reason) {
        return Err(t("host.reasonPlain"));
    }
    db(root)?
        .execute(
            "INSERT OR IGNORE INTO proposals(ticket,id,reason) VALUES(?,?,?)",
            params![ticket, p.id, p.reason],
        )
        .map_err(|e| e.to_string())?;
    Ok(p.id)
}
/// One short sentence in Chinese or English letters, so nothing like a link,
/// an address, a number or a key can reach the card: a full stop only ends it.
fn plain_reason(reason: &str) -> bool {
    let r = reason.trim();
    !r.is_empty()
        && r.chars().count() <= 100
        && r.chars().all(|c| {
            ('一'..='鿿').contains(&c)
                || " ，。、！？".contains(c)
                || c.is_ascii_alphabetic()
                || " ,.!?'-".contains(c)
        })
        && !r.trim_end_matches(['.', '!', '?']).contains('.')
}
fn studio(w: &WebviewWindow) -> R<()> {
    if w.label() == "studio" {
        Ok(())
    } else {
        Err(t("host.useSettings").into())
    }
}
#[tauri::command]
pub fn tool_cards(app: AppHandle, window: WebviewWindow) -> R<Value> {
    studio(&window)?;
    let c = db(&app.state::<State>().root)?;
    let mut q = c
        .prepare("SELECT ticket,id,reason FROM proposals WHERE status='received' ORDER BY rowid")
        .map_err(|e| e.to_string())?;
    let pending=q.query_map([],|r|Ok(json!({"ticket":r.get::<_,String>(0)?,"id":r.get::<_,String>(1)?,"reason":r.get::<_,String>(2)?}))).and_then(|r|r.collect::<rusqlite::Result<Vec<_>>>()).map_err(|e|e.to_string())?;
    let mut q = c
        .prepare("SELECT id,enabled FROM tools ORDER BY id")
        .map_err(|e| e.to_string())?;
    let tools = q
        .query_map([], |r| {
            Ok(json!({"id":r.get::<_,String>(0)?,"enabled":r.get::<_,bool>(1)?}))
        })
        .and_then(|r| r.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| e.to_string())?;
    Ok(json!({"pending":pending,"tools":tools}))
}
fn key_name(id: &str) -> String {
    format!("catalog-tool-{id}")
}
#[tauri::command]
pub fn decide_tool_card(
    app: AppHandle,
    window: WebviewWindow,
    ticket: String,
    enable: bool,
    key: Option<String>,
) -> R<()> {
    studio(&window)?;
    let state = app.state::<State>();
    let root = &state.root;
    let mut c = db(root)?;
    let tx = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let (id, old): (String, String) = tx
        .query_row(
            "SELECT id,status FROM proposals WHERE ticket=?",
            [&ticket],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .map_err(|_| t("host.cardGone"))?;
    let status = if enable { "enabled" } else { "discarded" };
    if old != "received" && old != status {
        return Err(t("host.cardDone").into());
    }
    if old == "received" {
        if enable {
            if entry(&id)?["auth"] == "bearer" {
                let account = key_name(&id);
                if let Some(k) = key.filter(|s| !s.is_empty()) {
                    SystemSecrets.put(&account, credentials::checked_key(&k)?)?;
                } else if SystemSecrets.get(&account)?.is_none() {
                    return Err(t("host.enterKey").into());
                }
            }
            tx.execute("INSERT OR REPLACE INTO tools VALUES(?,1)", [&id])
                .map_err(|e| e.to_string())?;
        }
        tx.execute(
            "UPDATE proposals SET status=? WHERE ticket=?",
            params![status, ticket],
        )
        .map_err(|e| e.to_string())?;
    }
    tx.commit().map_err(|e| e.to_string())?;
    library::write_json(
        &root.join("inbox").join(format!(".decision-{ticket}.json")),
        &json!({"kind":"tool","id":id,"ticket":ticket,"status":status}),
    )
}

pub fn enabled(root: &Path, id: &str) -> R<bool> {
    db(root)?
        .query_row("SELECT enabled FROM tools WHERE id=?", [id], |r| r.get(0))
        .optional()
        .map(|s| s.unwrap_or(false))
        .map_err(|e| e.to_string())
}
pub fn servers(root: &Path) -> R<Vec<Value>> {
    let c = db(root)?;
    let mut q = c
        .prepare("SELECT id FROM tools WHERE enabled=1")
        .map_err(|e| e.to_string())?;
    let ids = q
        .query_map([], |r| r.get::<_, String>(0))
        .and_then(|r| r.collect::<rusqlite::Result<Vec<_>>>())
        .map_err(|e| e.to_string())?;
    Ok(ids.iter().filter_map(|id|entry(id).ok()).map(|e|json!({"name":format!("catalog:{}",e["id"].as_str().unwrap()),"url":e["url"],"args":[]})).collect())
}
pub fn allowed(root: &Path, id: &str, tool: &str) -> R<bool> {
    Ok(enabled(root, id)?
        && entry(id)?["tools"]
            .as_array()
            .is_some_and(|list| list.iter().any(|x| x == tool)))
}
pub fn connection(root: &Path, id: &str) -> R<Value> {
    let e = entry(id)?;
    if !enabled(root, id)? {
        return Err(t("host.toolOff").into());
    }
    let key = if e["auth"] == "bearer" {
        Some(
            SystemSecrets
                .get(&key_name(id))?
                .ok_or(t("host.reenterKey"))?,
        )
    } else {
        None
    };
    Ok(json!({"url":e["url"],"name":e["name"],"tools":e["tools"],"key":key}))
}
#[tauri::command]
pub fn manage_catalog_tool(
    app: AppHandle,
    window: WebviewWindow,
    id: String,
    action: String,
) -> R<()> {
    studio(&window)?;
    entry(&id)?;
    let state = app.state::<State>();
    let c = db(&state.root)?;
    match action.as_str() {
        "enable" | "disable" => c.execute(
            "UPDATE tools SET enabled=? WHERE id=?",
            params![action == "enable", id],
        ),
        "delete" => c.execute("DELETE FROM tools WHERE id=?", [&id]),
        _ => return Err(t("host.unknownAction").into()),
    }
    .map_err(|e| e.to_string())?;
    if action != "enable" {
        crate::external::disconnect(
            &app.state::<crate::companion::Companion>(),
            &format!("catalog:{id}"),
        )?;
    }
    if action == "delete"
        && entry(&id)?["auth"] == "bearer"
        && SystemSecrets.get(&key_name(&id))?.is_some()
    {
        SystemSecrets.remove(&key_name(&id))?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn delivery_is_strict_and_never_enables() {
        let d = tempfile::tempdir().unwrap();
        let root = d.path();
        let dir = root.join("draft");
        fs::create_dir(&dir).unwrap();
        let ticket = "tool-00112233445566778899aabbccddeeff";
        let file = dir.join("tool.json");
        fs::write(
            &file,
            r#"{"id":"ms-learn","reason":"查资料。","command":"ignored"}"#,
        )
        .unwrap();
        assert!(receive(root, &dir, ticket).is_err());
        fs::write(&file, r#"{"id":"ms-learn","reason":"查资料。"}"#).unwrap();
        assert!(receive(root, &dir, ticket).is_ok());
        assert!(!enabled(root, "ms-learn").unwrap());
        fs::write(dir.join("extra"), "fixture").unwrap();
        assert!(receive(root, &dir, ticket).is_err());
    }
    #[test]
    fn a_reason_is_a_plain_sentence_in_chinese_or_english() {
        for ok in [
            "用于查公开资料。",
            "Looks up public docs.",
            "Finds papers, if you're curious!",
        ] {
            assert!(plain_reason(ok), "{ok}");
        }
        for bad in [
            "",
            "See example.com",
            "Visit https://example.com",
            "mail me@example.com",
            "Key sk-123",
            "第 3 步",
            "<b>bold</b>",
        ] {
            assert!(!plain_reason(bad), "{bad}");
        }
    }
}
