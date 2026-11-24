//! 发到手机: the files the user chose to send to the phone, newest first.
//! The phone page lists these, not everything on the pet, and fetches each
//! by an id that never changes, so a list that changed meanwhile can never
//! hand it a different file.
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Condvar, Mutex};
use std::time::Duration;

/// Enough for a day's sending; the oldest drop off.
const KEEP: usize = 50;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Sent {
    pub id: String,
    pub path: PathBuf,
    /// When it was sent, in ms: files sent together share it, so the page
    /// can group them.
    pub at: i64,
}

#[derive(Default, Debug)]
pub struct List {
    items: Vec<Sent>,
    /// Goes up on every change; the page's long poll waits for it.
    pub version: u64,
}

impl List {
    /// Adds files, newest first. A file sent again moves to the top with a
    /// new id, so the phone shows it as new.
    pub fn add(&mut self, paths: &[PathBuf], mut id: impl FnMut() -> String, at: i64) -> usize {
        let mut added = 0;
        for path in paths {
            self.items.retain(|s| &s.path != path);
            self.items.insert(
                0,
                Sent {
                    id: id(),
                    path: path.clone(),
                    at,
                },
            );
            added += 1;
        }
        self.items.truncate(KEEP);
        if added > 0 {
            self.version += 1;
        }
        added
    }
    /// The list as it was saved: files no longer there are left out.
    pub fn restore(&mut self, saved: Vec<Sent>) {
        self.items = saved.into_iter().filter(|s| s.path.is_file()).collect();
        self.items.truncate(KEEP);
    }
    pub fn get(&self, id: &str) -> Option<&Path> {
        self.items
            .iter()
            .find(|s| s.id == id)
            .map(|s| s.path.as_path())
    }
    pub fn items(&self) -> &[Sent] {
        &self.items
    }
}

#[derive(Default)]
pub struct Outbox {
    pub list: Mutex<List>,
    changed: Condvar,
    /// Read back from the settings file once, on first use.
    pub restored: AtomicBool,
}

impl Outbox {
    pub fn add(&self, paths: &[PathBuf], id: impl FnMut() -> String, at: i64) -> usize {
        let added = self.list.lock().unwrap().add(paths, id, at);
        self.changed.notify_all();
        added
    }
    /// Waits up to `ms` while the version is still `seen`; returns the
    /// current one. A different one (the app restarted) answers at once.
    pub fn wait(&self, seen: u64, ms: u64) -> u64 {
        let list = self.list.lock().unwrap();
        let (list, _) = self
            .changed
            .wait_timeout_while(list, Duration::from_millis(ms), |l| l.version == seen)
            .unwrap();
        list.version
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ids() -> impl FnMut() -> String {
        let mut n = 0;
        move || {
            n += 1;
            format!("id{n}")
        }
    }

    #[test]
    fn a_file_keeps_its_id_when_others_are_added() {
        // The old list was numbered by position: once a file was added the
        // phone's "number 0" became a different file.
        let mut list = List::default();
        let mut id = ids();
        list.add(&[PathBuf::from("/a.jpg")], &mut id, 0);
        let a = list.items()[0].id.clone();
        list.add(&[PathBuf::from("/b.jpg")], &mut id, 0);
        assert_eq!(list.get(&a), Some(Path::new("/a.jpg")));
        assert_eq!(list.items()[0].path, PathBuf::from("/b.jpg"));
        assert_eq!(list.get("nope"), None);
    }

    #[test]
    fn sending_again_moves_to_the_top_with_a_new_id() {
        let mut list = List::default();
        let mut id = ids();
        list.add(&[PathBuf::from("/a"), PathBuf::from("/b")], &mut id, 0);
        let old = list
            .items()
            .iter()
            .find(|s| s.path == Path::new("/a"))
            .unwrap()
            .id
            .clone();
        list.add(&[PathBuf::from("/a")], &mut id, 0);
        assert_eq!(list.items().len(), 2);
        assert_eq!(list.items()[0].path, PathBuf::from("/a"));
        assert_ne!(list.items()[0].id, old);
        assert_eq!(list.get(&old), None);
        assert_eq!(list.version, 2);
    }

    #[test]
    fn the_list_comes_back_after_a_restart_without_missing_files() {
        let dir = std::env::temp_dir().join(format!("suiban-outbox-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let (a, b) = (dir.join("a.jpg"), dir.join("b.pdf"));
        std::fs::write(&a, b"a").unwrap();
        std::fs::write(&b, b"b").unwrap();
        let mut list = List::default();
        list.add(&[a.clone(), b.clone()], ids(), 42);
        let saved = serde_json::to_string(list.items()).unwrap();
        // b was moved away while the app was closed.
        std::fs::remove_file(&b).unwrap();
        let mut after = List::default();
        after.restore(serde_json::from_str(&saved).unwrap());
        assert_eq!(after.items().len(), 1);
        let kept = &after.items()[0];
        assert_eq!((kept.path.as_path(), kept.at), (a.as_path(), 42));
        assert_eq!(after.get(&kept.id), Some(a.as_path()));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn only_the_newest_are_kept() {
        let mut list = List::default();
        let paths: Vec<PathBuf> = (0..60).map(|n| PathBuf::from(format!("/{n}"))).collect();
        list.add(&paths, ids(), 0);
        assert_eq!(list.items().len(), KEEP);
        assert_eq!(list.items()[0].path, PathBuf::from("/59"));
    }

    #[test]
    fn the_long_poll_wakes_on_a_change() {
        let outbox = std::sync::Arc::new(Outbox::default());
        let other = outbox.clone();
        let t = std::thread::spawn(move || other.wait(0, 5_000));
        std::thread::sleep(Duration::from_millis(50));
        outbox.add(&[PathBuf::from("/a")], ids(), 0);
        assert_eq!(t.join().unwrap(), 1);
        // Nothing new: it gives up after the wait.
        assert_eq!(outbox.wait(1, 10), 1);
        // A page still holding a number from before a restart: at once.
        assert_eq!(outbox.wait(7, 5_000), 1);
    }
}
