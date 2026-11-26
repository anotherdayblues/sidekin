use super::{media, Preferences};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{collections::HashSet, path::Path};

pub const MAX_BYTES: usize = 64 * 1024;
const DAY: i64 = 24 * 3600 * 1000;
const LIMIT: usize = 2000;
const TEXT_QUOTA_BYTES: i64 = 8 * 1024 * 1024;
pub const IMAGE_LIMIT: usize = 100;
pub const IMAGE_QUOTA_BYTES: i64 = 100 * 1024 * 1024;

pub fn open(path: &Path) -> rusqlite::Result<Connection> {
    let db = Connection::open(path)?;
    db.busy_timeout(std::time::Duration::from_secs(2))?;
    db.execute_batch(
        "PRAGMA secure_delete=ON;
        CREATE TABLE IF NOT EXISTS clips(id INTEGER PRIMARY KEY AUTOINCREMENT, digest BLOB NOT NULL UNIQUE, body TEXT NOT NULL, bytes INTEGER NOT NULL,
            source TEXT NOT NULL, at INTEGER NOT NULL, pinned INTEGER NOT NULL DEFAULT 0);
        CREATE INDEX IF NOT EXISTS clips_recent ON clips(pinned DESC, at DESC);
        CREATE TABLE IF NOT EXISTS preferences(id INTEGER PRIMARY KEY, value TEXT NOT NULL);",
    )?;
    migrate(&db)?;
    Ok(db)
}

fn migrate(db: &Connection) -> rusqlite::Result<()> {
    let mut existing = HashSet::new();
    let mut stmt = db.prepare("PRAGMA table_info(clips)")?;
    let cols = stmt.query_map([], |r| r.get::<_, String>(1))?;
    for c in cols {
        existing.insert(c?);
    }
    drop(stmt);
    for (col, ddl) in [
        ("kind", "ALTER TABLE clips ADD COLUMN kind TEXT NOT NULL DEFAULT 'text'"),
        ("width", "ALTER TABLE clips ADD COLUMN width INTEGER NOT NULL DEFAULT 0"),
        ("height", "ALTER TABLE clips ADD COLUMN height INTEGER NOT NULL DEFAULT 0"),
        ("media", "ALTER TABLE clips ADD COLUMN media TEXT NOT NULL DEFAULT ''"),
        ("thumb", "ALTER TABLE clips ADD COLUMN thumb TEXT NOT NULL DEFAULT ''"),
        ("ocr", "ALTER TABLE clips ADD COLUMN ocr TEXT NOT NULL DEFAULT ''"),
    ] {
        if !existing.contains(col) {
            db.execute(ddl, [])?;
        }
    }
    db.execute(
        "CREATE INDEX IF NOT EXISTS clips_kind_recent ON clips(kind, pinned DESC, at DESC)",
        [],
    )?;
    Ok(())
}

pub fn preferences(path: &Path) -> Result<Preferences, String> {
    if !path.exists() {
        return Ok(Preferences::default());
    }
    let raw: Option<String> = open(path)
        .and_then(|db| {
            db.query_row("SELECT value FROM preferences WHERE id=1", [], |r| r.get(0))
                .optional()
        })
        .map_err(|e| e.to_string())?;
    match raw {
        Some(raw) => serde_json::from_str(&raw).map_err(|e| e.to_string()),
        None => Ok(Preferences::default()),
    }
}

pub fn configure(db: &Connection, prefs: &Preferences) -> rusqlite::Result<()> {
    db.execute(
        "INSERT OR REPLACE INTO preferences VALUES(1,?1)",
        [serde_json::to_string(prefs).unwrap()],
    )?;
    Ok(())
}

fn collect_media(stmt: &mut rusqlite::Statement<'_>, params: impl rusqlite::Params) -> rusqlite::Result<Vec<(String, String)>> {
    let rows = stmt.query_map(params, |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (m, t) = row?;
        if !m.is_empty() || !t.is_empty() {
            out.push((m, t));
        }
    }
    Ok(out)
}

