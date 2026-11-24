use super::*;
use std::sync::{
    atomic::{AtomicUsize, Ordering},
    Arc, Barrier,
};

#[test]
fn an_old_temporary_name_does_not_block_a_new_save() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("settings.json");
    fs::create_dir(target.with_extension("json.tmp")).unwrap();
    write_json(&target, &serde_json::json!({"saved":true})).unwrap();
    assert_eq!(
        fs::read_to_string(target).unwrap(),
        "{\n  \"saved\": true\n}"
    );
}

struct Observed(Arc<AtomicUsize>, Arc<AtomicUsize>);
impl Serialize for Observed {
    fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        let count = self.0.fetch_add(1, Ordering::SeqCst) + 1;
        self.1.fetch_max(count, Ordering::SeqCst);
        std::thread::sleep(std::time::Duration::from_millis(30));
        self.0.fetch_sub(1, Ordering::SeqCst);
        serializer.serialize_u8(1)
    }
}

#[test]
fn one_global_lock_serializes_writes_even_for_different_files() {
    let dir = tempfile::tempdir().unwrap();
    let active = Arc::new(AtomicUsize::new(0));
    let peak = Arc::new(AtomicUsize::new(0));
    let start = Arc::new(Barrier::new(4));
    let jobs: Vec<_> = (0..4)
        .map(|i| {
            let (active, peak, start) = (active.clone(), peak.clone(), start.clone());
            let path = dir.path().join(format!("{i}.json"));
            std::thread::spawn(move || {
                start.wait();
                if i % 2 == 0 {
                    write_json(&path, &Observed(active, peak))
                } else {
                    write_new_json(&path, &Observed(active, peak))
                }
            })
        })
        .collect();
    for j in jobs {
        j.join().unwrap().unwrap();
    }
    assert_eq!(peak.load(Ordering::SeqCst), 1);
}

#[test]
fn concurrent_updates_leave_a_complete_document() {
    let dir = tempfile::tempdir().unwrap();
    let target = dir.path().join("shared.json");
    let jobs: Vec<_> = (0..4)
        .map(|id| {
            let target = target.clone();
            std::thread::spawn(move || {
                for _ in 0..20 {
                    write_json(
                        &target,
                        &serde_json::json!({"id":id,"body":"x".repeat(4096)}),
                    )?;
                }
                Ok::<_, String>(())
            })
        })
        .collect();
    for j in jobs {
        j.join().unwrap().unwrap();
    }
    let value: serde_json::Value = serde_json::from_slice(&fs::read(target).unwrap()).unwrap();
    assert_eq!(value["body"].as_str().unwrap().len(), 4096);
}
