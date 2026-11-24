// One reservation per outgoing query, including concurrent calls and retries.
use rusqlite::params;
use std::path::Path;
pub fn reserve(dir: &Path, day: &str, limit: u64) -> Result<bool, String> {
    if limit == 0 {
        return Ok(false);
    }
    let db = crate::history::open(dir).map_err(|e| e.to_string())?;
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS daily_search(day TEXT PRIMARY KEY, used INTEGER NOT NULL)",
    )
    .map_err(|e| e.to_string())?;
    db.execute("INSERT INTO daily_search VALUES(?1,1) ON CONFLICT(day) DO UPDATE SET used=used+1 WHERE used<?2", params![day,limit])
        .map(|n|n==1).map_err(|e|e.to_string())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn persists_and_resets_on_new_day() {
        let tmp = tempfile::tempdir().unwrap();
        for (day, expected) in [("a", true), ("a", false), ("b", true)] {
            assert_eq!(reserve(tmp.path(), day, 1).unwrap(), expected);
        }
    }
}
