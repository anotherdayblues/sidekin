//! Test-only pipe for exercising storage and model tools without opening system windows.
use crate::{companion::Companion, documents, history, memory, persona, reminders};
use serde_json::{json, Value};
use std::{
    io::{BufRead, Write},
    path::Path,
};
type R = Result<Value, String>;
fn dispatch(s: &Companion, method: &str, p: &Value) -> R {
    let pet = p["pet"].as_str().unwrap_or("cat");
    if !["cat", "dog"].contains(&pet) {
        return Err("非测试宠物".into());
    }
    match method {
        "meter" => crate::usage::host(&s.dir, p["method"].as_str().ok_or("未知用量操作")?, p, 20),
        "companion_usage" => {
            crate::usage::view(&s.dir, &chrono::Local::now().format("%Y-%m-%d").to_string())
        }
        "memory_view" => {
            let mut data = memory::view(&memory::read(&s.dir, pet)?);
            data["petId"] = pet.into();
            data["migration"] =
                serde_json::from_slice(&std::fs::read(s.dir.join("migration.json")).unwrap())
                    .unwrap();
            Ok(data)
        }
        "memory_edit" => {
            let ops = serde_json::from_value::<Vec<memory::Operation>>(p["operations"].clone())
                .map_err(|_| "无效操作")?;
            Ok(memory::view(&memory::apply_as(&s.dir, pet, &ops, true)?))
        }
        "list_documents" => Ok(json!(documents::list(&s.host.library)?)),
        "document_note" => {
            documents::note(
                &s.host.library,
                p["id"].as_i64().unwrap_or(-1),
                p["note"].as_str().unwrap_or(""),
            )?;
            Ok(Value::Null)
        }
        "remove_document" => {
            documents::remove(&s.host.library, p["id"].as_i64().unwrap_or(-1))?;
            Ok(Value::Null)
        }
        "import_document" => {
            use base64::{engine::general_purpose::STANDARD, Engine};
            let b = STANDARD
                .decode(p["data"].as_str().unwrap_or(""))
                .map_err(|_| "文件无效")?;
            let id = if let Some(replace_id) = p["replaceId"].as_i64() {
                documents::replace(
                    &s.host.library,
                    replace_id,
                    p["name"].as_str().unwrap_or(""),
                    p["note"].as_str().unwrap_or(""),
                    &b,
                    p["text"].as_str().unwrap_or(""),
                )?
            } else {
                documents::import(
                    &s.host.library,
                    p["name"].as_str().unwrap_or(""),
                    p["note"].as_str().unwrap_or(""),
                    &b,
                    p["text"].as_str().unwrap_or(""),
                )?
            };
            Ok(json!(id))
        }
        "library" => {
            let _lease = s.host.lease("qa", pet)?;
            s.host.call(p["method"].as_str().unwrap_or(""),&json!({"token":"qa","file":p["file"],"section":p["section"],"count":p["count"],"query":p["query"]}))
        }
        "get_persona" => Ok(
            json!({"petId":pet,"text":persona::get(&s.dir,pet,"测试宠物")?,"defaultText":persona::default("测试宠物")}),
        ),
        "save_persona" => {
            persona::save(&s.dir, pet, p["text"].as_str().map(str::to_owned))?;
            Ok(Value::Null)
        }
        "list_reminders" => reminders::list(&s.dir, pet),
        "search_history" => history::search(&s.dir, pet, p["query"].as_str().unwrap_or(""))
            .map_err(|e| e.to_string()),
        "catalog" => Ok(json!(documents::catalog(&s.host.library)?)),
        _ => Err("未知验收操作".into()),
    }
}
#[test]
#[ignore = "Only from a guarded, isolated QA subprocess"]
fn isolated_pipe() {
    assert_eq!(std::env::var("COMPANION_QA_GUARDED").unwrap(), "1");
    let root = Path::new(&std::env::var("QA").unwrap())
        .canonicalize()
        .unwrap();
    assert_eq!(
        root.parent().unwrap(),
        Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../../runs")
            .canonicalize()
            .unwrap()
    );
    assert!(root
        .file_name()
        .unwrap()
        .to_string_lossy()
        .starts_with("companion-456."));
    let case = std::env::var("COMPANION_CASE").unwrap();
    assert!(
        case.starts_with("profiles-")
            && case.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
    );
    let s = Companion::open(&root.join(case)).unwrap();
    for line in std::io::stdin().lock().lines().map_while(Result::ok) {
        let p: Value = serde_json::from_str(&line).unwrap();
        let r = dispatch(&s, p["cmd"].as_str().unwrap_or(""), &p["params"]);
        println!("QA_RPC {}", json!({"id":p["id"],"result":r}));
        std::io::stdout().flush().unwrap();
    }
}
