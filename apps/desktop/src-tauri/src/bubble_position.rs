#[path = "bubble_anchor.rs"]
mod layout;
use layout::{bubble_anchor, FULL_HEIGHT};
use serde_json::json;
use tauri::{AppHandle, Emitter, Manager, PhysicalPosition};
pub fn place(app: &AppHandle) -> Result<(), String> {
    if crate::clipboard::centered(app) {
        return Ok(());
    }
    let (Some(pet), Some(bubble)) = (
        app.get_webview_window("pet"),
        app.get_webview_window("bubble"),
    ) else {
        return Ok(());
    };
    let Some((mut pos, mut pet_size)) = crate::focus_clock::pet_rect(app) else {
        return Ok(());
    };
    // The 番茄钟 clock counts as part of the pet, so the bubble keeps clear.
    if let Some((c, cs)) = crate::focus_clock::shown_rect(app) {
        let (l, t) = (pos.x.min(c.x), pos.y.min(c.y));
        let r = (pos.x + pet_size.width as i32).max(c.x + cs.width as i32);
        let b = (pos.y + pet_size.height as i32).max(c.y + cs.height as i32);
        pos = tauri::PhysicalPosition::new(l, t);
        pet_size = tauri::PhysicalSize::new((r - l) as u32, (b - t) as u32);
    }
    let Some(mon) = pet.current_monitor().map_err(|e| e.to_string())? else {
        return Ok(());
    };
    let area = mon.work_area();
    let scale = bubble.scale_factor().map_err(|e| e.to_string())?;
    let size = if let Some((w, h)) = crate::clipboard::panel_size(app) {
        let s = mon.scale_factor();
        tauri::PhysicalSize::new((w * s).round() as u32, (h * s).round() as u32)
    } else {
        bubble.outer_size().map_err(|e| e.to_string())?
    };
    let (x, y, above, anchor) = bubble_anchor(
        (pos.x, pos.y),
        (pet_size.width, pet_size.height),
        (size.width, size.height),
        (FULL_HEIGHT * scale) as u32,
        (
            area.position.x,
            area.position.y,
            area.size.width,
            area.size.height,
        ),
    );
    bubble
        .set_position(PhysicalPosition::new(x, y))
        .map_err(|e| e.to_string())?;
    let available = if above {
        pos.y - area.position.y
    } else {
        area.position.y + area.size.height as i32 - pos.y - pet_size.height as i32
    };
    app.emit_to(
        "bubble",
        "bubble-anchor",
        json!({"side":if above{"above"}else{"below"},"x":anchor/scale,"maxHeight":(f64::from(available)/scale).floor().clamp(40.,650.)}),
    )
    .map_err(|e| e.to_string())
}
