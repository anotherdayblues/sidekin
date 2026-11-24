use crate::*;
pub fn handle(window: &tauri::Window, event: &tauri::WindowEvent) {
    file_transfer::handle(window, event);
    if window.label() == "studio" && matches!(event, tauri::WindowEvent::Focused(true)) {
        copy_twice::refresh(window.app_handle());
    }
    if (window.label() == "pet"
        && matches!(
            event,
            tauri::WindowEvent::Moved(_)
                | tauri::WindowEvent::Resized(_)
                | tauri::WindowEvent::ScaleFactorChanged { .. }
        ))
        || (window.label() == "bubble"
            && matches!(
                event,
                tauri::WindowEvent::Resized(_) | tauri::WindowEvent::ScaleFactorChanged { .. }
            ))
    {
        if window.label() == "pet" {
            let _ = focus_clock::place(window.app_handle());
        }
        let _ = chat::place(window.app_handle());
    }
    if window.label() == "chat" {
        if let Some(w) = window.app_handle().get_webview_window("chat") {
            match event {
                tauri::WindowEvent::Resized(_) => chat_window::remember(&w),
                tauri::WindowEvent::Moved(_) => chat_window::moved(&w),
                _ => {}
            }
        }
    }
    if window.label() == "studio"
        && matches!(
            event,
            tauri::WindowEvent::Focused(false) | tauri::WindowEvent::CloseRequested { .. }
        )
    {
        let _ = shortcuts::resume(window.app_handle());
    }
    if let tauri::WindowEvent::CloseRequested { api, .. } = event {
        api.prevent_close();
        if window.label().starts_with("snip-") {
            snip::clear(window.app_handle());
            return;
        }
        if window.label() == "pet" {
            let state = window.state::<State>();
            match state.update_settings(|s| s.visible = false) {
                Ok(()) => {
                    let _ = refresh(window.app_handle());
                }
                Err(e) => settings_failed(window.app_handle(), e),
            }
        } else {
            let _ = window.hide();
            if window.label() == "studio" {
                studio_window::hidden(window.app_handle());
            } else if window.label() == "chat" {
                chat_window::hidden(window.app_handle());
            } else if window.label() == "snipcard" {
                snip_card::dismiss(window.app_handle());
            }
        }
    }
}
