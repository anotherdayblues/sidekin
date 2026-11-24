// Raw keys live only in the OS store and process memory. JSON holds endpoint-bound references.
use crate::locale::t;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::Write,
    path::Path,
    sync::atomic::{AtomicU64, Ordering},
};
type R<T> = Result<T, String>;
pub fn endpoint(value: &str) -> R<String> {
    let url = tauri::Url::parse(value.trim()).map_err(|_| t("host.fullAddress"))?;
    if url.host().is_none()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
    {
        return Err(t("host.addressParts").into());
    }
    let host = url.host_str().unwrap_or("").trim_matches(['[', ']']);
    let local = host == "localhost"
        || host
            .parse::<std::net::IpAddr>()
            .is_ok_and(|ip| ip.is_loopback());
    if url.scheme() != "https" && !(url.scheme() == "http" && local) {
        return Err(t("host.needHttps").into());
    }
    Ok(url.as_str().trim_end_matches('/').into())
}
pub fn binding(service: &str, url: &str) -> String {
    format!(
        "{}-{:x}",
        service,
        Sha256::digest(url.trim_end_matches('/').as_bytes())
    )
}
pub(crate) fn checked_key(raw: &str) -> R<&str> {
    let key = raw.trim();
    if key.is_empty() || key.len() > 8192 || key.chars().any(|c| c.is_control()) {
        return Err(t("host.validKey").into());
    }
    Ok(key)
}
pub trait Secrets {
    fn get(&self, account: &str) -> R<Option<String>>;
    fn put(&self, account: &str, value: &str) -> R<()>;
    fn remove(&self, account: &str) -> R<()>;
}
pub struct SystemSecrets;
#[cfg(all(not(feature = "acceptance"), any(windows, target_os = "macos")))]
impl Secrets for SystemSecrets {
    fn get(&self, account: &str) -> R<Option<String>> {
        let entry = keyring::Entry::new(crate::profile::MODEL_KEYS, account)
            .map_err(|_| t("host.keychainOff"))?;
        match entry.get_password() {
            Ok(v) => Ok(Some(v)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(_) => Err(t("host.keychainRead").into()),
        }
    }
    fn put(&self, account: &str, value: &str) -> R<()> {
        keyring::Entry::new(crate::profile::MODEL_KEYS, account)
            .map_err(|_| t("host.keychainOff"))?
            .set_password(value)
            .map_err(|_| t("host.keySave").into())
    }
    fn remove(&self, account: &str) -> R<()> {
        let entry = keyring::Entry::new(crate::profile::MODEL_KEYS, account)
            .map_err(|_| t("host.keychainOff"))?;
        match entry.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(_) => Err(t("host.keyClear").into()),
        }
    }
}
#[cfg(any(feature = "acceptance", not(any(windows, target_os = "macos"))))]
impl Secrets for SystemSecrets {
    fn get(&self, _: &str) -> R<Option<String>> {
        Ok(None)
    }
    fn put(&self, _: &str, _: &str) -> R<()> {
        Err("此环境不访问系统钥匙串".into())
    }
    fn remove(&self, _: &str) -> R<()> {
        Err("此环境不访问系统钥匙串".into())
    }
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct Record {
    pending: String,
    // None identifies an old index whose used/draft versions were not distinguished.
    retained: Option<Vec<String>>,
    saved_at: u128,
    accounts: Vec<String>,
    draft: serde_json::Value,
}
#[derive(Clone, Serialize, Deserialize, Default)]
#[serde(default)]
struct Index {
    records: BTreeMap<String, Record>,
}
pub struct Store<S = SystemSecrets> {
    secrets: S,
}
impl Default for Store<SystemSecrets> {
    fn default() -> Self {
        Self {
            secrets: SystemSecrets,
        }
    }
}
impl<S: Secrets> Store<S> {
    #[cfg(test)]
    pub(crate) fn for_test(secrets: S) -> Self {
        Self { secrets }
    }

