//! 手机传文件's small rules, kept apart so they can be tested without a
//! network: who may connect, what a file may be called and where it lands,
//! the one-time code, and what a download is.
use std::hash::{BuildHasher, Hasher};
use std::net::{IpAddr, Ipv4Addr};
use std::path::{Path, PathBuf};

/// Only devices on the same local network: private, link-local and loopback
/// addresses (an IPv4 address inside IPv6 counts as itself).
pub fn local(addr: IpAddr) -> bool {
    match addr {
        IpAddr::V4(v4) => v4.is_private() || v4.is_link_local() || v4.is_loopback(),
        IpAddr::V6(v6) => {
            if let Some(v4) = v6.to_ipv4_mapped() {
                return local(IpAddr::V4(v4));
            }
            let first = v6.segments()[0];
            v6.is_loopback() || (first & 0xfe00) == 0xfc00 || (first & 0xffc0) == 0xfe80
        }
    }
}

/// Names of network interfaces that a phone on the same Wi-Fi cannot reach:
/// VPNs, virtual machines, containers, Apple's peer-to-peer links.
fn virtual_interface(name: &str) -> bool {
    let n = name.to_ascii_lowercase();
    let starts = [
        "lo", "utun", "tun", "tap", "wg", "zt", "ppp", "ipsec", "gif", "stf", "anpi", "awdl",
        "llw", "bridge", "ap1", "vnic",
    ];
    let contains = [
        "docker",
        "veth",
        "vbox",
        "virtualbox",
        "vmnet",
        "vmware",
        "vethernet",
        "hyper-v",
        "wsl",
        "tailscale",
        "zerotier",
        "wireguard",
        "loopback",
        "bluetooth",
    ];
    starts.iter().any(|s| n.starts_with(s)) || contains.iter().any(|s| n.contains(s))
}

/// The address to put in the QR code: a private IPv4 address on a real
/// Wi-Fi or Ethernet interface, the one the system routes through first,
/// home-style 192.168 before 10 before 172.16–31. None when there is none,
/// so the bubble says so instead of showing a code that cannot work.
pub fn pick_address(
    candidates: &[(String, Ipv4Addr)],
    route: Option<Ipv4Addr>,
) -> Option<Ipv4Addr> {
    candidates
        .iter()
        .filter(|(name, ip)| ip.is_private() && !virtual_interface(name))
        .max_by_key(|(name, ip)| {
            let o = ip.octets();
            let range = if o[0] == 192 {
                30
            } else if o[0] == 10 {
                20
            } else {
                10
            };
            let n = name.to_ascii_lowercase();
            let physical = n.starts_with("en")
                || n.starts_with("eth")
                || n.starts_with("wl")
                || n.contains("wi-fi")
                || n.contains("wlan")
                || n.contains("ethernet")
                || n.contains("以太网")
                || n.contains("乙太網路")
                || n.contains("イーサネット")
                || n.contains("이더넷");
            (route == Some(*ip)) as i32 * 100 + range + physical as i32 * 5
        })
        .map(|(_, ip)| *ip)
}

/// A random code for the address, 96 bits as 24 hex digits. The standard
/// library's hasher keys come from the system's randomness.
pub fn code() -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let mut out = String::new();
    for i in 0..2u8 {
        let mut h = std::collections::hash_map::RandomState::new().build_hasher();
        h.write_u128(nanos);
        h.write_u8(i);
        out.push_str(&format!("{:016x}", h.finish()));
    }
    out.truncate(24);
    out
}

