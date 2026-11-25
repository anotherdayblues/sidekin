use std::{
    collections::HashSet,
    fs::{self, File},
    io::ErrorKind,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

/// Upper bound for copying volatile/sandboxed regular files into the staging
/// cache during a drop. Larger files and directories stay as direct references
/// so drops never block the UI thread.
const MAX_STAGE_BYTES: u64 = 200 * 1024 * 1024;

static SEQ: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StageError {
    PermissionDenied,
    Missing,
    Failed,
}

fn canonical_or_self(path: &Path) -> PathBuf {
    if let Ok(canon) = fs::canonicalize(path) {
        return canon;
    }
    if let (Some(parent), Some(name)) = (path.parent(), path.file_name()) {
        if let Ok(canon_parent) = fs::canonicalize(parent) {
            return canon_parent.join(name);
        }
    }
    path.to_path_buf()
}

fn is_inside_dir(path: &Path, root: &Path) -> bool {
    if path.starts_with(root) {
        return true;
    }
    let canon_root = canonical_or_self(root);
    let canon_path = canonical_or_self(path);
    canon_path.starts_with(&canon_root)
}

fn has_component_pair(path: &Path, first: &str, second: &str) -> bool {
    let mut prev_matches = false;
    for comp in path.components() {
        if let Component::Normal(part) = comp {
            let s = part.to_string_lossy();
            if prev_matches && s.eq_ignore_ascii_case(second) {
                return true;
            }
            prev_matches = s.eq_ignore_ascii_case(first);
        } else {
            prev_matches = false;
        }
    }
    false
}

/// Returns true for macOS cross-app sandbox containers (`~/Library/Containers/...`
/// and `~/Library/Group Containers/...`) protected by macOS App Data privacy.
pub fn is_app_container(path: &Path) -> bool {
    #[cfg(target_os = "macos")]
    {
        if let Ok(home) = std::env::var("HOME") {
            let home_path = PathBuf::from(home);
            let containers = home_path.join("Library").join("Containers");
            let group_containers = home_path.join("Library").join("Group Containers");
            if path.starts_with(&containers) || path.starts_with(&group_containers) {
                return true;
            }
        }
        let normals: Vec<String> = path
            .components()
            .filter_map(|c| match c {
                Component::Normal(p) => Some(p.to_string_lossy().into_owned()),
                _ => None,
            })
            .collect();
        normals.len() >= 4
            && normals[0].eq_ignore_ascii_case("Users")
            && normals[2].eq_ignore_ascii_case("Library")
            && (normals[3].eq_ignore_ascii_case("Containers")
                || normals[3].eq_ignore_ascii_case("Group Containers"))
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = path;
        false
    }
}

/// Returns true only for volatile temp directories or cross-app sandbox paths
/// (such as macOS `~/Library/Containers/...` used by WeChat) that may vanish
/// or require immediate staging while access is available. Normal user folders
/// (Desktop, Documents, Downloads, etc.) stay zero-copy references.
pub fn needs_staging(path: &Path) -> bool {
    if has_component_pair(path, "temp", "drag") {
        return true;
    }

    #[cfg(target_os = "macos")]
    {
        if path.starts_with("/tmp")
            || path.starts_with("/private/tmp")
            || path.starts_with("/var/folders")
            || path.starts_with("/private/var/folders")
        {
            return true;
        }
        let sys_tmp = std::env::temp_dir();
        if !sys_tmp.as_os_str().is_empty() && path.starts_with(&sys_tmp) {
            return true;
        }
        is_app_container(path)
    }

    #[cfg(not(target_os = "macos"))]
    {
        let sys_tmp = std::env::temp_dir();
        if !sys_tmp.as_os_str().is_empty()
            && (path.starts_with(&sys_tmp) || is_inside_dir(path, &sys_tmp))
        {
            return true;
        }
        #[cfg(unix)]
        if path.starts_with("/tmp") {
            return true;
        }
        false
    }
}

/// Checks whether a file or directory can actually be opened for reading.
/// Returns `Ok(())` when readable, `Err(true)` on `PermissionDenied` (e.g.
/// macOS TCC `EPERM` even when `stat`/`exists` succeeds), and `Err(false)` on
/// missing or other errors.
pub fn is_readable(path: &Path) -> Result<(), bool> {
    let meta = match fs::metadata(path) {
        Ok(m) => m,
        Err(e) => return Err(e.kind() == ErrorKind::PermissionDenied),
    };
    if meta.is_dir() {
        fs::read_dir(path)
            .map(|_| ())
            .map_err(|e| e.kind() == ErrorKind::PermissionDenied)
    } else {
        File::open(path)
            .map(|_| ())
            .map_err(|e| e.kind() == ErrorKind::PermissionDenied)
    }
}

#[cfg(target_os = "macos")]
extern "C" {
    fn clonefile(
        src: *const std::ffi::c_char,
        dst: *const std::ffi::c_char,
        flags: u32,
    ) -> std::ffi::c_int;
}

fn clone_or_copy(src: &Path, dst: &Path) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    {
        use std::ffi::CString;
        use std::os::unix::ffi::OsStrExt;
        if let (Ok(c_src), Ok(c_dst)) = (
            CString::new(src.as_os_str().as_bytes()),
            CString::new(dst.as_os_str().as_bytes()),
        ) {
            // Zero-copy APFS clone when on the same APFS volume. If clonefile
            // fails (EPERM/EXDEV/ENOTSUP, e.g. cross-container xattrs/ACLs even
            // when reading is allowed), fall back to fs::copy below; PermissionDenied
            // is only reported if fs::copy also fails with PermissionDenied.
            if unsafe { clonefile(c_src.as_ptr(), c_dst.as_ptr(), 0) } == 0 {
                return Ok(());
            }
        }
    }
    fs::copy(src, dst).map(|_| ())
}

