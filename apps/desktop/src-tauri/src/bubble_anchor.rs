/// About the tallest a bubble gets (eight lines of answer plus header and
/// buttons), in logical pixels. The side is chosen for this height, so a
/// growing answer never flips the bubble from above the pet to below it.
pub(super) const FULL_HEIGHT: f64 = 340.;
/// Lay out both windows in the monitor's physical coordinates, including negative origins.
pub(super) fn bubble_anchor(
    pet: (i32, i32),
    pet_size: (u32, u32),
    bubble: (u32, u32),
    full: u32,
    area: (i32, i32, u32, u32),
) -> (i32, i32, bool, f64) {
    let (left, top, width, height) = area;
    let center = f64::from(pet.0) + f64::from(pet_size.0) / 2.;
    let x = ((center - f64::from(bubble.0) / 2.).round() as i32)
        .clamp(left, (left + width as i32 - bubble.0 as i32).max(left));
    let upper = (pet.1 - top).clamp(0, height as i32);
    let lower = (top + height as i32 - pet.1 - pet_size.1 as i32).clamp(0, height as i32);
    let preferred = full.max(bubble.1) as i32;
    let above = upper >= preferred || (lower < preferred && upper >= lower);
    let y = if above {
        (pet.1 - bubble.1 as i32).max(top)
    } else {
        (pet.1 + pet_size.1 as i32).clamp(top, (top + height as i32 - bubble.1 as i32).max(top))
    };
    (x, y, above, center - f64::from(x))
}
#[cfg(test)]
mod anchor_tests {
    #[test]
    fn prefers_room_above_when_below_would_cover_the_pet() {
        let (_, y, above, _) =
            super::bubble_anchor((300, 270), (200, 220), (320, 250), 340, (0, 0, 900, 650));
        assert!(above);
        assert_eq!(y, 20);
    }

    use super::*;
    #[test]
    fn flips_and_tracks_the_pet_when_the_window_is_clamped() {
        let area = (-1000, -200, 1000, 800);
        assert_eq!(
            bubble_anchor((-960, 100), (80, 80), (300, 120), 120, area),
            (-1000, -20, true, 80.)
        );
        assert_eq!(
            bubble_anchor((-80, -190), (80, 80), (300, 120), 120, area),
            (-300, -110, false, 260.)
        );
        assert_eq!(
            bubble_anchor((-550, 100), (100, 100), (300, 120), 120, area),
            (-650, -20, true, 150.)
        );
        // Room for this short bubble above, but not for a full answer: start below.
        assert!(!bubble_anchor((-550, 100), (100, 100), (300, 120), 340, area).2);
    }
}
