use crate::companion::Companion;
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;
type R<T> = Result<T, String>;
fn db(dir: &Path) -> R<Connection> {
    let mut c = Connection::open(dir.join("usage.sqlite3")).map_err(|e| e.to_string())?;
    c.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    c.execute_batch("PRAGMA journal_mode=WAL;CREATE TABLE IF NOT EXISTS totals(day TEXT NOT NULL,purpose TEXT NOT NULL,tokens INTEGER NOT NULL,cost REAL NOT NULL,unknown INTEGER NOT NULL,PRIMARY KEY(day,purpose));CREATE TABLE IF NOT EXISTS warnings(day TEXT PRIMARY KEY);").map_err(|e|e.to_string())?;
    let version: i64 = c
        .query_row("PRAGMA user_version", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    if version == 0 {
        let tx = c
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        tx.execute_batch("CREATE TABLE IF NOT EXISTS daily_usage(
            day TEXT PRIMARY KEY, tokens INTEGER, cache_read INTEGER, cost_usd REAL,
            missing_tokens INTEGER NOT NULL, missing_cache INTEGER NOT NULL, missing_cost INTEGER NOT NULL);
            INSERT OR IGNORE INTO daily_usage
            SELECT day,sum(tokens),NULL,sum(CASE WHEN unknown=0 OR cost>0 THEN cost END),
                   0,1,max(unknown>0) FROM totals GROUP BY day;
            PRAGMA user_version=1;").map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    Ok(c)
}
fn today() -> String {
    chrono::Local::now().format("%Y-%m-%d").to_string()
}
pub fn record(dir: &Path, day: &str, v: &Value) -> R<()> {
    if !matches!(
        v["purpose"].as_str(),
        Some("scheduled" | "chat" | "translate" | "vision" | "review" | "proactive")
    ) {
        return Err("未知用量分类".into());
    }
    let counter = |key: &str| -> R<Option<i64>> {
        if v[key].is_null() {
            return Ok(None);
        }
        v[key]
            .as_i64()
            .filter(|n| *n >= 0)
            .map(Some)
            .ok_or_else(|| "token 数无效".into())
    };
    let tokens = counter("tokens")?;
    let cache = counter("cacheRead")?;
    let cost = v["cost"].as_f64().filter(|n| n.is_finite() && *n >= 0.0);
    // SUM over no known measurements stays NULL. Keep presence independent of the amount.
    db(dir)?.execute("INSERT INTO daily_usage VALUES(?1,?2,?3,?4,?2 IS NULL,?3 IS NULL,?4 IS NULL)
        ON CONFLICT(day) DO UPDATE SET
        tokens=CASE WHEN tokens IS NOT NULL OR ?2 IS NOT NULL THEN coalesce(tokens,0)+coalesce(?2,0) END,
        cache_read=CASE WHEN cache_read IS NOT NULL OR ?3 IS NOT NULL THEN coalesce(cache_read,0)+coalesce(?3,0) END,
        cost_usd=CASE WHEN cost_usd IS NOT NULL OR ?4 IS NOT NULL THEN coalesce(cost_usd,0)+coalesce(?4,0) END,
        missing_tokens=max(missing_tokens,excluded.missing_tokens),
        missing_cache=max(missing_cache,excluded.missing_cache),
        missing_cost=max(missing_cost,excluded.missing_cost)", params![day,tokens,cache,cost]).map_err(|e| e.to_string())?;
    Ok(())
}
fn budget(dir: &Path, day: &str, limit: u64, warn: bool) -> R<Value> {
    if limit == 0 {
        return Ok(json!({"reached":false,"warn":false}));
    }
    let mut c = db(dir)?;
    let t = c
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let used: u64 = t
        .query_row(
            "SELECT coalesce(sum(tokens),0) FROM daily_usage WHERE day=?",
            [day],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    let reached = used >= limit;
    let notify = reached
        && warn
        && t.execute("INSERT OR IGNORE INTO warnings VALUES(?)", [day])
            .map_err(|e| e.to_string())?
            > 0;
    t.commit().map_err(|e| e.to_string())?;
    Ok(json!({"reached":reached,"warn":notify}))
}
pub fn allowed(dir: &Path, limit: u64) -> bool {
    budget(dir, &today(), limit, false)
        .map(|v| v["reached"] == false)
        .unwrap_or(false)
}
pub fn host(dir: &Path, method: &str, v: &Value, limit: u64) -> R<Value> {
    if method == "host.usage" {
        record(dir, &today(), v)?;
        return Ok(Value::Null);
    }
    budget(dir, &today(), limit, v["warn"] == true)
}
pub fn view(dir: &Path, day: &str) -> R<Value> {
    let c = db(dir)?;
    let mut query = c
        .prepare(
            "SELECT count(*),sum(tokens),sum(cache_read),sum(cost_usd),
        max(missing_tokens),max(missing_cache),max(missing_cost)
        FROM daily_usage WHERE day BETWEEN ?1 AND ?2",
        )
        .map_err(|e| e.to_string())?;
    let mut period = |start: &str| -> R<Value> {
        query
            .query_row(params![start, day], |r| {
                let empty = r.get::<_, i64>(0)? == 0;
                let count = |i| -> rusqlite::Result<Option<i64>> {
                    if empty {
                        Ok(Some(0))
                    } else {
                        r.get(i)
                    }
                };
                let usd: Option<f64> = if empty { Some(0.0) } else { r.get(3)? };
                Ok(
                    json!({"tokens":count(1)?,"cacheRead":count(2)?,"costUsd":usd,
                "missingTokens":r.get::<_, Option<bool>>(4)?.unwrap_or(false),
                "missingCache":r.get::<_, Option<bool>>(5)?.unwrap_or(false),
                "missingCost":r.get::<_, Option<bool>>(6)?.unwrap_or(false)}),
                )
            })
            .map_err(|e| e.to_string())
    };
    Ok(json!({"today":period(day)?, "month":period(&format!("{}-01",&day[..7]))?}))
}
#[tauri::command]
pub fn companion_usage(state: tauri::State<Companion>) -> R<Value> {
    view(&state.dir, &today())
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn preserves_old_totals_and_distinguishes_missing_from_zero() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        Connection::open(d.join("usage.sqlite3")).unwrap().execute_batch(
          "CREATE TABLE totals(day TEXT,purpose TEXT,tokens INTEGER,cost REAL,unknown INTEGER,PRIMARY KEY(day,purpose));
           INSERT INTO totals VALUES('2026-11-01','chat',100,0.02,0);").unwrap();
        let day = "2026-11-07";
        assert_eq!(view(d, day).unwrap()["today"]["tokens"], 0);
        record(
            d,
            day,
            &json!({"purpose":"chat","tokens":null,"cacheRead":null,"cost":null}),
        )
        .unwrap();
        let old = view(d, day).unwrap();
        assert!(old["today"]["tokens"].is_null());
        assert!(old["month"]["cacheRead"].is_null());
        assert_eq!(old["month"]["tokens"], 100);
        assert_eq!(old["month"]["missingTokens"], true);
        record(
            d,
            day,
            &json!({"purpose":"vision","tokens":12,"cacheRead":0,"cost":0}),
        )
        .unwrap();
        let mixed = view(d, day).unwrap();
        assert_eq!(mixed["today"]["cacheRead"], 0);
        assert_eq!(mixed["month"]["missingCache"], true);
        assert_eq!(mixed["month"]["tokens"], 112);
        assert_eq!(mixed["month"]["costUsd"], 0.02);
        record(
            d,
            "2026-12-01",
            &json!({"purpose":"chat","tokens":80,"cacheRead":30,"cost":0.1}),
        )
        .unwrap();
        let next = view(d, "2026-12-01").unwrap();
        assert_eq!(next["month"]["cacheRead"], 30);
        assert_eq!(next["month"]["missingCache"], false);
        assert_eq!(next["month"]["tokens"], 80);
    }
    #[test]
    fn day_month_unknown_price_and_once_only_warning() {
        let t = tempfile::tempdir().unwrap();
        let d = t.path();
        for (day, p, tokens, cost) in [
            ("2026-10-30", "review", 7, Some(0.15)),
            ("2026-11-01", "translate", 2, Some(0.03)),
            ("2026-11-05", "chat", 20, None),
            ("2026-11-05", "translate", 3, Some(0.02)),
        ] {
            record(d, day, &json!({"purpose":p,"tokens":tokens,"cost":cost})).unwrap();
        }
        let rows = view(d, "2026-11-05").unwrap();
        assert_eq!(rows["today"]["costUsd"], 0.02);
        assert_eq!(rows["today"]["missingCost"], true);
        assert_eq!(rows["month"]["tokens"], 25);
        assert_eq!(budget(d, "2026-11-05", 23, false).unwrap()["reached"], true);
        assert_eq!(budget(d, "2026-11-05", 23, true).unwrap()["warn"], true);
        assert_eq!(budget(d, "2026-11-05", 23, true).unwrap()["warn"], false);
        assert_eq!(budget(d, "2026-11-06", 23, true).unwrap()["reached"], false);
    }
}