fn unique_subdir_name() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let seq = SEQ.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:x}-{:x}-{seq:x}", std::process::id())
}

/// Stages a dropped path into `staged_root/<unique>/<filename>` if it lives in
/// a volatile/sandboxed location and is a regular file <= 200 MiB. Normal user
/// paths (`!needs_staging`) only use `Path::exists()` (`stat`) and are never
/// opened, avoiding macOS Desktop/Documents/Downloads TCC prompts.
pub fn stage_path(staged_root: &Path, src: &Path) -> Result<PathBuf, StageError> {
    if is_inside_dir(src, staged_root) || !needs_staging(src) {
        return if src.exists() {
            Ok(src.to_path_buf())
        } else {
            Err(StageError::Missing)
        };
    }

    let meta = fs::metadata(src).map_err(|e| match e.kind() {
        ErrorKind::PermissionDenied => StageError::PermissionDenied,
        ErrorKind::NotFound => StageError::Missing,
        _ => StageError::Failed,
    })?;

    if meta.is_dir() || meta.len() > MAX_STAGE_BYTES {
        return match is_readable(src) {
            Ok(()) => Ok(src.to_path_buf()),
            Err(true) => Err(StageError::PermissionDenied),
            Err(false) => Err(StageError::Missing),
        };
    }

    let Some(file_name) = src.file_name() else {
        return Err(StageError::Failed);
    };
    let subdir = staged_root.join(unique_subdir_name());
    fs::create_dir_all(&subdir).map_err(|_| StageError::Failed)?;
    let dst = subdir.join(file_name);

    match clone_or_copy(src, &dst) {
        Ok(()) => Ok(dst),
        Err(e) => {
            let _ = fs::remove_dir_all(&subdir);
            Err(match e.kind() {
                ErrorKind::PermissionDenied => StageError::PermissionDenied,
                ErrorKind::NotFound => StageError::Missing,
                _ => StageError::Failed,
            })
        }
    }
}

#[derive(Debug, Default)]
pub struct DropPrepared {
    pub accepted: Vec<PathBuf>,
    pub blocked: usize,
    pub blocked_off: usize,
}