    fn index(dir: &Path) -> R<Index> {
        match fs::read(dir.join("credentials.json")) {
            Ok(b) => serde_json::from_slice(&b).map_err(|_| "凭据索引损坏".into()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Index::default()),
            Err(_) => Err("读取凭据索引失败".into()),
        }
    }
    fn persist(dir: &Path, index: &Index) -> R<()> {
        let mut temp = tempfile::NamedTempFile::new_in(dir).map_err(|_| "创建凭据索引失败")?;
        temp.write_all(&serde_json::to_vec(index).map_err(|_| "凭据索引编码失败")?)
            .and_then(|_| temp.as_file().sync_all())
            .map_err(|_| "写入凭据索引失败")?;
        temp.persist(dir.join("credentials.json"))
            .map_err(|_| "保存凭据索引失败")?;
        Ok(())
    }
    pub fn can_clear(&self, dir: &Path, id: &str) -> R<bool> {
        Ok(Self::index(dir)?.records.contains_key(id) || self.secrets.get(id)?.is_some())
    }
    pub fn pending(&self, dir: &Path, id: &str) -> R<Option<String>> {
        Ok(Self::index(dir)?.records.get(id).map(|r| r.pending.clone()))
    }
    pub fn draft(&self, dir: &Path, service: &str) -> R<Option<serde_json::Value>> {
        Ok(Self::index(dir)?
            .records
            .values()
            .filter(|r| r.draft["service"] == service)
            .max_by_key(|r| r.saved_at)
            .map(|r| r.draft.clone()))
    }
    pub fn key(&self, id: &str, reference: &str) -> R<String> {
        if reference == "none" {
            return Ok(String::new());
        }
        let account = if reference.is_empty() {
            id
        } else {
            if !reference.starts_with(&format!("{id}/")) {
                return Err("Key 与当前服务地址不匹配".into());
            }
            reference
        };
        Ok(self.secrets.get(account)?.unwrap_or_default())
    }
    pub fn save(
        &self,
        dir: &Path,
        id: &str,
        raw: &str,
        draft: serde_json::Value,
        protected: &BTreeSet<String>,
    ) -> R<String> {
        let key = checked_key(raw)?;
        let mut index = Self::index(dir)?;
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let stamp = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|_| "系统时间无效")?
            .as_nanos();
        let reference = format!(
            "{id}/{stamp:039}-{}-{}",
            std::process::id(),
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        self.secrets.put(&reference, key)?;
        if self.secrets.get(&reference).ok().flatten().as_deref() != Some(key) {
            let _ = self.secrets.remove(&reference);
            return Err("Key 写入后核对失败，原配置保留".into());
        }
        let entry = index.records.entry(id.into()).or_insert_with(|| Record {
            retained: Some(Vec::new()),
            ..Record::default()
        });
        // Older releases did not record which inactive version had been verified.
        // Keep those unknown versions until this binding is successfully activated.
        if entry.retained.is_none() {
            entry.retained = Some(entry.accounts.clone());
        }
        entry.pending = reference.clone();
        entry.saved_at = stamp;
        entry.accounts.push(reference.clone());
        entry.draft = draft;
        if let Err(e) = Self::persist(dir, &index) {
            let _ = self.secrets.remove(&reference);
            return Err(e);
        }
        self.collect(dir, id, &mut index, protected);
        Ok(reference)
    }
    // Save references before changing settings, so switching away cannot orphan a
    // working key even if a previous cleanup/index update was interrupted.
    pub fn retain_references(&self, dir: &Path, protected: &BTreeSet<String>) -> R<()> {
        let mut index = Self::index(dir)?;
        let mut changed = false;
        for (id, record) in &mut index.records {
            let Some(retained) = record.retained.as_mut() else {
                continue;
            };
            for account in protected {
                if (account == id || account.starts_with(&format!("{id}/")))
                    && !retained.contains(account)
                {
                    retained.push(account.clone());
                    changed = true;
                }
            }
        }
        if changed {
            Self::persist(dir, &index)?;
        }
        Ok(())
    }
    // Called only AFTER settings and runtime have accepted this reference.
    // A caller may ignore cleanup errors: the new key is already effective.
    pub fn activated(
        &self,
        dir: &Path,
        id: &str,
        reference: &str,
        protected: &BTreeSet<String>,
    ) -> R<()> {
        if reference.is_empty() || reference == "none" {
            return Ok(());
        }
        if !reference.starts_with(&format!("{id}/")) {
            return Err("Key 与当前服务地址不匹配".into());
        }
        let mut index = Self::index(dir)?;
        let record = index.records.get_mut(id).ok_or("缺少凭据索引")?;
        if !record.accounts.contains(&reference.to_owned()) {
            return Err("缺少凭据版本".into());
        }
        record.retained = Some(vec![reference.into()]);
        // Track the pre-versioning key too. Failed deletion is retried with the
        // other versions and never propagates a raw OS/secret error to the UI.
        if !record.accounts.iter().any(|a| a == id) {
            record.accounts.push(id.into());
        }
        Self::persist(dir, &index)?;
        self.collect(dir, id, &mut index, protected);
        Ok(())
    }
    fn collect(&self, dir: &Path, id: &str, index: &mut Index, protected: &BTreeSet<String>) {
        let Some(record) = index.records.get_mut(id) else {
            return;
        };
        let mut keep = protected.clone();
        keep.insert(record.pending.clone());
        keep.extend(
            record
                .retained
                .clone()
                .unwrap_or_else(|| record.accounts.clone()),
        );
        record.accounts.retain(|account| {
            // A corrupt index must never turn cleanup into cross-binding deletion.
            keep.contains(account)
                || !(account == id || account.starts_with(&format!("{id}/")))
                || self.secrets.remove(account).is_err()
        });
        // On metadata failure, the durable old list still contains every pending
        // deletion. Missing entries are harmless when retried next time.
        let _ = Self::persist(dir, index);
    }
    pub fn clear(&self, dir: &Path, id: &str) -> R<()> {
        let mut index = Self::index(dir)?;
        if let Some(r) = index.records.get(id) {
            for account in &r.accounts {
                if account != id && !account.starts_with(&format!("{id}/")) {
                    return Err("凭据索引的地址不符".into());
                }
                self.secrets.remove(account)?;
            }
        }
        self.secrets.remove(id)?;
        index.records.remove(id);
        Self::persist(dir, &index)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::cell::{Cell, RefCell};
    #[derive(Default)]
    struct Fake {
        values: RefCell<BTreeMap<String, String>>,
        fail: Cell<bool>,
        fail_remove: Cell<bool>,
    }
    impl Secrets for Fake {
        fn get(&self, k: &str) -> R<Option<String>> {
            Ok(self.values.borrow().get(k).cloned())
        }
        fn put(&self, k: &str, v: &str) -> R<()> {
            if self.fail.get() {
                return Err("write failed".into());
            }
            self.values.borrow_mut().insert(k.into(), v.into());
            Ok(())
        }
        fn remove(&self, k: &str) -> R<()> {
            if self.fail_remove.get() {
                return Err("fixture deletion failed".into());
            }
            self.values.borrow_mut().remove(k);
            Ok(())
        }
    }
    #[test]
    fn saved_candidate_is_durable_bound_and_does_not_replace_active() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store {
            secrets: Fake::default(),
        };
        let id = binding("custom", "https://a.example/v1");
        s.secrets.put(&id, "legacy-fixture").unwrap();
        let old = s.key(&id, "").unwrap();
        assert_eq!(old, "legacy-fixture");
        let r = s
            .save(
                dir.path(),
                &id,
                "candidate-fixture",
                json!({"service":"custom"}),
                &BTreeSet::new(),
            )
            .unwrap();
        assert_eq!(s.key(&id, "").unwrap(), old);
        assert_eq!(s.pending(dir.path(), &id).unwrap(), Some(r.clone()));
        assert_eq!(s.key(&id, &r).unwrap(), "candidate-fixture");
        assert!(s
            .key(&binding("custom", "https://b.example/v1"), &r)
            .is_err());
        let file = fs::read_to_string(dir.path().join("credentials.json")).unwrap();
        assert!(!file.contains("candidate-fixture"));
        assert!(!file.contains("legacy-fixture"));
        s.secrets.fail.set(true);
        assert!(s
            .save(
                dir.path(),
                &id,
                "wrong-fixture",
                json!({}),
                &BTreeSet::new()
            )
            .is_err());
        assert_eq!(s.pending(dir.path(), &id).unwrap(), Some(r.clone()));
        assert_eq!(s.key(&id, &r).unwrap(), "candidate-fixture");
        s.clear(dir.path(), &id).unwrap();
        assert_eq!(s.key(&id, &r).unwrap(), "");
        assert_eq!(s.key(&id, "").unwrap(), "");
    }
    #[test]
    fn metadata_write_failure_keeps_previous_key_and_discards_new_version() {
        let dir = tempfile::tempdir().unwrap();
        let s = Store {
            secrets: Fake::default(),
        };
        let id = binding("x", "https://x.example");
        let r = s
            .save(
                dir.path(),
                &id,
                "working-fixture",
                json!({}),
                &BTreeSet::new(),
            )
            .unwrap();
        // A missing destination fails before changing the candidate pointer.
        assert!(s
            .save(
                &dir.path().join("missing"),
                &id,
                "new-fixture",
                json!({}),
                &BTreeSet::new()
            )
            .is_err());
        assert_eq!(s.key(&id, &r).unwrap(), "working-fixture");
        assert_eq!(s.secrets.values.borrow().len(), 1);
    }

