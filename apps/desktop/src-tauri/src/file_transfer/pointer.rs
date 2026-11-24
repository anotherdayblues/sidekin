#[derive(Clone, Copy, Debug)]
pub struct Pointer {
    pub x: f64,
    pub y: f64,
    pub left: bool,
    pub count: i64,
}
#[cfg(target_os = "macos")]
pub fn read() -> Pointer {
    #[repr(C)]
    struct Raw {
        x: f64,
        y: f64,
        left: i32,
        count: std::ffi::c_long,
    }
    unsafe extern "C" {
        fn lab_pointer() -> Raw;
    }
    let p = unsafe { lab_pointer() };
    Pointer {
        x: p.x,
        y: p.y,
        left: p.left != 0,
        count: p.count,
    }
}
#[cfg(windows)]
pub fn read() -> Pointer {
    // Same Win32 button/cursor mechanism used in Holdem's mouse_monitor/win.rs.
    use windows_sys::Win32::{
        Foundation::POINT,
        UI::{
            Input::KeyboardAndMouse::{GetAsyncKeyState, VK_LBUTTON},
            WindowsAndMessaging::GetCursorPos,
        },
    };
    let mut p = POINT { x: 0, y: 0 };
    unsafe {
        GetCursorPos(&mut p);
        Pointer {
            x: p.x as f64,
            y: p.y as f64,
            left: (GetAsyncKeyState(VK_LBUTTON as i32) as u16 & 0x8000) != 0,
            count: 0,
        }
    }
}
#[cfg(not(any(windows, target_os = "macos")))]
pub fn read() -> Pointer {
    Pointer {
        x: 0.,
        y: 0.,
        left: false,
        count: 0,
    }
}