/// A file name that is safe on both systems: the last part of whatever the
/// phone sent, without characters either system refuses, not a reserved
/// Windows name, at most 120 characters with the extension kept.
pub fn file_name(raw: &str) -> String {
    let base = raw.rsplit(['/', '\\']).next().unwrap_or("");
    let mut name: String = base
        .chars()
        .map(|c| {
            if c.is_control() || "<>:\"|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    name = name
        .trim_matches(|c: char| c == '.' || c.is_whitespace())
        .to_string();
    if name.is_empty() {
        name = "file".into();
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 && name.len() - i <= 12 => (name[..i].to_string(), name[i..].to_string()),
        _ => (name.clone(), String::new()),
    };
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3",
    ];
    let stem = if reserved.contains(&stem.to_ascii_uppercase().as_str()) {
        format!("_{stem}")
    } else {
        stem
    };
    let keep = 120usize.saturating_sub(ext.chars().count());
    let stem: String = stem.chars().take(keep).collect();
    stem + &ext
}

/// `dir/name`, or `name (2)`, `name (3)`… when that is taken.
pub fn unique(dir: &Path, name: &str) -> PathBuf {
    let first = dir.join(name);
    if !first.exists() {
        return first;
    }
    let (stem, ext) = match name.rfind('.') {
        Some(i) if i > 0 => (&name[..i], &name[i..]),
        _ => (name, ""),
    };
    (2..)
        .map(|n| dir.join(format!("{stem} ({n}){ext}")))
        .find(|p| !p.exists())
        .unwrap()
}

/// Streams an upload to a hidden part file and renames it to a safe, free
/// name only when exactly `size` bytes came, so a broken transfer leaves
/// nothing behind.
pub fn store(
    dir: &Path,
    part: &str,
    name: &str,
    size: u64,
    body: &mut dyn std::io::Read,
    length: Option<usize>,
) -> Result<PathBuf, String> {
    if length.is_some_and(|l| l as u64 != size) {
        return Err("length".into());
    }
    let part = dir.join(part);
    let written = (|| {
        let mut file = std::fs::File::create(&part).map_err(|e| e.to_string())?;
        std::io::copy(&mut std::io::Read::take(body, size + 1), &mut file)
            .map_err(|e| e.to_string())
    })();
    if written != Ok(size) {
        let _ = std::fs::remove_file(&part);
        return Err("short".into());
    }
    let path = unique(dir, &file_name(name));
    std::fs::rename(&part, &path).map_err(|e| e.to_string())?;
    Ok(path)
}

/// Whether `text` is a single web address, so the bubble can offer 打开.
pub fn link(text: &str) -> Option<String> {
    let t = text.trim();
    let one_word = !t.contains(char::is_whitespace);
    (one_word && (t.starts_with("https://") || t.starts_with("http://"))).then(|| t.to_string())
}

/// The media type for a download or a page asset, by extension.
pub fn media_type(name: &str) -> &'static str {
    let ext = name.rsplit('.').next().unwrap_or("").to_ascii_lowercase();
    match ext.as_str() {
        "html" => "text/html; charset=utf-8",
        "js" => "text/javascript; charset=utf-8",
        "css" => "text/css; charset=utf-8",
        "json" | "webmanifest" => "application/json; charset=utf-8",
        "txt" | "md" => "text/plain; charset=utf-8",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "heic" => "image/heic",
        "svg" => "image/svg+xml",
        "mp4" | "m4v" => "video/mp4",
        "mov" => "video/quicktime",
        "mp3" => "audio/mpeg",
        "m4a" => "audio/mp4",
        "pdf" => "application/pdf",
        "zip" => "application/zip",
        _ => "application/octet-stream",
    }
}

/// `attachment; filename*=UTF-8''…`, so any name downloads as itself.
pub fn disposition(name: &str) -> String {
    let encoded: String = name
        .bytes()
        .map(|b| {
            if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
                (b as char).to_string()
            } else {
                format!("%{b:02X}")
            }
        })
        .collect();
    format!("attachment; filename*=UTF-8''{encoded}")
}