    fn store() -> Store<Fake> {
        Store {
            secrets: Fake::default(),
        }
    }
    fn save_fixture(s: &Store<Fake>, dir: &Path, id: &str, protected: &BTreeSet<String>) -> String {
        s.save(
            dir,
            id,
            "fixture-key",
            json!({"service":"custom"}),
            protected,
        )
        .unwrap()
    }
    #[test]
    fn three_draft_saves_and_three_activations_each_leave_only_one_version() {
        let d = tempfile::tempdir().unwrap();
        let s = store();
        let id = binding("custom", "https://a.example");
        let mut latest = String::new();
        for _ in 0..3 {
            latest = save_fixture(&s, d.path(), &id, &BTreeSet::new());
            assert_eq!(s.secrets.values.borrow().len(), 1);
            assert_eq!(
                Store::<Fake>::index(d.path()).unwrap().records[&id]
                    .accounts
                    .len(),
                1
            );
        }
        let mut used = BTreeSet::from([latest.clone()]);
        s.activated(d.path(), &id, &latest, &used).unwrap();
        for _ in 0..3 {
            latest = save_fixture(&s, d.path(), &id, &used);
            used = BTreeSet::from([latest.clone()]);
            s.activated(d.path(), &id, &latest, &used).unwrap();
            assert_eq!(s.secrets.values.borrow().len(), 1);
            assert_eq!(s.key(&id, &latest).unwrap(), "fixture-key");
        }
    }
    #[test]
    fn different_services_and_addresses_keep_their_inactive_keys() {
        let d = tempfile::tempdir().unwrap();
        let s = store();
        let a = binding("custom", "https://a.example");
        let b = binding("deepseek", "https://a.example");
        let c = binding("custom", "https://b.example");
        let ra = save_fixture(&s, d.path(), &a, &BTreeSet::new());
        s.activated(d.path(), &a, &ra, &BTreeSet::from([ra.clone()]))
            .unwrap();
        let rb = save_fixture(&s, d.path(), &b, &BTreeSet::new());
        s.activated(d.path(), &b, &rb, &BTreeSet::from([rb.clone()]))
            .unwrap();
        let rc = save_fixture(&s, d.path(), &c, &BTreeSet::new());
        s.activated(d.path(), &c, &rc, &BTreeSet::from([rc.clone()]))
            .unwrap();
        assert_eq!(s.secrets.values.borrow().len(), 3);
        for (id, r) in [(&a, &ra), (&b, &rb), (&c, &rc)] {
            assert_eq!(s.key(id, r).unwrap(), "fixture-key");
        }
        let next = save_fixture(&s, d.path(), &a, &BTreeSet::from([rc.clone()]));
        assert_eq!(s.key(&a, &ra).unwrap(), "fixture-key");
        s.activated(d.path(), &a, &next, &BTreeSet::from([next.clone()]))
            .unwrap();
        assert_eq!(s.secrets.values.borrow().len(), 3);
        assert_eq!(s.key(&b, &rb).unwrap(), "fixture-key");
    }
    #[test]
    fn failed_probe_keeps_working_key_while_later_save_replaces_only_the_draft() {
        let d = tempfile::tempdir().unwrap();
        let s = store();
        let id = binding("custom", "https://a.example");
        let old = save_fixture(&s, d.path(), &id, &BTreeSet::new());
        let used = BTreeSet::from([old.clone()]);
        s.activated(d.path(), &id, &old, &used).unwrap();
        let failed = s
            .save(d.path(), &id, "fixture-rejected", json!({}), &used)
            .unwrap();
        // A failed probe never calls activated. The saved/runtime reference stays old.
        assert_eq!(s.key(&id, &old).unwrap(), "fixture-key");
        let next = save_fixture(&s, d.path(), &id, &used);
        assert_eq!(s.key(&id, &failed).unwrap(), "");
        assert_eq!(s.key(&id, &old).unwrap(), "fixture-key");
        assert_eq!(s.key(&id, &next).unwrap(), "fixture-key");
        assert_eq!(s.secrets.values.borrow().len(), 2);
    }
    #[test]
    fn deletion_failure_does_not_reject_new_key_and_next_save_retries_it() {
        let d = tempfile::tempdir().unwrap();
        let s = store();
        let id = binding("custom", "https://a.example");
        let old = save_fixture(&s, d.path(), &id, &BTreeSet::new());
        s.activated(d.path(), &id, &old, &BTreeSet::from([old.clone()]))
            .unwrap();
        s.secrets.fail_remove.set(true);
        let new = save_fixture(&s, d.path(), &id, &BTreeSet::from([old.clone()]));
        s.activated(d.path(), &id, &new, &BTreeSet::from([new.clone()]))
            .unwrap();
        assert_eq!(s.key(&id, &new).unwrap(), "fixture-key");
        assert!(Store::<Fake>::index(d.path()).unwrap().records[&id]
            .accounts
            .contains(&old));
        s.secrets.fail_remove.set(false);
        let next = save_fixture(&s, d.path(), &id, &BTreeSet::from([new.clone()]));
        assert_eq!(s.key(&id, &old).unwrap(), "");
        assert_eq!(s.key(&id, &new).unwrap(), "fixture-key");
        s.activated(d.path(), &id, &next, &BTreeSet::from([next.clone()]))
            .unwrap();
        assert_eq!(s.secrets.values.borrow().len(), 1);
    }
    #[test]
    fn primary_fallback_and_search_references_are_all_protected() {
        use crate::companion::{BackupModel, Search, Settings};
        let d = tempfile::tempdir().unwrap();
        let s = store();
        let id = binding("custom", "https://a.example");
        let sid = binding("search-brave", "https://api.search.brave.com");
        let old = save_fixture(&s, d.path(), &id, &BTreeSet::new());
        s.activated(d.path(), &id, &old, &BTreeSet::from([old.clone()]))
            .unwrap();
        let search = save_fixture(&s, d.path(), &sid, &BTreeSet::new());
        s.activated(d.path(), &sid, &search, &BTreeSet::from([search.clone()]))
            .unwrap();
        let mut settings = Settings {
            service: "custom".into(),
            base_url: "https://a.example".into(),
            credential_ref: old.clone(),
            fallbacks: vec![BackupModel {
                service: "custom".into(),
                base_url: "https://a.example".into(),
                model: "fixture".into(),
                can_see: false,
                credential_ref: old.clone(),
            }],
            search: Some(Search {
                provider: "brave".into(),
                base_url: String::new(),
                credential_ref: search.clone(),
            }),
            ..Settings::default()
        };
        let new = save_fixture(&s, d.path(), &id, &settings.credential_accounts().unwrap());
        settings.credential_ref = new.clone();
        let used = settings.credential_accounts().unwrap();
        assert!(used.contains(&old) && used.contains(&new) && used.contains(&search));
        s.activated(d.path(), &id, &new, &used).unwrap();
        assert_eq!(s.key(&id, &old).unwrap(), "fixture-key"); // Same binding, still a fallback.
        assert_eq!(s.key(&id, &new).unwrap(), "fixture-key");
        assert_eq!(s.key(&sid, &search).unwrap(), "fixture-key");
        let search2 = save_fixture(&s, d.path(), &sid, &used);
        settings.search.as_mut().unwrap().credential_ref = search2.clone();
        s.activated(
            d.path(),
            &sid,
            &search2,
            &settings.credential_accounts().unwrap(),
        )
        .unwrap();
        assert_eq!(s.key(&sid, &search).unwrap(), "");
        assert_eq!(s.key(&id, &old).unwrap(), "fixture-key");
        assert_eq!(s.key(&id, &new).unwrap(), "fixture-key");
        assert_eq!(s.key(&sid, &search2).unwrap(), "fixture-key");
    }
    #[test]
    fn old_index_versions_and_legacy_entry_are_collected_after_successful_activation() {
        let d = tempfile::tempdir().unwrap();
        let s = store();
        let id = binding("custom", "https://a.example");
        let accounts: Vec<String> = (0..3).map(|i| format!("{id}/old-{i}")).collect();
        for r in accounts.iter().chain(std::iter::once(&id)) {
            s.secrets.put(r, "fixture-old").unwrap();
        }
        let old = json!({"records": {&id: {
            "pending": accounts[2], "accounts":accounts, "draft":{"service":"custom"}
        }}});
        fs::write(
            d.path().join("credentials.json"),
            serde_json::to_vec(&old).unwrap(),
        )
        .unwrap();
        let new = save_fixture(&s, d.path(), &id, &BTreeSet::new());
        assert_eq!(s.key(&id, &accounts[0]).unwrap(), "fixture-old");
        s.activated(d.path(), &id, &new, &BTreeSet::from([new.clone()]))
            .unwrap();
        assert_eq!(s.secrets.values.borrow().len(), 1);
        assert_eq!(
            Store::<Fake>::index(d.path()).unwrap().records[&id].accounts,
            vec![new]
        );
    }