/// Prepares a batch of dropped paths, respecting Suiby's `appData` opt-in
/// switch so turning it off blocks container reads without touching macOS TCC.
pub fn prepare_drop_with_policy(
    staged_root: &Path,
    paths: &[PathBuf],
    allow_app_data: bool,
) -> DropPrepared {
    let mut out = DropPrepared {
        accepted: Vec::with_capacity(paths.len()),
        blocked: 0,
        blocked_off: 0,
    };
    for path in paths {
        if !allow_app_data && is_app_container(path) {
            out.blocked_off += 1;
            continue;
        }
        match stage_path(staged_root, path) {
            Ok(staged) => out.accepted.push(staged),
            Err(StageError::PermissionDenied) => out.blocked += 1,
            Err(StageError::Missing) => {}
            Err(StageError::Failed) => match is_readable(path) {
                Ok(()) => out.accepted.push(path.clone()),
                Err(true) => out.blocked += 1,
                Err(false) => {}
            },
        }
    }
    out
}

/// Prepares a batch of dropped paths, staging volatile/sandboxed files and
/// counting any paths blocked by OS read permissions.
pub fn prepare_drop(staged_root: &Path, paths: &[PathBuf]) -> (Vec<PathBuf>, usize) {
    let prepared = prepare_drop_with_policy(staged_root, paths, true);
    (prepared.accepted, prepared.blocked + prepared.blocked_off)
}

/// Silently removes staged cache subdirectories for the given paths.
/// Strictly verifies that each target directory is a direct child of
/// `staged_root` after canonicalization; never touches external files and
/// never moves cache files to Trash.
pub fn discard_staged(staged_root: &Path, paths: &[String]) {
    let Ok(root_canon) = fs::canonicalize(staged_root) else {
        return;
    };
    for raw in paths {
        let Some(parent) = Path::new(raw).parent() else {
            continue;
        };
        let Ok(parent_canon) = fs::canonicalize(parent) else {
            continue;
        };
        if parent_canon != root_canon && parent_canon.parent() == Some(root_canon.as_path()) {
            let _ = fs::remove_dir_all(&parent_canon);
        }
    }
}