/// Whether `path` is inside `dir`: only what 随伴 itself saved may be put in
/// the trash.
pub fn inside(path: &Path, dir: &Path) -> bool {
    match (path.canonicalize(), dir.canonicalize()) {
        (Ok(p), Ok(d)) => p != d && p.starts_with(&d),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn only_the_local_network_may_connect() {
        for ok in [
            "192.168.1.20",
            "10.0.0.5",
            "172.20.1.1",
            "169.254.3.4",
            "127.0.0.1",
            "fe80::1",
            "fd12::3",
            "::ffff:192.168.1.2",
        ] {
            assert!(local(ok.parse().unwrap()), "{ok}");
        }
        for no in ["8.8.8.8", "172.32.0.1", "2001:db8::1", "::ffff:1.1.1.1"] {
            assert!(!local(no.parse().unwrap()), "{no}");
        }
    }
    #[test]
    fn the_qr_address_is_a_real_local_network_card() {
        let ip = |s: &str| s.parse::<Ipv4Addr>().unwrap();
        let cards = |list: &[(&str, &str)]| {
            list.iter()
                .map(|(n, a)| (n.to_string(), ip(a)))
                .collect::<Vec<_>>()
        };
        // A VPN that takes the route is skipped for the Wi-Fi.
        let mac = cards(&[
            ("lo0", "127.0.0.1"),
            ("utun3", "10.8.0.2"),
            ("en0", "192.168.1.23"),
            ("bridge100", "192.168.64.1"),
        ]);
        assert_eq!(
            pick_address(&mac, Some(ip("10.8.0.2"))),
            Some(ip("192.168.1.23"))
        );
        // Windows names; a Hyper-V switch and Tailscale's 100.x are not it.
        let win = cards(&[
            ("vEthernet (WSL)", "172.20.0.1"),
            ("Tailscale", "100.101.1.2"),
            ("WLAN", "10.0.0.15"),
        ]);
        assert_eq!(pick_address(&win, None), Some(ip("10.0.0.15")));
        // The routed one wins among real cards.
        let two = cards(&[("en0", "192.168.1.23"), ("en7", "10.0.0.9")]);
        assert_eq!(
            pick_address(&two, Some(ip("10.0.0.9"))),
            Some(ip("10.0.0.9"))
        );
        // Not on any network: nothing, not 127.0.0.1.
        assert_eq!(pick_address(&cards(&[("lo0", "127.0.0.1")]), None), None);
        // Localized Windows Ethernet adapter names get the physical adapter bonus.
        for name in ["乙太網路", "イーサネット", "이더넷"] {
            let localized = cards(&[("other0", "192.168.1.10"), (name, "192.168.1.20")]);
            assert_eq!(pick_address(&localized, None), Some(ip("192.168.1.20")), "{name}");
        }
    }
    #[test]
    fn codes_are_long_hex_and_different() {
        let (a, b) = (code(), code());
        assert_eq!(a.len(), 24);
        assert!(a.chars().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
    }
    #[test]
    fn file_names_are_safe_everywhere() {
        assert_eq!(file_name("../../etc/passwd"), "passwd");
        assert_eq!(file_name("C:\\Users\\x\\照片 1.HEIC"), "照片 1.HEIC");
        assert_eq!(file_name("a<b>:c?.png"), "a_b__c_.png");
        assert_eq!(file_name("..."), "file");
        assert_eq!(file_name("con.txt"), "_con.txt");
        assert_eq!(file_name(".hidden"), "hidden");
        let long = format!("{}.mp4", "长".repeat(300));
        let safe = file_name(&long);
        assert_eq!(safe.chars().count(), 120);
        assert!(safe.ends_with(".mp4"));
    }
    #[test]
    fn a_taken_name_gets_a_number() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(unique(dir.path(), "a.jpg"), dir.path().join("a.jpg"));
        std::fs::write(dir.path().join("a.jpg"), b"x").unwrap();
        std::fs::write(dir.path().join("a (2).jpg"), b"x").unwrap();
        assert_eq!(unique(dir.path(), "a.jpg"), dir.path().join("a (3).jpg"));
    }
    #[test]
    fn an_upload_lands_whole_or_not_at_all() {
        let dir = tempfile::tempdir().unwrap();
        let ok = store(
            dir.path(),
            ".a.part",
            "../照片.jpg",
            5,
            &mut &b"hello"[..],
            Some(5),
        )
        .unwrap();
        assert_eq!(ok, dir.path().join("照片.jpg"));
        assert_eq!(std::fs::read(&ok).unwrap(), b"hello");
        // Cut short, too long, or a wrong length: nothing is left.
        assert!(store(dir.path(), ".b.part", "b.jpg", 5, &mut &b"hel"[..], None).is_err());
        assert!(store(dir.path(), ".c.part", "c.jpg", 5, &mut &b"hello!"[..], None).is_err());
        assert!(store(
            dir.path(),
            ".d.part",
            "d.jpg",
            5,
            &mut &b"hello"[..],
            Some(9)
        )
        .is_err());
        let left: Vec<_> = std::fs::read_dir(dir.path())
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(left, vec![std::ffi::OsString::from("照片.jpg")]);
    }
    #[test]
    fn links_downloads_and_the_trash_rule() {
        assert_eq!(link(" https://a.cn/x "), Some("https://a.cn/x".into()));
        assert_eq!(link("看看 https://a.cn"), None);
        assert_eq!(media_type("IMG.JPG"), "image/jpeg");
        assert_eq!(
            disposition("照 片.png"),
            "attachment; filename*=UTF-8''%E7%85%A7%20%E7%89%87.png"
        );
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a.txt");
        std::fs::write(&file, b"x").unwrap();
        assert!(inside(&file, dir.path()));
        assert!(!inside(dir.path(), dir.path()));
        assert!(!inside(Path::new("/etc/hosts"), dir.path()));
    }
}
