// This fixture owns both windows and uses only an isolated CI desktop.
use std::{
    ffi::CStr,
    process::{Child, Command},
    time::{Duration, Instant},
};
use windows_sys::Win32::UI::WindowsAndMessaging::*;

struct Fixture(Child);
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}

fn until(mut ready: impl FnMut() -> bool) {
    let start = Instant::now();
    loop {
        unsafe {
            let mut msg = std::mem::zeroed();
            while PeekMessageW(&mut msg, std::ptr::null_mut(), 0, 0, PM_REMOVE) != 0 {
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
        }
        if ready() {
            return;
        }
        assert!(
            start.elapsed() < Duration::from_secs(20),
            "foreground switch timed out"
        );
        std::thread::sleep(Duration::from_millis(15));
    }
}

#[test]
fn windows_menu_reads_the_selection_from_the_previous_app() {
    if std::env::var("GITHUB_ACTIONS").as_deref() != Ok("true") {
        return;
    }
    let temp = tempfile::tempdir().unwrap();
    let file = temp.path().join("fixture-handle");
    let script = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../../tests/fixtures/windows-selection.ps1");
    unsafe { super::companion_watch_apps() };
    let _fixture = Fixture(
        Command::new("powershell.exe")
            .args(["-NoProfile", "-STA", "-ExecutionPolicy", "Bypass", "-File"])
            .arg(script)
            .arg(&file)
            .arg(std::process::id().to_string())
            .spawn()
            .unwrap(),
    );
    until(|| {
        file.is_file()
            && std::fs::read_to_string(&file)
                .ok()
                .is_some_and(|s| s.parse::<isize>().is_ok())
    });
    let external: isize = std::fs::read_to_string(file).unwrap().parse().unwrap();
    until(|| unsafe { GetForegroundWindow() as isize == external });
    unsafe {
        let class: Vec<_> = "STATIC\0".encode_utf16().collect();
        let ours = CreateWindowExW(
            0,
            class.as_ptr(),
            class.as_ptr(),
            WS_OVERLAPPEDWINDOW,
            0,
            0,
            240,
            80,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null(),
        );
        assert!(!ours.is_null());
        ShowWindow(ours, SW_SHOW);
        SetForegroundWindow(ours);
        until(|| GetForegroundWindow() == ours);
        let target = super::companion_previous_target();
        assert_eq!(target, external);
        until(|| GetForegroundWindow() as isize == target);
        let mut status = 0;
        let ptr = super::companion_selection(target, &mut status);
        assert!(!ptr.is_null(), "selection status {status}");
        let value = CStr::from_ptr(ptr).to_string_lossy().into_owned();
        super::companion_free(ptr);
        assert_eq!(value, "selected-123");
        // Exercise the same direct paste operation as a click or Enter in history.
        extern "C" {
            fn companion_history_copy(text: *const std::ffi::c_char) -> i32;
            fn companion_clipboard_text() -> *mut std::ffi::c_char;
            fn companion_history_paste(target: isize, text: *const std::ffi::c_char) -> i32;
        }
        let paste = std::ffi::CString::new("clipboard-fixture").unwrap();
        assert_eq!(companion_history_paste(external, paste.as_ptr()), 1);
        let edit = FindWindowExW(
            external as _,
            std::ptr::null_mut(),
            std::ptr::null(),
            std::ptr::null(),
        );
        assert!(!edit.is_null());
        until(|| {
            let mut text = [0u16; 128];
            let len = SendMessageW(edit, WM_GETTEXT, text.len(), text.as_mut_ptr() as isize);
            String::from_utf16_lossy(&text[..len as usize]) == "before clipboard-fixture after"
        });
        let only = std::ffi::CString::new("copy-only fixture").unwrap();
        assert_eq!(companion_history_copy(only.as_ptr()), 1);
        let ptr = companion_clipboard_text();
        assert!(!ptr.is_null());
        assert_eq!(CStr::from_ptr(ptr), only.as_c_str());
        super::companion_free(ptr);
        let mut text = [0u16; 128];
        let len = SendMessageW(edit, WM_GETTEXT, text.len(), text.as_mut_ptr() as isize);
        assert_eq!(
            String::from_utf16_lossy(&text[..len as usize]),
            "before clipboard-fixture after"
        );
        DestroyWindow(ours);
    }
}
