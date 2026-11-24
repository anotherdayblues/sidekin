// Register only the current user and this app identity. Login launches the pet quietly.
use crate::locale::t;
pub const FLAG: &str = "--autostart";

#[tauri::command]
pub async fn login_start_enabled(app: tauri::AppHandle) -> Result<bool, String> {
    platform::enabled(&app).map_err(|_| t("host.loginRead").into())
}
#[tauri::command]
pub async fn set_login_start(app: tauri::AppHandle, enabled: bool) -> Result<bool, String> {
    if cfg!(feature = "acceptance") {
        return Err("测试窗口不修改系统启动项".into());
    }
    platform::set(&app, enabled).map_err(|_| t("host.loginSet").to_string())?;
    login_start_enabled(app).await
}

#[cfg(target_os = "macos")]
mod platform {
    use serde::Serialize;
    use std::{
        fs, io,
        path::{Path, PathBuf},
        process::Command,
    };
    use tauri::{AppHandle, Manager};

    fn agent(app: &AppHandle) -> io::Result<PathBuf> {
        Ok(app
            .path()
            .home_dir()
            .map_err(io::Error::other)?
            .join("Library/LaunchAgents")
            .join(format!("{}.autostart.plist", app.config().identifier)))
    }
    fn domain() -> io::Result<String> {
        let uid = Command::new("/usr/bin/id").arg("-u").output()?;
        let uid = String::from_utf8_lossy(&uid.stdout)
            .trim()
            .parse::<u32>()
            .map_err(io::Error::other)?;
        Ok(format!("gui/{uid}"))
    }
    pub fn enabled(app: &AppHandle) -> io::Result<bool> {
        if !agent(app)?.try_exists()? {
            return Ok(false);
        }
        let state = Command::new("/bin/launchctl")
            .args(["print-disabled", &domain()?])
            .output()?;
        if !state.status.success() {
            return Err(io::Error::other("launchctl"));
        }
        let disabled = format!("\"{}.autostart\"", app.config().identifier);
        Ok(!String::from_utf8_lossy(&state.stdout)
            .lines()
            .filter_map(|l| l.split_once("=>"))
            .any(|(name, value)| name.trim() == disabled && value.trim() == "disabled"))
    }
    fn executable(exe: &Path, desktop: Option<&Path>, name: &str) -> PathBuf {
        // Our versioned exports have a stable Desktop symlink. Use it only
        // when it actually points at this exact build.
        if let Some(link) = desktop.map(|d| d.join(name)) {
            if let Some(binary) = exe.file_name() {
                let stable = link.join("Contents/MacOS").join(binary);
                if stable.canonicalize().ok().as_deref() == Some(exe) {
                    return stable;
                }
            }
        }
        exe.to_owned()
    }
    #[derive(Serialize)]
    #[serde(rename_all = "PascalCase")]
    struct Agent<'a> {
        label: &'a str,
        program_arguments: [&'a str; 6],
        run_at_load: bool,
    }
    fn register(path: &Path, label: &str, exe: &Path) -> io::Result<()> {
        let dir = path.parent().unwrap();
        fs::create_dir_all(dir)?;
        let mut temp = tempfile::NamedTempFile::new_in(dir)?;
        let bundle = exe
            .ancestors()
            .nth(3)
            .filter(|_| {
                exe.parent().and_then(Path::file_name) == Some(std::ffi::OsStr::new("MacOS"))
            })
            .ok_or_else(|| io::Error::other("需要应用包"))?;
        let args = Agent {
            label,
            program_arguments: [
                "/usr/bin/open",
                "-g",
                "-a",
                bundle.to_str().ok_or_else(|| io::Error::other("path"))?,
                "--args",
                super::FLAG,
            ],
            run_at_load: true,
        };
        plist::to_writer_xml(temp.as_file_mut(), &args).map_err(io::Error::other)?;
        temp.persist(path).map_err(|e| e.error)?;
        Ok(())
    }
    pub fn set(app: &AppHandle, on: bool) -> io::Result<()> {
        let path = agent(app)?;
        if !on {
            // Unload a previously registered agent without terminating this app:
            // the per-login job runs /usr/bin/open, which exits after launch.
            if path.try_exists()? {
                let service = format!("{}/{}.autostart", domain()?, app.config().identifier);
                let _ = Command::new("/bin/launchctl")
                    .args(["bootout", &service])
                    .output()?;
                fs::remove_file(path)?;
            }
            return Ok(());
        }
        let label = format!("{}.autostart", app.config().identifier);
        let name = app.config().product_name.as_deref().unwrap_or("随伴");
        let exe = executable(
            &std::env::current_exe()?.canonicalize()?,
            app.path().desktop_dir().ok().as_deref(),
            name,
        );
        let service = format!("{}/{}", domain()?, label);
        if !Command::new("/bin/launchctl")
            .args(["enable", &service])
            .status()?
            .success()
        {
            return Err(io::Error::other("launchctl"));
        }
        register(&path, &label, &exe)
    }

