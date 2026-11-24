//! A captured picture as PNG: shrunk for a model to look at, or whole for
//! text recognition.
use crate::locale::t;
use image::{codecs::png::PngEncoder, imageops, ColorType, ImageEncoder, RgbaImage};

/// At most 1568 pixels on its long edge, the size vision models take.
pub fn png(image: RgbaImage) -> Result<Vec<u8>, String> {
    let edge = image.width().max(image.height());
    let image = if edge > 1568 {
        let dim = |n: u32| ((n as u64 * 1568 / edge as u64) as u32).max(1);
        imageops::resize(
            &image,
            dim(image.width()),
            dim(image.height()),
            imageops::FilterType::Triangle,
        )
    } else {
        image
    };
    encode(&image)
}
/// Lossless PNG at full size, for text recognition: shrinking a whole
/// Retina screen to the model's size would make small text unreadable.
pub fn encode(image: &RgbaImage) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(
            image.as_raw(),
            image.width(),
            image.height(),
            ColorType::Rgba8.into(),
        )
        .map_err(|_| t("host.snipEncode"))?;
    Ok(bytes)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resize_preserves_aspect() {
        let bytes = png(RgbaImage::new(3200, 800)).unwrap();
        let img = image::load_from_memory(&bytes).unwrap();
        assert_eq!((img.width(), img.height()), (1568, 392));
    }
}
