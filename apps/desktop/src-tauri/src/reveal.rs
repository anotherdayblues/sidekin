//! 在访达中显示 / 在资源管理器中显示, and opening a folder: handed to the
//! system's own file manager.
use std::path::Path;
use std::process::Command;

/// The file manager, with this file selected.
#[tauri::command]
pub fn reveal_file(path: String) -> Result<(), String> {
    let path = Path::new(&path);
    if !path.exists() {
        return Err(crate::locale::t("files.moved"));
    }
    #[cfg(target_os = "macos")]
    let mut launch = {
        let mut c = Command::new("/usr/bin/open");
        c.arg("-R").arg(path);
        c
    };
    #[cfg(windows)]
    let mut launch = {
        use std::os::windows::process::CommandExt;
        // Explorer reads `/select,"path"` as one argument, quotes included.
        let mut c = Command::new("explorer.exe");
        c.raw_arg(format!("/select,\"{}\"", path.display()));
        c
    };
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut launch = {
        let mut c = Command::new("xdg-open");
        c.arg(path.parent().unwrap_or(path));
        c
    };
    launch.spawn().map(|_| ()).map_err(|e| e.to_string())
}

/// The file manager, at this folder.
pub fn open_folder(path: &Path) -> Result<(), String> {
    if !path.is_dir() {
        return Err(crate::locale::t("files.moved"));
    }
    #[cfg(target_os = "macos")]
    let mut launch = Command::new("/usr/bin/open");
    #[cfg(windows)]
    let mut launch = Command::new("explorer.exe");
    #[cfg(not(any(windows, target_os = "macos")))]
    let mut launch = Command::new("xdg-open");
    launch
        .arg(path)
        .spawn()
        .map(|_| ())
        .map_err(|e| e.to_string())
}