/// Removes any `<id>` subdirectories under `staged_root` whose files are no
/// longer referenced in persisted shelf state (`items` + `lastRemoved`).
pub fn cleanup_orphans(staged_root: &Path, keep_paths: &[String]) {
    let Ok(root_canon) = fs::canonicalize(staged_root) else {
        return;
    };
    let mut keep_dirs = HashSet::new();
    for raw in keep_paths {
        if let Some(parent) = Path::new(raw).parent() {
            let parent_canon = canonical_or_self(parent);
            if parent_canon.parent() == Some(root_canon.as_path()) {
                keep_dirs.insert(parent_canon);
            }
        }
    }
    let Ok(entries) = fs::read_dir(&root_canon) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(ft) = entry.file_type() else {
            continue;
        };
        // Never follow symlinks outside staged_root.
        if !ft.is_dir() {
            continue;
        }
        let path = entry.path();
        let canon = fs::canonicalize(&path).unwrap_or(path);
        if canon.parent() == Some(root_canon.as_path()) && !keep_dirs.contains(&canon) {
            let _ = fs::remove_dir_all(&canon);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Creates a temp directory outside OS temp paths (`/tmp`, `/var/folders`)
    /// so we can test normal user-path zero-copy behavior on macOS as well.
    fn non_temp_dir() -> tempfile::TempDir {
        let exe = std::env::current_exe().unwrap();
        let base = exe.parent().unwrap();
        tempfile::Builder::new()
            .prefix("suiby-staging-test-")
            .tempdir_in(base)
            .unwrap()
    }

    #[test]
    fn needs_staging_distinguishes_normal_and_volatile_paths() {
        assert!(!needs_staging(Path::new("/Users/alice/Desktop/report.pdf")));
        assert!(!needs_staging(Path::new("/Users/alice/Documents/notes.md")));
        assert!(!needs_staging(Path::new("/Users/alice/Downloads/archive.zip")));
        assert!(!needs_staging(Path::new(
            "/Users/alice/Library/Caches/app.suiby.desktop/file-transfer-staged/id1/a.docx"
        )));

        assert!(needs_staging(Path::new(
            "/Users/alice/someapp/temp/drag/contract.docx"
        )));

        #[cfg(target_os = "macos")]
        {
            assert!(needs_staging(Path::new(
                "/Users/alice/Library/Containers/com.tencent.xinWeChat/Data/Documents/xwechat_files/abc/temp/drag/foo.docx"
            )));
            assert!(needs_staging(Path::new(
                "/Users/alice/Library/Containers/com.tencent.xinWeChat/Data/Documents/msg/file.pdf"
            )));
            assert!(needs_staging(Path::new(
                "/Users/alice/Library/Group Containers/group.example/data.png"
            )));
            assert!(needs_staging(Path::new("/tmp/ephemeral.txt")));
            assert!(needs_staging(Path::new("/private/tmp/ephemeral.txt")));
            assert!(needs_staging(Path::new("/var/folders/ab/cd/T/drop.png")));
            assert!(needs_staging(Path::new(
                "/private/var/folders/ab/cd/T/drop.png"
            )));
        }
    }

    #[test]
    fn normal_path_stays_zero_copy_untouched() {
        let user_dir = non_temp_dir();
        let staged_root = tempfile::tempdir().unwrap();
        let file = user_dir.path().join("budget.xlsx");
        fs::write(&file, b"sheet-data").unwrap();

        assert!(!needs_staging(&file));
        let result = stage_path(staged_root.path(), &file).unwrap();
        assert_eq!(result, file);
        assert_eq!(fs::read_dir(staged_root.path()).unwrap().count(), 0);
    }

    #[test]
    fn temp_and_container_paths_are_staged_preserving_filename_and_not_restaged() {
        let staged_root = tempfile::tempdir().unwrap();
        let volatile_root = tempfile::tempdir().unwrap();
        let drag_dir = volatile_root.path().join("temp").join("drag");
        fs::create_dir_all(&drag_dir).unwrap();
        let src = drag_dir.join("会议纪要 2026.docx");
        fs::write(&src, b"wechat-docx-payload").unwrap();

        let staged = stage_path(staged_root.path(), &src).unwrap();
        assert_ne!(staged, src);
        assert_eq!(staged.file_name(), src.file_name());
        assert_eq!(fs::read(&staged).unwrap(), b"wechat-docx-payload");
        assert!(is_inside_dir(&staged, staged_root.path()));

        // Original disappearing does not affect the staged copy.
        fs::remove_file(&src).unwrap();
        assert_eq!(fs::read(&staged).unwrap(), b"wechat-docx-payload");

        // Re-staging an already-staged path is a no-op.
        let restaged = stage_path(staged_root.path(), &staged).unwrap();
        assert_eq!(restaged, staged);
    }

    #[test]
    fn discard_removes_only_staged_subdir_and_never_touches_external_files() {
        let staged_root = tempfile::tempdir().unwrap();
        let external_dir = non_temp_dir();
        let external_file = external_dir.path().join("keep-me.txt");
        fs::write(&external_file, b"important").unwrap();

        let volatile = tempfile::tempdir().unwrap();
        let src = volatile.path().join("temp").join("drag").join("doc.pdf");
        fs::create_dir_all(src.parent().unwrap()).unwrap();
        fs::write(&src, b"pdf-bytes").unwrap();

        let staged = stage_path(staged_root.path(), &src).unwrap();
        let staged_subdir = staged.parent().unwrap().to_path_buf();
        assert!(staged_subdir.is_dir());

        // Passing staged path, external path, and staged_root itself:
        // only staged_subdir may be removed.
        discard_staged(
            staged_root.path(),
            &[
                staged.to_string_lossy().into_owned(),
                external_file.to_string_lossy().into_owned(),
                staged_root.path().to_string_lossy().into_owned(),
            ],
        );

        assert!(!staged_subdir.exists());
        assert!(staged_root.path().is_dir());
        assert_eq!(fs::read(&external_file).unwrap(), b"important");
    }

    #[test]
    fn orphan_cleanup_preserves_active_and_last_removed_and_deletes_stale() {
        let staged_root = tempfile::tempdir().unwrap();
        let active_dir = staged_root.path().join("id-active");
        let undo_dir = staged_root.path().join("id-last-removed");
        let stale_dir = staged_root.path().join("id-orphan");
        fs::create_dir_all(&active_dir).unwrap();
        fs::create_dir_all(&undo_dir).unwrap();
        fs::create_dir_all(&stale_dir).unwrap();

        let active_file = active_dir.join("a.pdf");
        let undo_file = undo_dir.join("b.docx");
        let stale_file = stale_dir.join("c.png");
        fs::write(&active_file, b"a").unwrap();
        fs::write(&undo_file, b"b").unwrap();
        fs::write(&stale_file, b"c").unwrap();

        cleanup_orphans(
            staged_root.path(),
            &[
                active_file.to_string_lossy().into_owned(),
                undo_file.to_string_lossy().into_owned(),
            ],
        );

        assert!(active_file.exists());
        assert!(undo_file.exists());
        assert!(!stale_dir.exists());
    }

    #[test]
    fn readability_distinguishes_ok_missing_and_permission_denied() {
        let dir = non_temp_dir();
        let ok_file = dir.path().join("ok.txt");
        fs::write(&ok_file, b"hello").unwrap();
        assert_eq!(is_readable(&ok_file), Ok(()));
        assert_eq!(is_readable(dir.path()), Ok(()));

        let missing = dir.path().join("missing.txt");
        assert_eq!(is_readable(&missing), Err(false));

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let staged_root = tempfile::tempdir().unwrap();

            // 1. A normal (!needs_staging) file with 0o000 still exists() (stat),
            // so stage_path MUST NOT open() it (prevents macOS Desktop/Documents/Downloads TCC prompts).
            let normal_no_read = dir.path().join("normal-no-read.txt");
            fs::write(&normal_no_read, b"desktop-file").unwrap();
            fs::set_permissions(&normal_no_read, fs::Permissions::from_mode(0o000)).unwrap();
            assert!(!needs_staging(&normal_no_read));
            let normal_stage_res = stage_path(staged_root.path(), &normal_no_read);

            // 2. A volatile/container (needs_staging) file with 0o000 MUST be checked
            // and reported as PermissionDenied / blocked.
            let volatile_dir = tempfile::tempdir().unwrap();
            let volatile_denied = volatile_dir.path().join("temp").join("drag").join("denied.docx");
            fs::create_dir_all(volatile_denied.parent().unwrap()).unwrap();
            fs::write(&volatile_denied, b"secret").unwrap();
            fs::set_permissions(&volatile_denied, fs::Permissions::from_mode(0o000)).unwrap();

            let res = is_readable(&volatile_denied);
            let (accepted, blocked) =
                prepare_drop(staged_root.path(), &[ok_file.clone(), volatile_denied.clone()]);

            // Restore permissions before tempdirs drop.
            let _ = fs::set_permissions(&normal_no_read, fs::Permissions::from_mode(0o644));
            let _ = fs::set_permissions(&volatile_denied, fs::Permissions::from_mode(0o644));

            // Normal path was never opened even though it lacked read bits.
            assert_eq!(normal_stage_res, Ok(normal_no_read));

            // Root bypasses chmod 000; only assert EPERM when running non-root.
            if res == Err(true) {
                assert_eq!(accepted, vec![ok_file]);
                assert_eq!(blocked, 1);
            }
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn app_data_opt_out_blocks_container_without_touching_disk() {
        let staged_root = tempfile::tempdir().unwrap();
        let container_file = PathBuf::from(
            "/Users/someone/Library/Containers/com.tencent.xinWeChat/Data/temp/drag/doc.pdf",
        );
        assert!(is_app_container(&container_file));
        let prepared = prepare_drop_with_policy(staged_root.path(), &[container_file], false);
        assert!(prepared.accepted.is_empty());
        assert_eq!(prepared.blocked, 0);
        assert_eq!(prepared.blocked_off, 1);
    }
}