    #[cfg(test)]
    mod tests {
        use super::*;
        #[test]
        fn login_item_uses_stable_trial_path_and_quiet_launch() {
            let dir = tempfile::tempdir().unwrap();
            let root = dir.path().canonicalize().unwrap();
            let bundle = root.join("version/随伴试玩版.app");
            let exe = bundle.join("Contents/MacOS/pet-studio");
            fs::create_dir_all(exe.parent().unwrap()).unwrap();
            fs::write(&exe, []).unwrap();
            std::os::unix::fs::symlink(&bundle, root.join("随伴试玩版")).unwrap();
            let stable = executable(&exe, Some(&root), "随伴试玩版");
            assert_eq!(stable, root.join("随伴试玩版/Contents/MacOS/pet-studio"));
            assert_eq!(executable(&exe, Some(&root), "随伴"), exe);
            let path = root.join("test.plist");
            register(&path, "fixture", &stable).unwrap();
            let plist = plist::Value::from_file(path).unwrap();
            let args = plist.as_dictionary().unwrap()["ProgramArguments"]
                .as_array()
                .unwrap();
            assert_eq!(args[0].as_string(), Some("/usr/bin/open"));
            assert_eq!(args[3].as_string(), root.join("随伴试玩版").to_str());
            assert_eq!(args[5].as_string(), Some(super::super::FLAG));
        }
    }
}
#[cfg(windows)]
mod platform {
    use std::io;
    use tauri::AppHandle;
    use winreg::{enums::HKEY_CURRENT_USER, RegKey};
    const RUN: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";
    const APPROVED: &str =
        r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run";
    fn missing<T>(r: io::Result<T>) -> io::Result<Option<T>> {
        match r {
            Ok(v) => Ok(Some(v)),
            Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e),
        }
    }
    pub fn enabled(app: &AppHandle) -> io::Result<bool> {
        let hk = RegKey::predef(HKEY_CURRENT_USER);
        let name = &app.config().identifier;
        let Some(run) = missing(hk.open_subkey(RUN))? else {
            return Ok(false);
        };
        if missing(run.get_value::<String, _>(name))?.is_none() {
            return Ok(false);
        }
        if let Some(key) = missing(hk.open_subkey(APPROVED))? {
            if let Some(value) = missing(key.get_raw_value(name))? {
                if matches!(value.bytes.first(), Some(3 | 7)) {
                    return Ok(false);
                }
            }
        }
        Ok(true)
    }
    pub fn set(app: &AppHandle, on: bool) -> io::Result<()> {
        let hk = RegKey::predef(HKEY_CURRENT_USER);
        let (key, _) = hk.create_subkey(RUN)?;
        let name = &app.config().identifier;
        if on {
            let exe = std::env::current_exe()?;
            key.set_value(name, &format!("\"{}\" {}", exe.display(), super::FLAG))?;
            if let Some(k) =
                missing(hk.open_subkey_with_flags(APPROVED, winreg::enums::KEY_SET_VALUE))?
            {
                missing(k.delete_value(name))?;
            }
        } else {
            missing(key.delete_value(name))?;
        }
        Ok(())
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
mod platform {
    use std::io;
    pub fn enabled(_: &tauri::AppHandle) -> io::Result<bool> {
        Ok(false)
    }
    pub fn set(_: &tauri::AppHandle, _: bool) -> io::Result<()> {
        Err(io::ErrorKind::Unsupported.into())
    }
}
