//! 全部下载: several files as one zip, for phones that take one download at
//! a time (iPhone). Stored, not compressed: photos and videos are compressed
//! already, and it streams without holding anything in memory. Plain zip
//! without the 64-bit extension, so up to 4 GB in all; a bigger set is
//! refused and the page says to download one by one.
use std::io::{self, Read, Write};
use std::path::PathBuf;

/// The largest set one zip can hold.
pub const LIMIT: u64 = 0xFFFF_FFFF - 1024 * 1024;

fn crc_table() -> [u32; 256] {
    let mut table = [0u32; 256];
    for (n, slot) in table.iter_mut().enumerate() {
        let mut c = n as u32;
        for _ in 0..8 {
            c = if c & 1 != 0 {
                0xEDB8_8320 ^ (c >> 1)
            } else {
                c >> 1
            };
        }
        *slot = c;
    }
    table
}
fn crc_update(table: &[u32; 256], crc: u32, bytes: &[u8]) -> u32 {
    bytes.iter().fold(crc, |c, b| {
        table[((c ^ *b as u32) & 0xFF) as usize] ^ (c >> 8)
    })
}

/// A name for each file, made unique inside the zip ("a.jpg", "a (2).jpg").
pub fn names(files: &[(String, PathBuf)]) -> Vec<String> {
    let mut used: Vec<String> = vec![];
    for (name, _) in files {
        let (stem, ext) = match name.rsplit_once('.') {
            Some((s, e)) if !s.is_empty() => (s.to_string(), format!(".{e}")),
            _ => (name.clone(), String::new()),
        };
        let mut candidate = name.clone();
        let mut n = 2;
        while used.contains(&candidate) {
            candidate = format!("{stem} ({n}){ext}");
            n += 1;
        }
        used.push(candidate);
    }
    used
}

/// Writes the files as a stored zip. Each entry's size and checksum follow
/// its data, so nothing is read twice.
pub fn write(out: &mut impl Write, files: &[(String, PathBuf)]) -> io::Result<()> {
    let table = crc_table();
    let names = names(files);
    let mut offset: u32 = 0;
    let mut central = Vec::new();
    let mut count: u16 = 0;
    for ((_, path), name) in files.iter().zip(&names) {
        let Ok(mut file) = std::fs::File::open(path) else {
            continue;
        };
        let name = name.as_bytes();
        // Local header: version, flags (sizes after the data, UTF-8 name),
        // stored, no time, crc and sizes zero here.
        let mut head = Vec::with_capacity(30 + name.len());
        head.extend_from_slice(&0x0403_4b50u32.to_le_bytes());
        head.extend_from_slice(&20u16.to_le_bytes());
        head.extend_from_slice(&(0x0008u16 | 0x0800).to_le_bytes());
        head.extend_from_slice(&0u16.to_le_bytes());
        head.extend_from_slice(&[0, 0, 0x21, 0]); // time 0, date 1980-01-01
        head.extend_from_slice(&[0; 12]);
        head.extend_from_slice(&(name.len() as u16).to_le_bytes());
        head.extend_from_slice(&0u16.to_le_bytes());
        head.extend_from_slice(name);
        out.write_all(&head)?;
        let mut crc = 0xFFFF_FFFFu32;
        let mut size: u64 = 0;
        let mut buf = vec![0u8; 64 * 1024];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            crc = crc_update(&table, crc, &buf[..n]);
            size += n as u64;
            out.write_all(&buf[..n])?;
        }
        let crc = !crc;
        let size = u32::try_from(size)
            .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "too big"))?;
        // Data descriptor.
        out.write_all(&0x0807_4b50u32.to_le_bytes())?;
        out.write_all(&crc.to_le_bytes())?;
        out.write_all(&size.to_le_bytes())?;
        out.write_all(&size.to_le_bytes())?;
        // Its central directory entry.
        central.extend_from_slice(&0x0201_4b50u32.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&20u16.to_le_bytes());
        central.extend_from_slice(&(0x0008u16 | 0x0800).to_le_bytes());
        central.extend_from_slice(&0u16.to_le_bytes());
        central.extend_from_slice(&[0, 0, 0x21, 0]);
        central.extend_from_slice(&crc.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&size.to_le_bytes());
        central.extend_from_slice(&(name.len() as u16).to_le_bytes());
        central.extend_from_slice(&[0; 12]); // extra, comment, disk, attrs
        central.extend_from_slice(&offset.to_le_bytes());
        central.extend_from_slice(name);
        offset = offset
            .checked_add(head.len() as u32 + size + 16)
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "too big"))?;
        count += 1;
    }
    out.write_all(&central)?;
    // End of central directory.
    out.write_all(&0x0605_4b50u32.to_le_bytes())?;
    out.write_all(&[0; 4])?;
    out.write_all(&count.to_le_bytes())?;
    out.write_all(&count.to_le_bytes())?;
    out.write_all(&(central.len() as u32).to_le_bytes())?;
    out.write_all(&offset.to_le_bytes())?;
    out.write_all(&0u16.to_le_bytes())?;
    out.flush()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_checksum_is_the_standard_one() {
        let t = crc_table();
        assert_eq!(!crc_update(&t, 0xFFFF_FFFF, b"123456789"), 0xCBF4_3926);
    }

    #[test]
    fn same_names_get_a_number() {
        let f = |n: &str| (n.to_string(), PathBuf::new());
        assert_eq!(
            names(&[f("a.jpg"), f("a.jpg"), f("b"), f("b"), f("a.jpg")]),
            ["a.jpg", "a (2).jpg", "b", "b (2)", "a (3).jpg"]
        );
    }

    #[test]
    fn the_zip_opens_with_the_files_inside() {
        let dir = std::env::temp_dir().join(format!("suiban-zip-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let a = dir.join("a.txt");
        let b = dir.join("照片.jpg");
        std::fs::write(&a, b"hello").unwrap();
        std::fs::write(&b, vec![7u8; 200_000]).unwrap();
        let zip = dir.join("all.zip");
        let mut out = std::fs::File::create(&zip).unwrap();
        write(
            &mut out,
            &[
                ("a.txt".into(), a),
                ("照片.jpg".into(), b),
                ("a.txt".into(), dir.join("missing")),
            ],
        )
        .unwrap();
        drop(out);
        // Checked by Python's zipfile where it is installed.
        let check = std::process::Command::new("python3")
            .args([
                "-c",
                "import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);assert z.testzip() is None;print(','.join(f'{i.filename}:{i.file_size}' for i in z.infolist()))",
            ])
            .arg(&zip)
            .output();
        if let Ok(o) = check {
            assert!(o.status.success(), "{}", String::from_utf8_lossy(&o.stderr));
            assert_eq!(
                String::from_utf8_lossy(&o.stdout).trim(),
                "a.txt:5,照片.jpg:200000"
            );
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
