//! Screen text recognition: Apple Vision on the Mac (native/ocr.m), then
//! reading order and joining here, where it can be tested.
use serde::{Deserialize, Serialize};

/// One recognized line. The box is normalized to the image (0..1) with a
/// top-left origin.
#[derive(Clone, Debug, Deserialize, Serialize, PartialEq)]
pub struct Line {
    #[serde(rename = "t")]
    pub text: String,
    pub x: f64,
    pub y: f64,
    pub w: f64,
    pub h: f64,
}

#[derive(Clone, Debug, Default, Serialize, PartialEq)]
pub struct Recognized {
    /// Lines in reading order, each tagged with its row.
    pub lines: Vec<Placed>,
    /// Plain text: rows separated by newlines.
    pub text: String,
    /// Set when recognition itself failed (not when there is no text).
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Placed {
    #[serde(flatten)]
    pub line: Line,
    pub row: usize,
}

#[derive(Deserialize)]
struct Native {
    ok: bool,
    #[serde(default)]
    lines: Vec<Line>,
    #[serde(default)]
    error: Option<String>,
}

pub fn recognize(png: &[u8]) -> Recognized {
    match native(png) {
        Ok(lines) => layout(lines),
        Err(e) => Recognized {
            error: Some(e),
            ..Default::default()
        },
    }
}

#[cfg(target_os = "macos")]
fn native(png: &[u8]) -> Result<Vec<Line>, String> {
    extern "C" {
        fn companion_ocr_png(bytes: *const u8, len: usize) -> *mut std::ffi::c_char;
        fn companion_free(text: *mut std::ffi::c_char);
    }
    if png.is_empty() {
        return Ok(vec![]);
    }
    let raw = unsafe {
        let ptr = companion_ocr_png(png.as_ptr(), png.len());
        if ptr.is_null() {
            return Err("recognize".into());
        }
        let s = std::ffi::CStr::from_ptr(ptr).to_string_lossy().into_owned();
        companion_free(ptr);
        s
    };
    let n: Native = serde_json::from_str(&raw).map_err(|_| "recognize".to_owned())?;
    if n.ok {
        Ok(n.lines)
    } else {
        Err(n.error.unwrap_or_else(|| "recognize".into()))
    }
}

#[cfg(windows)]
#[path = "ocr_windows.rs"]
mod platform;
#[cfg(windows)]
use platform::native;

#[cfg(not(any(windows, target_os = "macos")))]
fn native(_: &[u8]) -> Result<Vec<Line>, String> {
    Err("unsupported".into())
}

/// Groups lines into rows and orders them top to bottom, left to right.
/// Sorting by top first and then growing one row at a time keeps the order
/// stable (a pairwise "same row" comparator is not transitive and can
/// scramble lines). A line joins the current row when it overlaps the row
/// vertically by more than half of the shorter height (Text-Grab's rule).
pub fn layout(mut lines: Vec<Line>) -> Recognized {
    lines.retain(|l| {
        !l.text.trim().is_empty() && [l.x, l.y, l.w, l.h].iter().all(|v| v.is_finite())
    });
    lines.sort_by(|a, b| a.y.total_cmp(&b.y).then(a.x.total_cmp(&b.x)));
    let mut rows: Vec<(f64, f64, Vec<Line>)> = vec![];
    for line in lines {
        let (top, bottom) = (line.y, line.y + line.h);
        if let Some((rt, rb, members)) = rows.last_mut() {
            let overlap = bottom.min(*rb) - top.max(*rt);
            let shorter = line.h.min(*rb - *rt);
            if shorter > 0. && overlap > shorter * 0.5 {
                *rt = rt.min(top);
                *rb = rb.max(bottom);
                members.push(line);
                continue;
            }
        }
        rows.push((top, bottom, vec![line]));
    }
    let mut placed = vec![];
    let mut text = String::new();
    for (row, (_, _, mut members)) in rows.into_iter().enumerate() {
        members.sort_by(|a, b| a.x.total_cmp(&b.x));
        if row > 0 {
            text.push('\n');
        }
        let mut row_text = String::new();
        for line in members {
            join(&mut row_text, line.text.trim());
            placed.push(Placed { line, row });
        }
        text.push_str(&row_text);
    }
    Recognized {
        lines: placed,
        text,
        error: None,
    }
}

/// Appends `next` to a row, adding a space only where a reader expects one:
/// next to Latin letters or digits, but never inside brackets/quotes or
/// before closing punctuation, and never between CJK characters
/// (after PowerToys PowerOCR OcrTextFormatter.ShouldInsertSpace).
pub fn join(row: &mut String, next: &str) {
    if let (Some(left), Some(right)) = (row.chars().last(), next.chars().next()) {
        if space_between(left, right) {
            row.push(' ');
        }
    }
    row.push_str(next);
}

fn space_between(left: char, right: char) -> bool {
    const OPENING: &str = "([{（【《「『“‘<";
    const CLOSING: &str = ")]}）】》」』”’>";
    const SUFFIX: &str = ",.:;!?%…‥";
    const CJK_PUNCT: &str = "、。・！％，．：；？｡､･";
    if OPENING.contains(left) || CLOSING.contains(right) || SUFFIX.contains(right) {
        return false;
    }
    if CJK_PUNCT.contains(left) || CJK_PUNCT.contains(right) {
        return false;
    }
    left.is_ascii_alphanumeric() || right.is_ascii_alphanumeric()
}

#[cfg(test)]
mod tests {
    use super::*;
    fn line(t: &str, x: f64, y: f64, w: f64, h: f64) -> Line {
        Line {
            text: t.into(),
            x,
            y,
            w,
            h,
        }
    }
    #[test]
    fn rows_are_grouped_and_ordered_even_when_slightly_uneven() {
        // Two columns on one row, the right one a bit higher; then a row below.
        let r = layout(vec![
            line("下一行", 0.1, 0.30, 0.3, 0.05),
            line("右边", 0.6, 0.095, 0.2, 0.05),
            line("左边", 0.1, 0.10, 0.2, 0.05),
        ]);
        assert_eq!(r.text, "左边右边\n下一行");
        assert_eq!(
            r.lines.iter().map(|p| p.row).collect::<Vec<_>>(),
            vec![0, 0, 1]
        );
    }
    #[test]
    fn joining_follows_cjk_and_latin_rules() {
        let mut s = String::from("中文");
        join(&mut s, "English");
        join(&mut s, "中文");
        assert_eq!(s, "中文 English 中文");
        let mut s = String::from("你好，");
        join(&mut s, "世界");
        assert_eq!(s, "你好，世界");
        let mut s = String::from("call(");
        join(&mut s, "x");
        join(&mut s, ")");
        assert_eq!(s, "call(x)");
        let mut s = String::from("Hello");
        join(&mut s, "world");
        join(&mut s, ".");
        assert_eq!(s, "Hello world.");
    }
    #[test]
    fn empty_and_broken_lines_are_dropped() {
        let r = layout(vec![
            line("  ", 0., 0., 0.1, 0.1),
            line("ok", f64::NAN, 0., 0.1, 0.1),
        ]);
        assert!(r.lines.is_empty() && r.text.is_empty());
    }
    /// Needs the real Vision engine; inside a sandbox that blocks its model
    /// cache the accurate model fails, which is now reported, not faked.
    #[cfg(target_os = "macos")]
    #[test]
    fn reads_text_and_positions_from_fixture_screenshot() {
        let bytes = include_bytes!("../../../../tests/fixtures/screen-sample.png");
        let r = recognize(bytes);
        if let Some(e) = &r.error {
            eprintln!("Vision unavailable here: {e}");
            return;
        }
        assert!(
            r.text.contains("Permission denied") && r.text.contains("Screen Recording"),
            "got: {:?}",
            r.text
        );
        assert!(r
            .lines
            .iter()
            .all(|p| (0.0..=1.0).contains(&p.line.y) && p.line.h > 0.));
    }
}
