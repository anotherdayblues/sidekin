use super::*;
use crate::credentials::{binding, Secrets, Store};
use std::{cell::RefCell, collections::BTreeMap};

#[derive(Default)]
struct Fake(RefCell<BTreeMap<String, String>>);
impl Secrets for Fake {
    fn get(&self, id: &str) -> Result<Option<String>, String> {
        Ok(self.0.borrow().get(id).cloned())
    }
    fn put(&self, id: &str, key: &str) -> Result<(), String> {
        self.0.borrow_mut().insert(id.into(), key.into());
        Ok(())
    }
    fn remove(&self, id: &str) -> Result<(), String> {
        self.0.borrow_mut().remove(id);
        Ok(())
    }
}
fn backup() -> BackupModel {
    BackupModel {
        service: "custom".into(),
        base_url: "https://fixture.example/v1".into(),
        model: "fixture-model".into(),
        can_see: false,
        credential_ref: String::new(),
    }
}
fn seeded(dir: &Path, store: &Store<Fake>, search: bool) -> (Settings, String, String) {
    let mut old = Settings::default();
    if search {
        old.search = Some(Search {
            provider: "brave".into(),
            base_url: String::new(),
            credential_ref: String::new(),
        });
    } else {
        old.fallbacks.push(backup());
    }
    let account = if search {
        old.search.as_ref().unwrap().account().unwrap()
    } else {
        old.fallbacks[0].settings()
    };
    let id = binding(&account.service, &account.base_url);
    let reference = store
        .save(
            dir,
            &id,
            "fixture-working",
            json!({"service":account.service}),
            &BTreeSet::new(),
        )
        .unwrap();
    store
        .activated(dir, &id, &reference, &BTreeSet::from([reference.clone()]))
        .unwrap();
    if search {
        old.search.as_mut().unwrap().credential_ref = reference.clone();
    } else {
        old.fallbacks[0].credential_ref = reference.clone();
    }
    (old, id, reference)
}

#[test]
fn rejected_backup_or_search_key_never_replaces_the_working_key() {
    for search in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::for_test(Fake::default());
        let (old, id, reference) = seeded(dir.path(), &store, search);
        let mut next = old.clone();
        let result = stage_online_keys(
            dir.path(),
            &mut next,
            &old,
            if search {
                Some(vec![])
            } else {
                Some(vec![Some("fixture-rejected".into())])
            },
            search.then(|| "fixture-rejected".into()),
            &store,
            &mut old.credential_accounts().unwrap(),
            |_, _, _| Err("auth".into()),
        );
        // This is the command's existing activation path after a successful staging.
        if let Ok(changed) = &result {
            for (binding, reference) in changed {
                store
                    .activated(
                        dir.path(),
                        binding,
                        reference,
                        &next.credential_accounts().unwrap(),
                    )
                    .unwrap();
            }
        }
        assert!(
            !store.key(&id, &reference).unwrap().is_empty(),
            "the previously working key must stay usable"
        );
        assert!(result.is_err());
    }
}

#[test]
fn verified_replacement_is_activated_only_after_the_caller_commits() {
    for search in [false, true] {
        let dir = tempfile::tempdir().unwrap();
        let store = Store::for_test(Fake::default());
        let (old, id, reference) = seeded(dir.path(), &store, search);
        let mut next = old.clone();
        let mut probes = 0;
        let changed = stage_online_keys(
            dir.path(),
            &mut next,
            &old,
            if search {
                Some(vec![])
            } else {
                Some(vec![Some("fixture-new".into())])
            },
            search.then(|| "fixture-new".into()),
            &store,
            &mut old.credential_accounts().unwrap(),
            |_, _, is_search| {
                assert_eq!(is_search, search);
                probes += 1;
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(probes, 1);
        assert!(!store.key(&id, &reference).unwrap().is_empty());
        for (id, reference) in &changed {
            store
                .activated(
                    dir.path(),
                    id,
                    reference,
                    &next.credential_accounts().unwrap(),
                )
                .unwrap();
        }
        assert!(store.key(&id, &reference).unwrap().is_empty());
    }
}

#[test]
fn unchanged_online_settings_do_not_probe_during_an_unrelated_save() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::for_test(Fake::default());
    let (old, _, _) = seeded(dir.path(), &store, false);
    let mut next = old.clone();
    next.memory = false;
    let changed = stage_online_keys(
        dir.path(),
        &mut next,
        &old,
        None,
        None,
        &store,
        &mut old.credential_accounts().unwrap(),
        |_, _, _| panic!("unrelated save must not make a network request"),
    )
    .unwrap();
    assert!(changed.is_empty());
    next.daily_limit = 1000;
    let changed = stage_online_keys(
        dir.path(),
        &mut next,
        &old,
        Some(vec![None]),
        None,
        &store,
        &mut old.credential_accounts().unwrap(),
        |_, _, _| panic!("changing only the limit must not depend on network availability"),
    )
    .unwrap();
    assert!(changed.is_empty());
}

#[test]
fn failed_search_keeps_both_existing_keys_and_stages_no_partial_replacement() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::for_test(Fake::default());
    let (mut old, backup_id, backup_ref) = seeded(dir.path(), &store, false);
    let (search_settings, search_id, search_ref) = seeded(dir.path(), &store, true);
    old.search = search_settings.search;
    let mut next = old.clone();
    let result = stage_online_keys(
        dir.path(),
        &mut next,
        &old,
        Some(vec![Some("fixture-new".into())]),
        Some("fixture-rejected".into()),
        &store,
        &mut old.credential_accounts().unwrap(),
        |_, _, search| if search { Err("auth".into()) } else { Ok(()) },
    );
    assert!(result.is_err());
    assert_eq!(
        store.pending(dir.path(), &backup_id).unwrap(),
        Some(backup_ref.clone())
    );
    assert_eq!(
        store.pending(dir.path(), &search_id).unwrap(),
        Some(search_ref.clone())
    );
    assert!(!store.key(&backup_id, &backup_ref).unwrap().is_empty());
    assert!(!store.key(&search_id, &search_ref).unwrap().is_empty());
}

#[test]
fn reusing_a_stored_binding_still_verifies_it_before_enabling_it() {
    let dir = tempfile::tempdir().unwrap();
    let store = Store::for_test(Fake::default());
    let (_, _, reference) = seeded(dir.path(), &store, false);
    let old = Settings::default();
    let mut next = old.clone();
    next.fallbacks.push(backup());
    let mut probes = 0;
    stage_online_keys(
        dir.path(),
        &mut next,
        &old,
        Some(vec![None]),
        None,
        &store,
        &mut old.credential_accounts().unwrap(),
        |_, key, search| {
            assert!(!search && !key.is_empty());
            probes += 1;
            Ok(())
        },
    )
    .unwrap();
    assert_eq!(probes, 1);
    assert_eq!(next.fallbacks[0].credential_ref, reference);
}
