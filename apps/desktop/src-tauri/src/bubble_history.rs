use crate::locale::t;
use crate::{chat, companion::Companion, history, topics};
use rusqlite::params;
use serde_json::{json, Value};
use std::path::Path;
use tauri::{AppHandle, Manager};

#[tauri::command]
pub fn bubble_history_page(
    app: AppHandle,
    topic: Option<i64>,
    before: Option<i64>,
) -> Result<Value, String> {
    let pet = chat::pet(&app)?.0;
    let dir = &app.state::<Companion>().dir;
    let topic = match topic {
        Some(id) => Some(id),
        None => topics::current(dir, &pet, chat::now()).map_err(|_| t("host.topicsRead"))?,
    };
    page(dir, &pet, topic, before).map_err(|_| t("host.historyRead").into())
}

fn page(dir: &Path, pet: &str, topic: Option<i64>, before: Option<i64>) -> rusqlite::Result<Value> {
    let limit = if before.is_some() { 8 } else { 2 };
    let db = history::open(dir)?;
    let mut query = db.prepare("SELECT t.id,t.question,t.answer FROM turns t JOIN sessions s ON s.id=t.session
        WHERE t.session=? AND s.pet=? AND s.closed<>2 AND t.id<? AND trim(t.question)<>'' AND trim(t.answer)<>''
        ORDER BY t.id DESC LIMIT ?")?;
    let mut turns = query
        .query_map(
            params![topic, pet, before.unwrap_or(i64::MAX), limit + 1],
            |r| {
                Ok((
                    r.get::<_, i64>(0)?,
                    json!({"question":r.get::<_,String>(1)?, "answer":r.get::<_,String>(2)?}),
                ))
            },
        )?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let has_more = turns.len() > limit;
    turns.truncate(limit);
    let next = turns.last().filter(|_| has_more).map(|t| t.0);
    Ok(
        json!({"topic":topic,"before":next,"turns":turns.into_iter().rev().map(|t|t.1).collect::<Vec<_>>()}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn pages_stay_in_order_when_a_new_turn_arrives() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let db = history::open(dir).unwrap();
        db.execute_batch("INSERT INTO sessions VALUES(1,'pet',0,0);
          WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<12)
          INSERT INTO turns(id,session,question,answer,at) SELECT x,1,cast(x as text),'ok',0 FROM n;").unwrap();
        let read = |before| page(dir, "pet", Some(1), before).unwrap();
        let first = read(None);
        assert_eq!(first["before"], 11);
        db.execute(
            "INSERT INTO turns(id,session,question,answer,at) VALUES(13,1,'new','yes',0)",
            [],
        )
        .unwrap();
        let older = read(Some(11));
        assert_eq!(older["turns"].as_array().unwrap().len(), 8);
        assert_eq!(older["turns"][0]["question"], "3");
        assert_eq!(older["turns"][7]["question"], "10");
        assert_eq!(read(Some(3))["before"], Value::Null);
        assert_eq!(
            page(dir, "other", Some(1), None).unwrap()["turns"],
            json!([])
        );
    }
}