pub fn prune(db: &Connection, now: i64) -> rusqlite::Result<Vec<(String, String)>> {
    // Read the policy in the same statement as the deletion. Old settings
    // contain no retentionDays field and keep their original seven-day rule.
    let mut stmt = db.prepare(
        "WITH policy(days) AS (
            SELECT coalesce((SELECT json_extract(value,'$.retentionDays') FROM preferences WHERE id=1),7)
        ) DELETE FROM clips WHERE pinned=0 AND at < (
            SELECT CASE WHEN days>0 THEN ?1-days*?2 END FROM policy
        ) RETURNING media, thumb",
    )?;
    collect_media(&mut stmt, params![now, DAY])
}

pub fn insert(
    db: &mut Connection,
    body: &str,
    source: &str,
    now: i64,
) -> rusqlite::Result<Vec<(String, String)>> {
    let tx = db.transaction()?;
    let removed = prune(&tx, now)?;
    tx.execute(
        "INSERT INTO clips(body,source,at,digest,bytes,kind) VALUES(?1,?2,?3,?4,?5,'text')
        ON CONFLICT(digest) DO UPDATE SET source=excluded.source,at=excluded.at",
        params![
            body,
            source,
            now,
            Sha256::digest(body.as_bytes()).as_slice(),
            body.len()
        ],
    )?;
    tx.execute(
        "DELETE FROM clips WHERE id IN (SELECT id FROM clips WHERE pinned=0 AND kind='text' ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?1)",
        [LIMIT],
    )?;
    tx.execute(
        "DELETE FROM clips WHERE id IN (SELECT id FROM
        (SELECT id,sum(bytes) OVER (ORDER BY at DESC,id DESC ROWS UNBOUNDED PRECEDING) AS used
         FROM clips WHERE pinned=0 AND kind='text') WHERE used>?1)",
        [TEXT_QUOTA_BYTES],
    )?;
    tx.commit()?;
    Ok(removed)
}

pub struct InsertedImage {
    pub id: i64,
    pub needs_ocr: bool,
    pub removed: Vec<(String, String)>,
}

pub fn insert_image(
    db: &mut Connection,
    img: &media::PreparedImage,
    source: &str,
    now: i64,
) -> rusqlite::Result<InsertedImage> {
    let tx = db.transaction()?;
    let mut removed = prune(&tx, now)?;
    let fallback_body = format!("{}×{}", img.width, img.height);
    let (id, ocr): (i64, String) = tx.query_row(
        "INSERT INTO clips(body,source,at,digest,bytes,kind,width,height,media,thumb,ocr)
         VALUES(?1,?2,?3,?4,?5,'image',?6,?7,?8,?9,'')
         ON CONFLICT(digest) DO UPDATE SET
           source=excluded.source,
           at=excluded.at,
           width=excluded.width,
           height=excluded.height,
           media=excluded.media,
           thumb=excluded.thumb
         RETURNING id, ocr",
        params![
            fallback_body,
            source,
            now,
            img.digest.as_slice(),
            img.png.len() as i64,
            img.width,
            img.height,
            img.media_name,
            img.thumb_name,
        ],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    {
        let mut stmt = tx.prepare(
            "DELETE FROM clips WHERE id IN (SELECT id FROM clips WHERE pinned=0 AND kind='image' ORDER BY at DESC, id DESC LIMIT -1 OFFSET ?1) RETURNING media, thumb",
        )?;
        removed.extend(collect_media(&mut stmt, [IMAGE_LIMIT])?);
    }
    {
        let mut stmt = tx.prepare(
            "DELETE FROM clips WHERE id IN (SELECT id FROM
            (SELECT id,sum(bytes) OVER (ORDER BY at DESC,id DESC ROWS UNBOUNDED PRECEDING) AS used
             FROM clips WHERE pinned=0 AND kind='image') WHERE used>?1) RETURNING media, thumb",
        )?;
        removed.extend(collect_media(&mut stmt, [IMAGE_QUOTA_BYTES])?);
    }
    tx.commit()?;
    Ok(InsertedImage {
        id,
        needs_ocr: ocr.is_empty(),
        removed,
    })
}

