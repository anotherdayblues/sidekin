//! Puts a file 随伴 saved into the system's trash (废纸篓 / 回收站), so a
//! removal from the pet can still be undone by the user.
use std::path::Path;

#[cfg(windows)]
pub fn trash(path: &Path) -> Result<(), String> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::UI::Shell::{
        SHFileOperationW, FOF_ALLOWUNDO, FOF_NOCONFIRMATION, FOF_NOERRORUI, FOF_SILENT, FO_DELETE,
        SHFILEOPSTRUCTW,
    };
    // A list of paths, each ended by a NUL, the list by another.
    let mut from: Vec<u16> = path.as_os_str().encode_wide().collect();
    from.extend([0, 0]);
    let mut op: SHFILEOPSTRUCTW = unsafe { std::mem::zeroed() };
    op.wFunc = FO_DELETE;
    op.pFrom = from.as_ptr();
    op.fFlags = (FOF_ALLOWUNDO | FOF_NOCONFIRMATION | FOF_NOERRORUI | FOF_SILENT) as u16;
    // SAFETY: `from` outlives the call and is double-NUL terminated.
    match unsafe { SHFileOperationW(&mut op) } {
        0 => Ok(()),
        code => Err(format!("recycle failed: {code}")),
    }
}

/// macOS (and Linux, for development): the user's trash folder.
#[cfg(not(windows))]
pub fn trash(path: &Path) -> Result<(), String> {
    let home = std::env::var_os("HOME").ok_or("no home")?;
    let bin = if cfg!(target_os = "macos") {
        Path::new(&home).join(".Trash")
    } else {
        Path::new(&home).join(".local/share/Trash/files")
    };
    std::fs::create_dir_all(&bin).map_err(|e| e.to_string())?;
    let name = path
        .file_name()
        .and_then(|n| n.to_str())
        .ok_or("bad name")?;
    let target = super::rules::unique(&bin, name);
    std::fs::rename(path, &target).map_err(|e| e.to_string())
}