    #[test]
    fn only_local_http_and_clean_urls() {
        for u in [
            "http://example.com/v1",
            "https://u:pass@example.com",
            "https://example.com?key=secret",
            "https://example.com/#key",
        ] {
            assert!(endpoint(u).is_err(), "{u}");
        }
        for u in [
            "http://localhost:1234/v1",
            "http://127.0.0.1:1/v1",
            "http://[::1]:8080/v1",
            "https://example.com/v1",
        ] {
            assert!(endpoint(u).is_ok(), "{u}");
        }
        assert_eq!(
            endpoint("https://EXAMPLE.COM:443/v1/").unwrap(),
            "https://example.com/v1"
        );
    }
}

#[cfg(all(test, target_os = "macos", not(feature = "acceptance")))]
mod os_check {
    #[link(name = "Security", kind = "framework")]
    unsafe extern "C" {
        fn SecKeychainSetUserInteractionAllowed(state: u8) -> i32;
    }
    #[test]
    #[ignore = "Only with the clipboard guard and a dedicated QA service"]
    fn saved_key_survives_a_new_process_and_is_removed() {
        assert_eq!(std::env::var("COMPANION_QA_GUARDED").unwrap(), "1");
        let qa = std::path::PathBuf::from(std::env::var("QA").unwrap())
            .canonicalize()
            .unwrap();
        assert_eq!(
            qa.parent().unwrap(),
            std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
                .join("../../../runs")
                .canonicalize()
                .unwrap()
        );
        assert!(qa
            .file_name()
            .unwrap()
            .to_string_lossy()
            .starts_with("companion-456."));
        // Keychain Services must fail instead of showing an authentication dialog.
        assert_eq!(unsafe { SecKeychainSetUserInteractionAllowed(0) }, 0);
        let service = format!(
            "studio.pet.companion.qa.{}",
            qa.file_name().unwrap().to_string_lossy()
        );
        let entry = keyring::Entry::new(&service, "fixture-roundtrip").unwrap();
        if std::env::var("COMPANION_KEY_TEST_READ").as_deref() == Ok("1") {
            assert_eq!(entry.get_password().unwrap(), "fixture-only-key");
            return;
        }
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
        entry.set_password("fixture-only-key").unwrap();
        let result = std::process::Command::new(std::env::current_exe().unwrap())
            .args([
                "--ignored",
                "--exact",
                "credentials::os_check::saved_key_survives_a_new_process_and_is_removed",
                "--test-threads=1",
            ])
            .env("COMPANION_KEY_TEST_READ", "1")
            .output();
        let cleanup = entry.delete_credential();
        assert!(cleanup.is_ok());
        assert!(matches!(entry.get_password(), Err(keyring::Error::NoEntry)));
        assert!(
            result.unwrap().status.success(),
            "新进程读取未通过，测试条目已清除"
        );
    }
}