pub fn update_ocr(db: &Connection, id: i64, ocr_text: &str) -> rusqlite::Result<usize> {
    db.execute(
        "UPDATE clips SET ocr=?1 WHERE id=?2 AND kind='image'",
        params![ocr_text, id],
    )
}

/// Bump a reused history entry to the top of recent history without duplicating
/// the row or overwriting its original source app / pin / OCR metadata.
pub fn touch(db: &Connection, id: i64, now: i64) -> rusqlite::Result<usize> {
    db.execute("UPDATE clips SET at=?1 WHERE id=?2", params![now, id])
}

pub fn delete_by_id(db: &Connection, id: i64) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = db.prepare("DELETE FROM clips WHERE id=?1 RETURNING media, thumb")?;
    collect_media(&mut stmt, [id])
}

pub fn delete_many(db: &mut Connection, ids: &[i64]) -> rusqlite::Result<Vec<(String, String)>> {
    if ids.is_empty() {
        return Ok(vec![]);
    }
    let tx = db.transaction()?;
    let mut removed = Vec::new();
    {
        let mut stmt = tx.prepare("DELETE FROM clips WHERE id=?1 RETURNING media, thumb")?;
        for &id in ids {
            removed.extend(collect_media(&mut stmt, [id])?);
        }
    }
    tx.commit()?;
    Ok(removed)
}

