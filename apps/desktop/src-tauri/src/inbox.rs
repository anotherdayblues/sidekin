//! The inbox: how makers outside the app (Codex skills today, other tools
//! later) hand things to Pet Studio. See docs/收件箱约定.md.
//!
//! A maker writes a folder as `inbox/.tmp-<name>` and renames it to
//! `inbox/<name>` when complete. The app picks it up, decides what it is
//! from the manifest inside, and answers with a receipt:
//! `inbox/.done-<name>.json` on success, `inbox/.failed-<name>/error.txt`
//! when the package was refused (the folder is kept for inspection).
use crate::locale::t;
use crate::{library, teaching};
use serde::Serialize;
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Arrival {
    Tool {
        id: String,
        ticket: String,
        status: String,
    },
    /// A pet package (`pet.json`): imported, or updated when the id exists.
    #[serde(rename_all = "camelCase")]
    Pet {
        pet_id: String,
        name: String,
        updated: bool,
    },
    /// A teaching (`teaching.json`): becomes a draft awaiting the user.
    #[serde(rename_all = "camelCase")]
    Teaching {
        pet_id: String,
        draft_id: String,
        summary: String,
    },
}

/// Decide what a delivered folder is and take it in.
fn receive(root: &Path, dir: &Path) -> Result<Arrival, String> {
    if dir.is_symlink() {
        return Err("收件箱拒收符号链接".into());
    }
    if fs::symlink_metadata(dir.join("tool.json")).is_ok() {
        let ticket = dir
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("投递编号无效")?;
        let id = crate::tool_cards::receive(root, dir, ticket)?;
        return Ok(Arrival::Tool {
            id,
            ticket: ticket.into(),
            status: "received".into(),
        });
    }
    if dir.join("pet.json").is_file() {
        let r = library::import(root, dir)?;
        return Ok(Arrival::Pet {
            pet_id: r.pet.id,
            name: r.pet.display_name,
            updated: r.updated,
        });
    }
    if dir.join("teaching.json").is_file() {
        let d = teaching::intake(root, dir)?;
        return Ok(Arrival::Teaching {
            pet_id: d.pet_id,
            draft_id: d.id,
            summary: d.summary,
        });
    }
    Err(t("host.unknownPackage").into())
}

/// Take in every finished folder; returns what arrived or why it failed.
pub fn scan(root: &Path) -> Vec<Result<Arrival, String>> {
    let inbox = root.join("inbox");
    let Ok(entries) = fs::read_dir(&inbox) else {
        return vec![];
    };
    let mut out = vec![];
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        if name.starts_with('.') {
            prune(&path);
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        let result = receive(root, &path);
        match &result {
            Ok(arrival) => {
                let _ = library::write_json(&inbox.join(format!(".done-{name}.json")), arrival);
                let _ = fs::remove_dir_all(&path);
            }
            Err(err) => {
                let failed = inbox.join(format!(".failed-{name}"));
                let _ = fs::remove_dir_all(&failed);
                if fs::rename(&path, &failed).is_ok() {
                    let _ = fs::write(failed.join("error.txt"), err);
                }
            }
        }
        out.push(result);
    }
    out
}

/// Receipts, refused folders and abandoned `.tmp-` staging dirs are cleared after a day.
fn prune(path: &Path) {
    prune_older_than(path, Duration::from_secs(24 * 3600));
}

fn prune_older_than(path: &Path, max_age: Duration) {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    if !(name.starts_with(".decision-")
        || name.starts_with(".done-")
        || name.starts_with(".failed-")
        || name.starts_with(".tmp-"))
    {
        return;
    }
    let old = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age >= max_age);
    if old {
        let _ = if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for e in fs::read_dir(from).unwrap().flatten() {
            if e.path().is_file() {
                fs::copy(e.path(), to.join(e.file_name())).unwrap();
            }
        }
    }
    #[test]
    fn pet_packages_arrive_with_a_receipt() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let mika = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/mika");
        copy_dir(&mika, &root.join("inbox/mika-1"));
        let arrived = scan(root);
        assert!(matches!(
            &arrived[0],
            Ok(Arrival::Pet { updated: false, .. })
        ));
        assert!(!root.join("inbox/mika-1").exists());
        let receipt = fs::read_to_string(root.join("inbox/.done-mika-1.json")).unwrap();
        assert!(receipt.contains("\"kind\": \"pet\""), "{receipt}");
        assert_eq!(library::list(root).unwrap().len(), 1);
        // The same pet delivered again updates it instead of duplicating.
        copy_dir(&mika, &root.join("inbox/mika-2"));
        assert!(matches!(
            &scan(root)[0],
            Ok(Arrival::Pet { updated: true, .. })
        ));
        assert_eq!(library::list(root).unwrap().len(), 1);
    }
    #[test]
    fn refused_packages_explain_themselves() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        fs::create_dir_all(root.join("inbox/broken")).unwrap();
        fs::write(root.join("inbox/broken/teaching.json"), "{}").unwrap();
        fs::create_dir_all(root.join("inbox/mystery")).unwrap();
        fs::create_dir_all(root.join("inbox/.tmp-unfinished")).unwrap();
        let results = scan(root);
        assert_eq!(results.len(), 2, "unfinished folders are left alone");
        assert!(results.iter().all(Result::is_err));
        assert!(root.join("inbox/.failed-broken/error.txt").exists());
        let why = fs::read_to_string(root.join("inbox/.failed-mystery/error.txt")).unwrap();
        assert!(why.contains("pet.json"));
        assert!(root.join("inbox/.tmp-unfinished").exists());
        prune_older_than(&root.join("inbox/.tmp-unfinished"), Duration::ZERO);
        assert!(!root.join("inbox/.tmp-unfinished").exists());
    }
}
