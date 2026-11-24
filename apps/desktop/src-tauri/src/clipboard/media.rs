use base64::{engine::general_purpose::STANDARD as BASE64, Engine};
use image::{
    codecs::{png::PngEncoder, webp::WebPEncoder},
    imageops, ColorType, ImageEncoder, ImageFormat, ImageReader, RgbaImage,
};
use rusqlite::Connection;
use sha2::{Digest, Sha256};
use std::{
    collections::HashSet,
    fs,
    io::Cursor,
    path::{Path, PathBuf},
    time::{Duration, SystemTime},
};

pub const MAX_IMAGE_BYTES: usize = 15 * 1024 * 1024;
pub const MAX_IMAGE_PIXELS: u64 = 25_000_000;
pub const THUMB_EDGE: u32 = 160;

pub struct PreparedImage {
    pub digest: [u8; 32],
    pub png: Vec<u8>,
    pub thumb_webp: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub media_name: String,
    pub thumb_name: String,
}

pub fn media_dir(db_path: &Path) -> PathBuf {
    db_path
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("clipboard-media")
}

fn hex_encode(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &b in bytes {
        out.push(HEX[(b >> 4) as usize] as char);
        out.push(HEX[(b & 0x0f) as usize] as char);
    }
    out
}

pub fn prepare_png(png: Vec<u8>) -> Option<PreparedImage> {
    if png.is_empty() || png.len() > MAX_IMAGE_BYTES {
        return None;
    }
    let (width, height) = ImageReader::with_format(Cursor::new(&png), ImageFormat::Png)
        .into_dimensions()
        .ok()?;
    if width == 0 || height == 0 || (width as u64) * (height as u64) > MAX_IMAGE_PIXELS {
        return None;
    }
    let decoded = image::load_from_memory_with_format(&png, ImageFormat::Png).ok()?;
    let rgba = decoded.to_rgba8();
    let edge = width.max(height);
    let thumb = if edge > THUMB_EDGE {
        let scale = |n: u32| ((n as u64 * THUMB_EDGE as u64) / edge as u64).max(1) as u32;
        imageops::resize(
            &rgba,
            scale(width),
            scale(height),
            imageops::FilterType::Triangle,
        )
    } else {
        rgba
    };
    let mut thumb_webp = Vec::new();
    WebPEncoder::new_lossless(&mut thumb_webp)
        .encode(
            thumb.as_raw(),
            thumb.width(),
            thumb.height(),
            ColorType::Rgba8.into(),
        )
        .ok()?;
    let mut hasher = Sha256::new();
    hasher.update(b"img:");
    hasher.update(&png);
    let digest: [u8; 32] = hasher.finalize().into();
    let hash = hex_encode(&digest);
    Some(PreparedImage {
        digest,
        png,
        thumb_webp,
        width,
        height,
        media_name: format!("{hash}.png"),
        thumb_name: format!("{hash}.thumb.webp"),
    })
}