pub fn clear_all(db: &Connection) -> rusqlite::Result<Vec<(String, String)>> {
    let mut stmt = db.prepare("DELETE FROM clips RETURNING media, thumb")?;
    collect_media(&mut stmt, [])
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImageUsage {
    pub count: usize,
    pub bytes: u64,
    pub limit_count: usize,
    pub limit_bytes: u64,
}

pub fn image_usage(db: &Connection) -> rusqlite::Result<ImageUsage> {
    let (count, bytes): (i64, i64) = db.query_row(
        "SELECT count(*), coalesce(sum(bytes), 0) FROM clips WHERE kind='image'",
        [],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )?;
    Ok(ImageUsage {
        count: count.max(0) as usize,
        bytes: bytes.max(0) as u64,
        limit_count: IMAGE_LIMIT,
        limit_bytes: IMAGE_QUOTA_BYTES as u64,
    })
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub id: i64,
    pub kind: String,
    pub preview: String,
    pub source: String,
    pub at: i64,
    pub pinned: bool,
    pub link: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thumb: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr_preview: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Detail {
    pub id: i64,
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image_data_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub width: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub height: Option<u32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub bytes: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ocr: Option<String>,
}

pub enum ClipPayload {
    Text(String),
    Image { png: Vec<u8> },
}

fn preview(body: &str, words: &[String]) -> String {
    let folded = body.to_ascii_lowercase();
    let start = words
        .iter()
        .filter_map(|word| folded.find(&word.to_ascii_lowercase()))
        .min()
        .unwrap_or(0);
    let from = body[..start]
        .char_indices()
        .rev()
        .nth(20)
        .map(|(i, _)| i)
        .unwrap_or(0);
    let mut out = String::new();
    if from > 0 {
        out.push('…');
    }
    out.extend(body[from..].chars().take(150));
    out
}

pub fn search(
    db: &Connection,
    media_root: &Path,
    query: &str,
    kind_filter: Option<&str>,
    now: i64,
    offset: usize,
) -> rusqlite::Result<Vec<Entry>> {
    let removed = prune(db, now)?;
    media::delete_unused(media_root, db, &removed);
    let words: Vec<String> = query
        .split_whitespace()
        .take(12)
        .map(|s| s.to_owned())
        .collect();
    let mut sql =
        "SELECT id,body,source,at,pinned,kind,width,height,bytes,thumb,ocr FROM clips WHERE 1"
            .to_owned();
    match kind_filter {
        Some("text") => sql.push_str(" AND kind='text'"),
        Some("image") => sql.push_str(" AND kind='image'"),
        _ => {}
    }
    for n in 1..=words.len() {
        sql.push_str(&format!(
            " AND (instr(lower(body),lower(?{n}))>0 OR instr(lower(source),lower(?{n}))>0 OR instr(lower(ocr),lower(?{n}))>0)"
        ));
    }
    sql.push_str(&format!(
        " ORDER BY pinned DESC,at DESC,id DESC LIMIT 30 OFFSET {}",
        offset.min(1000000)
    ));
    let mut stmt = db.prepare(&sql)?;
    let rows = stmt.query_map(rusqlite::params_from_iter(words.iter()), |r| {
        let body: String = r.get(1)?;
        let kind: String = r.get(5)?;
        let is_image = kind == "image";
        let width: u32 = r.get(6)?;
        let height: u32 = r.get(7)?;
        let bytes: i64 = r.get(8)?;
        let thumb_name: String = r.get(9)?;
        let ocr: String = r.get(10)?;
        let ocr_preview = if is_image && !ocr.trim().is_empty() {
            Some(preview(&ocr, &words))
        } else {
            None
        };
        let thumb = if is_image {
            media::read_data_url(media_root, &thumb_name, "image/webp")
        } else {
            None
        };
        let link = !is_image && (body.starts_with("https://") || body.starts_with("http://"));
        Ok(Entry {
            id: r.get(0)?,
            kind,
            preview: if is_image {
                ocr_preview.clone().unwrap_or(body)
            } else {
                preview(&body, &words)
            },
            source: r.get(2)?,
            at: r.get(3)?,
            pinned: r.get(4)?,
            link,
            width: is_image.then_some(width),
            height: is_image.then_some(height),
            bytes: is_image.then_some(bytes.max(0) as u64),
            thumb,
            ocr_preview,
        })
    })?;
    rows.collect()
}

pub fn get_detail(
    db: &Connection,
    media_root: &Path,
    id: i64,
    now: i64,
) -> rusqlite::Result<Option<Detail>> {
    let removed = prune(db, now)?;
    media::delete_unused(media_root, db, &removed);
    db.query_row(
        "SELECT id,kind,body,width,height,bytes,media,ocr FROM clips WHERE id=?1",
        params![id],
        |r| {
            let kind: String = r.get(1)?;
            let body: String = r.get(2)?;
            let width: u32 = r.get(3)?;
            let height: u32 = r.get(4)?;
            let bytes: i64 = r.get(5)?;
            let media_name: String = r.get(6)?;
            let ocr: String = r.get(7)?;
            if kind == "image" {
                Ok(Detail {
                    id: r.get(0)?,
                    kind,
                    text: None,
                    image_data_url: media::read_data_url(media_root, &media_name, "image/png"),
                    width: Some(width),
                    height: Some(height),
                    bytes: Some(bytes.max(0) as u64),
                    ocr: (!ocr.trim().is_empty()).then_some(ocr),
                })
            } else {
                Ok(Detail {
                    id: r.get(0)?,
                    kind,
                    text: Some(body),
                    image_data_url: None,
                    width: None,
                    height: None,
                    bytes: None,
                    ocr: None,
                })
            }
        },
    )
    .optional()
}

pub fn get_payload(
    db: &Connection,
    media_root: &Path,
    id: i64,
    now: i64,
) -> rusqlite::Result<Option<ClipPayload>> {
    let removed = prune(db, now)?;
    media::delete_unused(media_root, db, &removed);
    let row: Option<(String, String, String)> = db
        .query_row(
            "SELECT kind, body, media FROM clips WHERE id=?1",
            params![id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    match row {
        Some((kind, _, media_name)) if kind == "image" => {
            Ok(media::read_bytes(media_root, &media_name).map(|png| ClipPayload::Image { png }))
        }
        Some((_, body, _)) => Ok(Some(ClipPayload::Text(body))),
        None => Ok(None),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{codecs::png::PngEncoder, ColorType, ImageEncoder, RgbaImage};

    fn make_png(w: u32, h: u32, r: u8) -> Vec<u8> {
        let mut img = RgbaImage::new(w, h);
        for px in img.pixels_mut() {
            *px = image::Rgba([r, 80, 160, 255]);
        }
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(img.as_raw(), w, h, ColorType::Rgba8.into())
            .unwrap();
        out
    }

    #[test]
    fn retention_survives_restart_and_protects_pinned_entries() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("history");
        let media_root = media::media_dir(&path);
        let mut db = open(&path).unwrap();
        db.execute(
            "INSERT INTO preferences VALUES (1,?1)",
            [r#"{"enabled":true,"excluded":"Safari"}"#],
        )
        .unwrap();
        let legacy = preferences(&path).unwrap();
        assert_eq!(legacy.retention_days, 7);
        assert!(legacy.save_images);
        assert!(legacy.ocr_images);
        let mut prefs = legacy;
        prefs.retention_days = 30;
        configure(&db, &prefs).unwrap();
        for text in ["ordinary", "pinned"] {
            insert(&mut db, text, "Fixture", DAY).unwrap();
        }
        db.execute("UPDATE clips SET pinned=1 WHERE body='pinned'", [])
            .unwrap();
        drop(db);
        let db = open(&path).unwrap();
        assert_eq!(search(&db, &media_root, "", None, 26 * DAY, 0).unwrap().len(), 2);
        prefs.retention_days = 0;
        configure(&db, &prefs).unwrap();
        assert_eq!(search(&db, &media_root, "", None, 500 * DAY, 0).unwrap().len(), 2);
        prefs.retention_days = 1;
        configure(&db, &prefs).unwrap();
        let left = search(&db, &media_root, "", None, 500 * DAY, 0).unwrap();
        assert_eq!(left.len(), 1);
        assert!(left[0].pinned);
    }

    #[test]
    fn short_words_match_together_and_pins_survive_expiry_and_duplicates() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("fixture");
        let media_root = media::media_dir(&path);
        let mut db = open(&path).unwrap();
        for (text, src) in [
            ("机场旅客问卷", "Notes"),
            ("机场天气", "Safari"),
            ("链接", "ExampleApp"),
        ] {
            insert(&mut db, text, src, 100).unwrap();
        }
        assert_eq!(search(&db, &media_root, "机场 问卷", None, 101, 0).unwrap().len(), 1);
        assert_eq!(search(&db, &media_root, "exampleapp", None, 101, 0).unwrap().len(), 1);
        db.execute("UPDATE clips SET pinned=1 WHERE body='机场旅客问卷'", [])
            .unwrap();
        insert(&mut db, "机场旅客问卷", "Notes", 102).unwrap();
        let rows = search(&db, &media_root, "", None, 7 * DAY + 200, 0).unwrap();
        assert_eq!(rows.len(), 1);
        assert!(rows[0].pinned);
    }

    #[test]
    fn image_storage_deduplicates_searches_ocr_and_cleans_media_files() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("clipboard.sqlite3");
        let media_root = media::media_dir(&path);
        let mut db = open(&path).unwrap();

        insert(&mut db, "hello world", "Notes", 100).unwrap();
        let img1 = media::prepare_png(make_png(320, 180, 10)).unwrap();
        media::write_media_files(&media_root, &img1).unwrap();
        let ins1 = insert_image(&mut db, &img1, "com.apple.screencapture", 200).unwrap();
        assert!(ins1.needs_ocr);
        assert!(media_root.join(&img1.media_name).exists());
        assert!(media_root.join(&img1.thumb_name).exists());

        // Add OCR text and verify search matches image by OCR text and kind filter
        update_ocr(&db, ins1.id, "订单号 20261121 支付成功").unwrap();
        let hits = search(&db, &media_root, "订单号 成功", Some("image"), 201, 0).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].kind, "image");
        assert!(hits[0].thumb.as_deref().unwrap().starts_with("data:image/webp;base64,"));
        assert!(hits[0].ocr_preview.as_deref().unwrap().contains("订单号"));

        // Duplicate insert preserves OCR text and does not require re-OCR
        let ins_dup = insert_image(&mut db, &img1, "Preview", 300).unwrap();
        assert_eq!(ins_dup.id, ins1.id);
        assert!(!ins_dup.needs_ocr);

        // Legacy query compatibility (rollback safety)
        let legacy_body: String = db
            .query_row("SELECT body FROM clips WHERE id=?1", [ins1.id], |r| r.get(0))
            .unwrap();
        assert_eq!(legacy_body, "320×180");

        // Deleting the row removes its disk files
        let removed = delete_by_id(&db, ins1.id).unwrap();
        media::delete_unused(&media_root, &db, &removed);
        assert!(!media_root.join(&img1.media_name).exists());
        assert!(!media_root.join(&img1.thumb_name).exists());
        // Text entry remains intact
        assert_eq!(search(&db, &media_root, "", Some("text"), 301, 0).unwrap().len(), 1);
    }

    #[test]
    fn batch_delete_removes_selected_rows_and_orphaned_media() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("clipboard.sqlite3");
        let media_root = media::media_dir(&path);
        let mut db = open(&path).unwrap();

        insert(&mut db, "alpha", "Notes", 100).unwrap();
        insert(&mut db, "beta", "Notes", 200).unwrap();
        let img1 = media::prepare_png(make_png(160, 90, 20)).unwrap();
        media::write_media_files(&media_root, &img1).unwrap();
        let ins1 = insert_image(&mut db, &img1, "Preview", 300).unwrap();
        let img2 = media::prepare_png(make_png(160, 90, 80)).unwrap();
        media::write_media_files(&media_root, &img2).unwrap();
        let ins2 = insert_image(&mut db, &img2, "Preview", 400).unwrap();

        let all = search(&db, &media_root, "", None, 401, 0).unwrap();
        assert_eq!(all.len(), 4);
        let alpha_id = all.iter().find(|r| r.preview == "alpha").unwrap().id;

        let removed = delete_many(&mut db, &[alpha_id, ins1.id]).unwrap();
        media::delete_unused(&media_root, &db, &removed);

        let left = search(&db, &media_root, "", None, 402, 0).unwrap();
        assert_eq!(left.len(), 2);
        assert!(left.iter().any(|r| r.preview == "beta"));
        assert!(left.iter().any(|r| r.id == ins2.id));
        assert!(!media_root.join(&img1.media_name).exists());
        assert!(!media_root.join(&img1.thumb_name).exists());
        assert!(media_root.join(&img2.media_name).exists());
        assert!(media_root.join(&img2.thumb_name).exists());
    }

    #[test]
    fn touch_bumps_older_entry_to_top_without_duplicating_or_changing_source() {
        let tmp = tempfile::tempdir().unwrap();
        let path = tmp.path().join("clipboard.sqlite3");
        let media_root = media::media_dir(&path);
        let mut db = open(&path).unwrap();

        insert(&mut db, "older", "Safari", 100).unwrap();
        insert(&mut db, "newer", "Notes", 200).unwrap();
        insert(&mut db, "pinned", "Terminal", 50).unwrap();
        let before = search(&db, &media_root, "", None, 201, 0).unwrap();
        let pinned_id = before.iter().find(|r| r.preview == "pinned").unwrap().id;
        let older_id = before.iter().find(|r| r.preview == "older").unwrap().id;
        db.execute("UPDATE clips SET pinned=1 WHERE id=?1", [pinned_id])
            .unwrap();

        assert_eq!(touch(&db, older_id, 300).unwrap(), 1);
        let after = search(&db, &media_root, "", None, 301, 0).unwrap();
        assert_eq!(after.len(), 3, "touch must never duplicate rows");
        assert_eq!(after[0].preview, "pinned");
        assert_eq!(after[1].preview, "older");
        assert_eq!(after[1].source, "Safari", "original source must be preserved");
        assert_eq!(after[1].at, 300);
        assert_eq!(after[2].preview, "newer");
    }
}
