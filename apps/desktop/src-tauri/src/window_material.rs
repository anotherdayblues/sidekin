//! Real system material behind the 系统原生 skin: Liquid Glass on macOS 26
//! (the older vibrancy material on earlier macOS), Mica on Windows 11. The
//! page then paints its background transparent so the material shows. Any
//! other system gets `false` and the skin keeps its solid colors.
use tauri::utils::{Theme, WindowEffect as Effect};
use tauri::window::EffectsBuilder;

#[derive(Clone, Copy, Debug, PartialEq)]
enum Host {
    Mac,
    Windows11,
}

/// Which material a window wears, and its corner radius on macOS.
fn material(label: &str, host: Host, dark: bool) -> Option<(Vec<Effect>, Option<f64>)> {
    let mica = if dark {
        Effect::MicaDark
    } else {
        Effect::MicaLight
    };
    match (label, host) {
        // Liquid Glass first; macOS 15 and below fall back to the second.
        ("studio", Host::Mac) => Some((vec![Effect::LiquidGlassRegular, Effect::Sidebar], None)),
        ("chat" | "clipboard", Host::Mac) => {
            Some((vec![Effect::LiquidGlassRegular, Effect::Popover], Some(16.)))
        }
        ("studio" | "chat", Host::Windows11) => Some((vec![mica], None)),
        // The 番茄钟 clock: a capsule of glass (its radius is set from its
        // height, and kept so while it opens and closes, focus_clock.rs),
        // Acrylic on Windows like the system's own flyouts. The clear kind,
        // the more see-through one, with the page's thin tint keeping the
        // digits readable as Apple's guidance asks.
        ("clock", Host::Mac) => Some((vec![Effect::LiquidGlassClear, Effect::HudWindow], None)),
        ("clock" | "clipboard", Host::Windows11) => Some((vec![Effect::Acrylic], None)),
        _ => None,
    }
}

fn host() -> Option<Host> {
    if cfg!(target_os = "macos") {
        return Some(Host::Mac);
    }
    #[cfg(windows)]
    {
        // Mica exists from Windows 11 (build 22000).
        let build: String = winreg::RegKey::predef(winreg::enums::HKEY_LOCAL_MACHINE)
            .open_subkey(r"SOFTWARE\Microsoft\Windows NT\CurrentVersion")
            .and_then(|k| k.get_value("CurrentBuildNumber"))
            .unwrap_or_default();
        if build.parse::<u32>().unwrap_or(0) >= 22000 {
            return Some(Host::Windows11);
        }
    }
    None
}

/// Turns the material on or off for the calling window. Returns whether it is
/// on, so the page knows whether it may go transparent. On a Mac the studio
/// window also lays its content under the title bar, so the sidebar reaches
/// the traffic lights as in system apps; other skins keep the plain bar.
#[tauri::command]
pub fn window_material(window: tauri::WebviewWindow, on: bool, dark: bool) -> bool {
    #[cfg(target_os = "macos")]
    if window.label() == "studio" {
        let _ = window.set_title_bar_style(if on {
            tauri::TitleBarStyle::Overlay
        } else {
            tauri::TitleBarStyle::Visible
        });
    }
    let kind = if window.label() == "bubble" {
        "clipboard"
    } else {
        window.label()
    };
    let chosen = host().and_then(|h| material(kind, h, dark));
    let clock = window.label() == "clock";
    // On Windows the system shadow also rounds a borderless window's corners.
    #[cfg(windows)]
    if clock {
        let _ = window.set_shadow(on && chosen.is_some());
    }
    let Some((effects, mut radius)) = chosen.filter(|_| on) else {
        let _ = window.set_effects(None);
        let _ = window.set_theme(None);
        return false;
    };
    if clock {
        let height = window.inner_size().map(|s| s.height as f64).unwrap_or(38.);
        radius = Some(height / window.scale_factor().unwrap_or(1.) / 2.);
    }
    // The material follows the window's own light or dark appearance.
    let _ = window.set_theme(Some(if dark { Theme::Dark } else { Theme::Light }));
    let mut builder = EffectsBuilder::new().effects(effects);
    if let Some(r) = radius {
        builder = builder.radius(r);
    }
    window.set_effects(builder.build()).is_ok()
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn studio_and_chat_get_glass_on_mac_and_mica_on_windows_11() {
        let (mac, _) = material("studio", Host::Mac, false).unwrap();
        assert_eq!(mac[0], Effect::LiquidGlassRegular);
        assert_eq!(mac[1], Effect::Sidebar, "fallback for macOS 15 and below");
        assert_eq!(material("chat", Host::Mac, false).unwrap().1, Some(16.));
        assert_eq!(
            material("studio", Host::Windows11, true).unwrap().0,
            vec![Effect::MicaDark]
        );
        assert_eq!(
            material("chat", Host::Windows11, false).unwrap().0,
            vec![Effect::MicaLight]
        );
    }
    #[test]
    fn transparent_desktop_widgets_keep_no_material() {
        for label in ["pet", "bubble", "snip-1"] {
            assert!(material(label, Host::Mac, false).is_none());
            assert!(material(label, Host::Windows11, false).is_none());
        }
    }
}