/// Convert a Windows CF_DIB / CF_DIBV5 buffer (BITMAPINFOHEADER + pixel data) into a PNG.
pub fn dib_to_png(dib: &[u8]) -> Option<Vec<u8>> {
    if dib.len() < 40 {
        return None;
    }
    let header_size = u32::from_le_bytes(dib[0..4].try_into().ok()?) as usize;
    if header_size < 40 || header_size > dib.len() {
        return None;
    }
    let raw_w = i32::from_le_bytes(dib[4..8].try_into().ok()?);
    let raw_h = i32::from_le_bytes(dib[8..12].try_into().ok()?);
    let planes = u16::from_le_bytes(dib[12..14].try_into().ok()?);
    let bpp = u16::from_le_bytes(dib[14..16].try_into().ok()?);
    let compression = u32::from_le_bytes(dib[16..20].try_into().ok()?);
    let clr_used = u32::from_le_bytes(dib[32..36].try_into().ok()?) as usize;
    if planes != 1 || raw_w <= 0 || raw_h == 0 || raw_h == i32::MIN {
        return None;
    }
    let width = raw_w as u32;
    let top_down = raw_h < 0;
    let height = raw_h.unsigned_abs();
    if (width as u64) * (height as u64) > MAX_IMAGE_PIXELS {
        return None;
    }
    // BI_RGB = 0, BI_BITFIELDS = 3
    if compression != 0 && !(compression == 3 && bpp == 32) {
        return None;
    }
    if bpp != 24 && bpp != 32 {
        return None;
    }
    let masks_extra = if compression == 3 && header_size == 40 {
        12
    } else {
        0
    };
    let palette_bytes = clr_used.checked_mul(4)?;
    let pixel_offset = header_size
        .checked_add(masks_extra)?
        .checked_add(palette_bytes)?;
    let stride = (((width as usize) * (bpp as usize) + 31) / 32) * 4;
    let needed = stride.checked_mul(height as usize)?;
    if pixel_offset.checked_add(needed)? > dib.len() {
        return None;
    }
    let pixels = &dib[pixel_offset..pixel_offset + needed];
    let mut out = vec![0u8; (width as usize) * (height as usize) * 4];

    // Default BGRA bit masks (standard for BI_RGB and default BI_BITFIELDS).
    let (mut r_mask, mut g_mask, mut b_mask, mut a_mask) =
        (0x00FF_0000u32, 0x0000_FF00u32, 0x0000_00FFu32, 0xFF00_0000u32);
    if compression == 3 {
        let m_off = if header_size >= 56 { 40 } else { 40 };
        if m_off + 12 <= dib.len() {
            r_mask = u32::from_le_bytes(dib[m_off..m_off + 4].try_into().ok()?);
            g_mask = u32::from_le_bytes(dib[m_off + 4..m_off + 8].try_into().ok()?);
            b_mask = u32::from_le_bytes(dib[m_off + 8..m_off + 12].try_into().ok()?);
            if header_size >= 56 {
                a_mask = u32::from_le_bytes(dib[m_off + 12..m_off + 16].try_into().ok()?);
            } else {
                a_mask = 0;
            }
        }
    }
    let extract = |val: u32, mask: u32| -> u8 {
        if mask == 0 {
            return 0;
        }
        let shift = mask.trailing_zeros();
        let max = mask >> shift;
        if max == 0 {
            return 0;
        }
        let v = (val & mask) >> shift;
        if max == 255 {
            v as u8
        } else {
            ((v as u64 * 255) / max as u64) as u8
        }
    };

    let mut any_nonzero_alpha = false;
    for y in 0..height as usize {
        let src_y = if top_down {
            y
        } else {
            height as usize - 1 - y
        };
        let row = &pixels[src_y * stride..src_y * stride + stride];
        let dst_row = &mut out[y * (width as usize) * 4..(y + 1) * (width as usize) * 4];
        if bpp == 24 {
            for x in 0..width as usize {
                dst_row[x * 4] = row[x * 3 + 2];
                dst_row[x * 4 + 1] = row[x * 3 + 1];
                dst_row[x * 4 + 2] = row[x * 3];
                dst_row[x * 4 + 3] = 255;
            }
            any_nonzero_alpha = true;
        } else {
            for x in 0..width as usize {
                let px = u32::from_le_bytes(row[x * 4..x * 4 + 4].try_into().ok()?);
                dst_row[x * 4] = extract(px, r_mask);
                dst_row[x * 4 + 1] = extract(px, g_mask);
                dst_row[x * 4 + 2] = extract(px, b_mask);
                let a = if a_mask != 0 {
                    extract(px, a_mask)
                } else {
                    255
                };
                if a != 0 {
                    any_nonzero_alpha = true;
                }
                dst_row[x * 4 + 3] = a;
            }
        }
    }
    // Many Windows apps write 32-bit BI_RGB screenshots with alpha bytes zeroed.
    if !any_nonzero_alpha {
        for chunk in out.chunks_exact_mut(4) {
            chunk[3] = 255;
        }
    }
    let img = RgbaImage::from_raw(width, height, out)?;
    let mut bytes = Vec::new();
    PngEncoder::new(&mut bytes)
        .write_image(img.as_raw(), width, height, ColorType::Rgba8.into())
        .ok()?;
    if bytes.len() > MAX_IMAGE_BYTES {
        return None;
    }
    Some(bytes)
}

pub fn decode_png_rgba(png: &[u8]) -> Option<(Vec<u8>, u32, u32)> {
    let img = image::load_from_memory_with_format(png, ImageFormat::Png)
        .ok()?
        .to_rgba8();
    let (w, h) = img.dimensions();
    Some((img.into_raw(), w, h))
}

pub fn safe_name(name: &str) -> bool {
    if name.is_empty() || name.len() > 80 {
        return false;
    }
    let hex = name
        .strip_suffix(".thumb.webp")
        .or_else(|| name.strip_suffix(".png"));
    matches!(hex, Some(h) if h.len() == 64 && h.bytes().all(|b| b.is_ascii_hexdigit()))
}

pub fn safe_join(dir: &Path, name: &str) -> Option<PathBuf> {
    safe_name(name).then(|| dir.join(name))
}

fn set_private_dir(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o700));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn set_private_file(path: &Path) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
    }
    #[cfg(not(unix))]
    let _ = path;
}

fn write_atomic_if_missing(dir: &Path, name: &str, bytes: &[u8]) -> std::io::Result<()> {
    let target = dir.join(name);
    if target.exists() {
        return Ok(());
    }
    let tmp = dir.join(format!(".tmp-{}-{name}", std::process::id()));
    fs::write(&tmp, bytes)?;
    set_private_file(&tmp);
    fs::rename(&tmp, &target).or_else(|e| {
        let _ = fs::remove_file(&tmp);
        if target.exists() {
            Ok(())
        } else {
            Err(e)
        }
    })
}

pub fn write_media_files(dir: &Path, img: &PreparedImage) -> std::io::Result<()> {
    if !dir.exists() {
        fs::create_dir_all(dir)?;
    }
    set_private_dir(dir);
    write_atomic_if_missing(dir, &img.media_name, &img.png)?;
    write_atomic_if_missing(dir, &img.thumb_name, &img.thumb_webp)?;
    Ok(())
}

