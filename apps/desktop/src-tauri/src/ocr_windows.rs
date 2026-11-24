// WinRT OCR runs on the screenshot worker, using the user's installed languages.
use super::Line;
use windows::{
    Graphics::Imaging::{BitmapPixelFormat, SoftwareBitmap},
    Media::Ocr::OcrEngine,
    Security::Cryptography::CryptographicBuffer,
    Win32::System::WinRT::{RoInitialize, RoUninitialize, RO_INIT_MULTITHREADED},
};

struct Apartment;
impl Drop for Apartment {
    fn drop(&mut self) {
        unsafe { RoUninitialize() };
    }
}

pub(super) fn native(png: &[u8]) -> Result<Vec<Line>, String> {
    unsafe { RoInitialize(RO_INIT_MULTITHREADED) }.map_err(|_| "recognize")?;
    let _apartment = Apartment;
    let engine = OcrEngine::TryCreateFromUserProfileLanguages()
        .or_else(|_| {
            OcrEngine::TryCreateFromLanguage(&OcrEngine::AvailableRecognizerLanguages()?.GetAt(0)?)
        })
        .map_err(|_| "ocrLanguage")?;
    let limit = OcrEngine::MaxImageDimension().map_err(|_| "recognize")?;
    let mut img = image::load_from_memory(png).map_err(|_| "recognize")?;
    if img.width().max(img.height()) > limit {
        img = img.thumbnail(limit, limit);
    }
    let gray = img.into_luma8();
    let (w, h) = gray.dimensions();
    let recognize = || -> windows::core::Result<Vec<Line>> {
        let bytes = CryptographicBuffer::CreateFromByteArray(gray.as_raw())?;
        let bitmap = SoftwareBitmap::CreateCopyFromBuffer(
            &bytes,
            BitmapPixelFormat::Gray8,
            w as i32,
            h as i32,
        )?;
        let result = engine.RecognizeAsync(&bitmap)?.join()?;
        let mut lines = Vec::new();
        for line in result.Lines()? {
            let (mut left, mut top, mut right, mut bottom) = (w as f32, h as f32, 0f32, 0f32);
            let mut text = String::new();
            for word in line.Words()? {
                let r = word.BoundingRect()?;
                left = left.min(r.X);
                top = top.min(r.Y);
                right = right.max(r.X + r.Width);
                bottom = bottom.max(r.Y + r.Height);
                super::join(&mut text, &word.Text()?.to_string_lossy());
            }
            if right > left && bottom > top {
                lines.push(Line {
                    text,
                    x: f64::from(left) / f64::from(w),
                    y: f64::from(top) / f64::from(h),
                    w: f64::from(right - left) / f64::from(w),
                    h: f64::from(bottom - top) / f64::from(h),
                });
            }
        }
        Ok(lines)
    };
    recognize().map_err(|_| "recognize".into())
}

#[cfg(test)]
mod tests {
    #[test]
    fn windows_ocr_reads_fixture_and_returns_normalized_bounds() {
        let result =
            super::native(include_bytes!("../../../../tests/fixtures/windows-ocr.png")).unwrap();
        assert!(result.iter().any(|line| line.text.contains("123")));
        for line in result {
            assert!(line.w > 0. && line.h > 0. && line.x >= 0. && line.y >= 0.);
            assert!(line.x + line.w <= 1.001 && line.y + line.h <= 1.001);
        }
    }
}
