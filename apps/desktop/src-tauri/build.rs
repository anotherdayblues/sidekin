use std::collections::BTreeMap;
use std::fs;
use std::path::{Path, PathBuf};

fn collect_skills(root: &Path, dir: &Path, out: &mut BTreeMap<String, PathBuf>) {
    println!("cargo:rerun-if-changed={}", dir.display());
    let Ok(entries) = fs::read_dir(dir) else {
        return;
    };
    let mut entries: Vec<_> = entries.flatten().collect();
    entries.sort_by_key(|e| e.file_name());
    for entry in entries {
        let name = entry.file_name();
        let Some(name_str) = name.to_str() else {
            continue;
        };
        if name_str == "__pycache__"
            || name_str == ".DS_Store"
            || name_str == ".integrity.json"
            || name_str.ends_with(".pyc")
        {
            continue;
        }
        let path = entry.path();
        if path.is_dir() {
            collect_skills(root, &path, out);
        } else if path.is_file() {
            println!("cargo:rerun-if-changed={}", path.display());
            if let Ok(rel) = path.strip_prefix(root) {
                let posix = rel
                    .components()
                    .map(|c| c.as_os_str().to_string_lossy().into_owned())
                    .collect::<Vec<_>>()
                    .join("/");
                out.insert(posix, path);
            }
        }
    }
}

fn emit_factory_skills() {
    let manifest_dir = PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("manifest dir"));
    let skills_dir = manifest_dir.join("../../../skills");
    let canonical = skills_dir.canonicalize().unwrap_or(skills_dir);
    let mut files = BTreeMap::new();
    collect_skills(&canonical, &canonical, &mut files);
    let mut code = String::from("pub const FACTORY_SKILLS: &[(&str, &[u8])] = &[\n");
    for (rel, path) in files {
        code.push_str(&format!(
            "    ({rel:?}, include_bytes!({:?})),\n",
            path.to_string_lossy()
        ));
    }
    code.push_str("];\n");
    let out = PathBuf::from(std::env::var("OUT_DIR").expect("out dir")).join("bundled_skills.rs");
    fs::write(out, code).expect("write bundled_skills.rs");
}

fn main() {
    emit_factory_skills();
    match std::env::var("CARGO_CFG_TARGET_OS").as_deref() {
        Ok("macos") => {
            println!("cargo:rerun-if-changed=native/file-transfer.m");
            cc::Build::new()
                .file("native/file-transfer.m")
                .flag("-fobjc-arc")
                .compile("file_transfer_pointer");
            println!("cargo:rerun-if-changed=native/clipboard.m");
            println!("cargo:rerun-if-changed=native/copy-keys.m");
            println!("cargo:rerun-if-changed=native/selection.m");
            let mut selection = cc::Build::new();
            if std::env::var_os("CARGO_FEATURE_ACCEPTANCE").is_some() {
                selection.define("CLIPBOARD_FIXTURE", None);
            }
            selection
                .file("native/selection.m")
                .file("native/clipboard.m")
                .file("native/copy-keys.m")
                .flag("-fobjc-arc")
                .compile("companion_selection");
            println!("cargo:rerun-if-changed=native/ocr.m");
            cc::Build::new()
                .file("native/ocr.m")
                .flag("-fobjc-arc")
                .compile("companion_ocr");
            println!("cargo:rerun-if-changed=native/overlay.m");
            cc::Build::new()
                .file("native/overlay.m")
                .flag("-fobjc-arc")
                .compile("companion_overlay");
            println!("cargo:rerun-if-changed=native/clock-window.m");
            cc::Build::new()
                .file("native/clock-window.m")
                .flag("-fobjc-arc")
                .compile("companion_clock_window");
            println!("cargo:rerun-if-changed=native/locale.m");
            cc::Build::new()
                .file("native/locale.m")
                .flag("-fobjc-arc")
                .compile("companion_locale");
            if std::env::var_os("CARGO_FEATURE_ACCEPTANCE").is_some() {
                println!("cargo:rerun-if-changed=native/qa-window.m");
                cc::Build::new()
                    .file("native/qa-window.m")
                    .flag("-fobjc-arc")
                    .compile("companion_qa_window");
            }
            for f in ["AppKit", "ApplicationServices", "QuartzCore", "Vision"] {
                println!("cargo:rustc-link-lib=framework={f}");
            }
        }
        Ok("windows") => {
            println!("cargo:rerun-if-changed=native/clipboard.cpp");
            println!("cargo:rerun-if-changed=native/copy-keys.cpp");
            println!("cargo:rerun-if-changed=native/selection.cpp");
            println!("cargo:rerun-if-changed=native/windows-desktop.cpp");
            cc::Build::new()
                .file("native/windows-desktop.cpp")
                .cpp(true)
                .file("native/selection.cpp")
                .file("native/clipboard.cpp")
                .file("native/copy-keys.cpp")
                .compile("companion_selection");
            for lib in ["ole32", "shell32", "user32", "uuid", "comctl32"] {
                println!("cargo:rustc-link-lib={lib}");
            }
        }
        _ => {}
    }
    tauri_build::build()
}