pub fn read_bytes(dir: &Path, name: &str) -> Option<Vec<u8>> {
    let path = safe_join(dir, name)?;
    fs::read(path).ok()
}

pub fn read_data_url(dir: &Path, name: &str, mime: &str) -> Option<String> {
    let bytes = read_bytes(dir, name)?;
    Some(format!("data:{mime};base64,{}", BASE64.encode(bytes)))
}

pub fn delete_unused(dir: &Path, db: &Connection, candidates: &[(String, String)]) {
    if candidates.is_empty() || !dir.exists() {
        return;
    }
    for (media, thumb) in candidates {
        if !media.is_empty() {
            let used = db
                .query_row(
                    "SELECT 1 FROM clips WHERE media=?1 LIMIT 1",
                    [media],
                    |_| Ok(()),
                )
                .is_ok();
            if !used {
                if let Some(p) = safe_join(dir, media) {
                    let _ = fs::remove_file(p);
                }
            }
        }
        if !thumb.is_empty() {
            let used = db
                .query_row(
                    "SELECT 1 FROM clips WHERE thumb=?1 LIMIT 1",
                    [thumb],
                    |_| Ok(()),
                )
                .is_ok();
            if !used {
                if let Some(p) = safe_join(dir, thumb) {
                    let _ = fs::remove_file(p);
                }
            }
        }
    }
}

pub fn sweep_orphans(dir: &Path, db: &Connection) {
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut keep = HashSet::new();
    if let Ok(mut stmt) = db.prepare("SELECT media, thumb FROM clips WHERE kind='image'") {
        if let Ok(rows) = stmt.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))
        {
            for row in rows.flatten() {
                if !row.0.is_empty() {
                    keep.insert(row.0);
                }
                if !row.1.is_empty() {
                    keep.insert(row.1);
                }
            }
        }
    }
    let cutoff = SystemTime::now() - Duration::from_secs(300);
    for entry in entries.flatten() {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if keep.contains(name_str) {
            continue;
        }
        let stale = entry
            .metadata()
            .and_then(|m| m.modified())
            .map(|t| t < cutoff)
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_file(entry.path());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample_png(w: u32, h: u32, color: [u8; 4]) -> Vec<u8> {
        let mut img = RgbaImage::new(w, h);
        for px in img.pixels_mut() {
            *px = image::Rgba(color);
        }
        let mut out = Vec::new();
        PngEncoder::new(&mut out)
            .write_image(img.as_raw(), w, h, ColorType::Rgba8.into())
            .unwrap();
        out
    }

    #[test]
    fn prepare_png_scales_thumbnail_and_preserves_original_bytes() {
        let png = sample_png(640, 320, [20, 120, 240, 255]);
        let prepared = prepare_png(png.clone()).unwrap();
        assert_eq!(prepared.width, 640);
        assert_eq!(prepared.height, 320);
        assert_eq!(prepared.png, png);
        assert!(safe_name(&prepared.media_name));
        assert!(safe_name(&prepared.thumb_name));
        let thumb = image::load_from_memory_with_format(&prepared.thumb_webp, ImageFormat::WebP)
            .unwrap();
        assert_eq!((thumb.width(), thumb.height()), (160, 80));
    }

    #[test]
    fn dib_to_png_decodes_bottom_up_32bit_opaque_screenshot() {
        // 2x2 32-bit BI_RGB bottom-up DIB with zeroed alpha (common on Windows)
        let mut dib = vec![0u8; 40 + 2 * 2 * 4];
        dib[0..4].copy_from_slice(&40u32.to_le_bytes());
        dib[4..8].copy_from_slice(&2i32.to_le_bytes());
        dib[8..12].copy_from_slice(&2i32.to_le_bytes()); // bottom-up
        dib[12..14].copy_from_slice(&1u16.to_le_bytes());
        dib[14..16].copy_from_slice(&32u16.to_le_bytes());
        // Bottom row (y=1): blue (B=255, G=0, R=0, A=0)
        dib[40..44].copy_from_slice(&[255, 0, 0, 0]);
        dib[44..48].copy_from_slice(&[255, 0, 0, 0]);
        // Top row (y=0): red (B=0, G=0, R=255, A=0)
        dib[48..52].copy_from_slice(&[0, 0, 255, 0]);
        dib[52..56].copy_from_slice(&[0, 0, 255, 0]);

        let png = dib_to_png(&dib).unwrap();
        let (rgba, w, h) = decode_png_rgba(&png).unwrap();
        assert_eq!((w, h), (2, 2));
        // Top-left should be opaque red, bottom-left opaque blue
        assert_eq!(&rgba[0..4], &[255, 0, 0, 255]);
        assert_eq!(&rgba[8..12], &[0, 0, 255, 255]);
    }

    #[test]
    fn safe_name_rejects_path_traversal() {
        assert!(!safe_name("../secret.png"));
        assert!(!safe_name("abc.png"));
        assert!(!safe_name(""));
    }
}
