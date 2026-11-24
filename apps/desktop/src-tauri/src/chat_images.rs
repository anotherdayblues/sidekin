// The exact PNG used for model input and its lightweight chat-list preview.
use crate::locale::t;
use base64::{engine::general_purpose::STANDARD, Engine};
use rusqlite::{params, Transaction};
use serde_json::{json, Value};
use std::collections::HashMap;
use tauri::{AppHandle, Manager};

pub struct Picture {
    pub png: Vec<u8>,
    pub thumbnail: Vec<u8>,
}
impl Picture {
    pub fn new(png: Vec<u8>) -> Result<Self, String> {
        let preview = image::load_from_memory(&png)
            .map_err(|_| t("host.imageRead"))?
            .thumbnail(320, 320);
        let thumbnail = crate::capture_image::encode(&preview.into_rgba8())?;
        Ok(Self { png, thumbnail })
    }
    pub fn part(&self) -> Value {
        json!({"type":"image","mimeType":"image/png","data":STANDARD.encode(&self.png)})
    }
    pub fn save(&self, tx: &Transaction<'_>, turn: i64) -> rusqlite::Result<()> {
        tx.execute(
            "INSERT INTO turn_thumbnails(turn,png) VALUES(?,?)",
            params![turn, self.thumbnail],
        )?;
        tx.execute(
            "INSERT INTO turn_images(turn,png) VALUES(?,?)",
            params![turn, self.png],
        )?;
        Ok(())
    }
}

pub fn recent(
    tx: &Transaction<'_>,
    topic: i64,
    current_has_image: bool,
) -> rusqlite::Result<HashMap<i64, String>> {
    let limit = if current_has_image { 2 } else { 3 };
    let mut query = tx.prepare(
        "SELECT t.id,coalesce(i.png,p.png) FROM turns t
        JOIN turn_thumbnails p ON p.turn=t.id LEFT JOIN turn_images i ON i.turn=t.id
        WHERE t.session=? ORDER BY t.id DESC LIMIT ?",
    )?;
    let rows = query.query_map(params![topic, limit], |r| {
        Ok((r.get(0)?, STANDARD.encode(r.get::<_, Vec<u8>>(1)?)))
    })?;
    rows.collect()
}

#[tauri::command]
pub fn chat_image(app: AppHandle, turn: i64) -> Result<String, String> {
    let db = crate::history::open(&app.state::<crate::companion::Companion>().dir)
        .map_err(|_| t("host.imageRead"))?;
    let png: Vec<u8> = db
        .query_row(
            "SELECT coalesce(i.png,p.png) FROM turn_thumbnails p
        LEFT JOIN turn_images i ON p.turn=i.turn WHERE p.turn=?",
            [turn],
            |r| r.get(0),
        )
        .map_err(|_| t("host.imageMissing"))?;
    Ok(format!("data:image/png;base64,{}", STANDARD.encode(png)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::history::{begin, begin_topic_turn, open, TopicTarget};
    #[test]
    fn replay_limits_and_legacy_thumbnail_and_deletion() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path();
        let mut ids = vec![];
        for n in 1..=4u8 {
            let p = Picture {
                png: vec![n],
                thumbnail: vec![100 + n],
            };
            let (id, prev) =
                begin_topic_turn(dir, "cat", "图", n.into(), TopicTarget::Current, Some(&p))
                    .unwrap();
            assert_eq!(
                prev.iter().filter(|t| t.image_data.is_some()).count(),
                (n as usize - 1).min(2)
            );
            ids.push(id);
        }
        let db = open(dir).unwrap();
        db.execute("DELETE FROM turn_images WHERE turn=?", [ids[2]])
            .unwrap();
        let (_, prev) = begin(dir, "cat", "猫在哪里？", 5).unwrap();
        let data: Vec<_> = prev
            .iter()
            .filter_map(|t| t.image_data.as_ref())
            .cloned()
            .collect();
        assert_eq!(data, [2u8, 103, 4].map(|n| STANDARD.encode([n])));
        db.execute("DELETE FROM turns WHERE id=?", [ids[3]])
            .unwrap();
        for table in ["turn_images", "turn_thumbnails"] {
            assert_eq!(
                db.query_row(
                    &format!("SELECT count(*) FROM {table} WHERE turn=?"),
                    [ids[3]],
                    |r| r.get::<_, i64>(0)
                )
                .unwrap(),
                0
            );
        }
        assert!(begin(dir, "other", "新话题", 6).unwrap().1.is_empty());
    }
}
