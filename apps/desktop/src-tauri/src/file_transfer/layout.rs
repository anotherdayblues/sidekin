use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
// Only used when reading metadata from the first isolated sample.
pub const OFFSET_X: f64 = 176.;
pub const OFFSET_Y: f64 = 110.;
pub const CARD_W: f64 = 64.;
pub const CARD_H: f64 = 78.;
// Visual breathing room for rotated back sheets, badge and soft drop-shadow.
const CARD_OVERHANG_X: f64 = 8.;
const CARD_OVERHANG_Y: f64 = 4.;
// Transparent window bleed around overlays so shadows, rotated sheets, badges
// and notices are never clipped by the native window edge. Click-through stays
// exact because petPointer.ts hit-tests DOM elements directly.
const OVERLAY_BLEED: f64 = 12.;
const PANEL_BLEED_X: f64 = 24.;
const PANEL_BLEED_TOP: f64 = 22.;
const PANEL_BLEED_BOTTOM: f64 = 28.;
#[derive(Clone, Copy, Debug, Deserialize, Serialize, PartialEq)]
pub struct Rect {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Rect {
    pub fn contains(&self, x: f64, y: f64) -> bool {
        x >= self.x && x <= self.x + self.width && y >= self.y && y <= self.y + self.height
    }
    pub fn union(self, r: Self) -> Self {
        let x = self.x.min(r.x);
        let y = self.y.min(r.y);
        Self {
            x,
            y,
            width: (self.x + self.width).max(r.x + r.width) - x,
            height: (self.y + self.height).max(r.y + r.height) - y,
        }
    }
}
pub fn height(width: f64) -> f64 {
    width * 208. / 192.
}
// Same placement as attachmentPositions in src/fileTransfer/pileLayout.ts;
// change both together.
pub fn attachments(view: &Value, width: f64, body: Rect) -> Value {
    let mut out = serde_json::Map::new();
    if let Some(items) = view["state"]["items"].as_array() {
        for (i, item) in items.iter().enumerate() {
            if let Some(id) = item["id"].as_str() {
                out.insert(id.into(),json!({"x":(body.x+body.width)*width-24.+i as f64*4.,"y":body.y*height(width)+i as f64*4.}));
            }
        }
    }
    Value::Object(out)
}
pub fn group_bounds(view: &Value, width: f64, body: Rect) -> Rect {
    let mut bounds = Rect {
        x: body.x * width,
        y: body.y * height(width),
        width: body.width * width,
        height: body.height * height(width),
    };
    if let Some(positions) = attachments(view, width, body).as_object() {
        for p in positions.values() {
            bounds = bounds.union(Rect {
                x: p["x"].as_f64().unwrap() - CARD_OVERHANG_X,
                y: p["y"].as_f64().unwrap() - CARD_OVERHANG_Y,
                width: CARD_W + CARD_OVERHANG_X * 2.,
                height: CARD_H + CARD_OVERHANG_Y * 2.,
            });
        }
    }
    bounds
}
pub fn fit_group(p: (i32, i32), units: f64, work: (i32, i32, u32, u32), group: Rect) -> (i32, i32) {
    let (x, y, w, h) = work;
    let l = x as f64 - group.x * units;
    let t = y as f64 - group.y * units;
    let r = (x as f64 + w as f64 - (group.x + group.width) * units).max(l);
    let b = (y as f64 + h as f64 - (group.y + group.height) * units).max(t);
    (
        (p.0 as f64).clamp(l, r).round() as i32,
        (p.1 as f64).clamp(t, b).round() as i32,
    )
}
pub fn fit_drag(
    p: (i32, i32),
    units: f64,
    work: (i32, i32, u32, u32),
    group: Rect,
    release: bool,
) -> (i32, i32) {
    if release {
        fit_group(p, units, work, group)
    } else {
        p
    }
}
// Keep the full animation canvas in the interior. At a screen edge, crop only
// the native viewport; pet and pile retain one common drawing origin.
pub fn viewport(
    anchor: (f64, f64),
    units: f64,
    size: f64,
    overlays: &[Rect],
    desktop: Rect,
) -> Rect {
    let mut content = Rect {
        x: 0.,
        y: 0.,
        width: size,
        height: height(size),
    };
    for r in overlays {
        let is_panel = r.width >= 160. && r.height >= 70.;
        let (bx, bt, bb) = if is_panel {
            (PANEL_BLEED_X, PANEL_BLEED_TOP, PANEL_BLEED_BOTTOM)
        } else {
            (OVERLAY_BLEED, OVERLAY_BLEED, OVERLAY_BLEED)
        };
        content = content.union(Rect {
            x: r.x - bx,
            y: r.y - bt,
            width: r.width + bx * 2.,
            height: r.height + bt + bb,
        });
    }
    let l = (anchor.0 + content.x * units)
        .max(desktop.x)
        .min(desktop.x + desktop.width - 1.);
    let t = (anchor.1 + content.y * units)
        .max(desktop.y)
        .min(desktop.y + desktop.height - 1.);
    let r = (anchor.0 + (content.x + content.width) * units)
        .min(desktop.x + desktop.width)
        .max(l + 1.);
    let b = (anchor.1 + (content.y + content.height) * units)
        .min(desktop.y + desktop.height)
        .max(t + 1.);
    Rect {
        x: l.floor(),
        y: t.floor(),
        width: (r.ceil() - l.floor()).max(1.),
        height: (b.ceil() - t.floor()).max(1.),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn top_edge_uses_visible_pet_instead_of_transparent_padding() {
        let body = Rect {
            x: 0.2,
            y: 0.35,
            width: 0.6,
            height: 0.6,
        };
        for size in [80., 160., 280.] {
            let group = group_bounds(&json!({"state":{"items":[]}}), size, body);
            let p = fit_group((200, -500), 1., (0, 30, 1280, 660), group);
            assert!((p.1 as f64 + body.y * height(size) - 30.).abs() <= 0.5);
        }
    }
    #[test]
    fn pile_stays_on_the_same_upper_right_anchor_at_every_size() {
        let v = json!({"state":{"items":[{"id":"a"}]}});
        let body = Rect {
            x: 0.2,
            y: 0.35,
            width: 0.6,
            height: 0.6,
        };
        for size in [80., 160., 280.] {
            let p = attachments(&v, size, body);
            assert_eq!(p["a"]["x"], json!((body.x + body.width) * size - 24.));
            assert_eq!(p["a"]["y"], json!(body.y * height(size)));
        }
    }
    #[test]
    fn negative_origin_and_dpi_keep_the_visible_combination_inside_work_area() {
        let g = group_bounds(
            &json!({"state":{"items":[{"id":"a"}]}}),
            80.,
            Rect {
                x: 0.2,
                y: 0.3,
                width: 0.6,
                height: 0.65,
            },
        );
        for units in [1., 1.5, 2.] {
            for input in [(-5000, -5000), (5000, 5000)] {
                let p = fit_group(input, units, (-2400, -300, 2400, 1600), g);
                assert!(p.0 as f64 + g.x * units >= -2400.5);
                assert!(p.1 as f64 + g.y * units >= -300.5);
                assert!(p.0 as f64 + (g.x + g.width) * units <= 0.5);
                assert!(p.1 as f64 + (g.y + g.height) * units <= 1300.5);
            }
        }
    }
    #[test]
    fn crossing_screen_seam_is_free_until_release() {
        let g = Rect {
            x: 20.,
            y: 40.,
            width: 140.,
            height: 150.,
        };
        assert_eq!(
            fit_drag((-20, 100), 1., (0, 0, 1280, 690), g, false),
            (-20, 100)
        );
    }
    #[test]
    fn expanded_viewport_never_changes_the_pet_world_anchor() {
        let desktop = Rect {
            x: -1280.,
            y: 30.,
            width: 2560.,
            height: 774.,
        };
        let anchor = (300., -30.);
        let closed = viewport(anchor, 1., 160., &[], desktop);
        let open = viewport(
            anchor,
            1.,
            160.,
            &[Rect {
                x: -238.,
                y: 60.,
                width: 230.,
                height: 260.,
            }],
            desktop,
        );
        for frame in [closed, open] {
            let offset = (anchor.0 - frame.x, anchor.1 - frame.y);
            assert_eq!((frame.x + offset.0, frame.y + offset.1), anchor);
            assert!(frame.y >= 30.);
        }
        assert!(open.width > closed.width);
    }
    #[test]
    fn viewport_reserves_shadow_and_sheet_bleed_around_overlays() {
        let desktop = Rect {
            x: 0.,
            y: 0.,
            width: 1470.,
            height: 920.,
        };
        let anchor = (400., 300.);
        let card = Rect {
            x: 88.,
            y: 50.,
            width: CARD_W,
            height: CARD_H,
        };
        let folded = viewport(anchor, 1., 140., &[card], desktop);
        assert!(
            folded.x + folded.width >= anchor.0 + card.x + card.width + OVERLAY_BLEED,
            "folded card right edge needs bleed for rotated sheets and shadow"
        );
        let panel = Rect {
            x: -368.,
            y: 40.,
            width: 360.,
            height: 180.,
        };
        let expanded = viewport(anchor, 1., 140., &[card, panel], desktop);
        assert!(
            expanded.x <= anchor.0 + panel.x - PANEL_BLEED_X,
            "expanded panel left edge needs shadow bleed"
        );
        assert!(
            expanded.y + expanded.height
                >= anchor.1 + panel.y + panel.height + PANEL_BLEED_BOTTOM,
            "expanded panel bottom edge needs shadow bleed"
        );
    }
    #[test]
    fn group_bounds_gives_folded_pile_edge_breathing_room() {
        let body = Rect {
            x: 0.2,
            y: 0.35,
            width: 0.6,
            height: 0.6,
        };
        let g = group_bounds(&json!({"state":{"items":[{"id":"a"}]}}), 140., body);
        let card_right = (body.x + body.width) * 140. - 24. + CARD_W;
        assert!(
            g.x + g.width >= card_right + CARD_OVERHANG_X,
            "fit_group should keep rotated sheet overhang clear of screen edges"
        );
    }
}
