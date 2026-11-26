//! The inbox: how makers outside the app (Codex skills today, other tools
//! later) hand things to Pet Studio. See docs/收件箱约定.md.
//!
//! A maker writes a folder as `inbox/.tmp-<name>` and renames it to
//! `inbox/<name>` when complete. The app picks it up, decides what it is
//! from the manifest inside, and answers with a receipt:
//! `inbox/.done-<name>.json` on success, `inbox/.failed-<name>/error.txt`
//! when the package was refused (the folder is kept for inspection).
use crate::locale::t;
use crate::{library, teaching};
use serde::Serialize;
use std::{
    fs,
    path::Path,
    time::{Duration, SystemTime},
};

#[derive(Debug, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum Arrival {
    Tool {
        id: String,
        ticket: String,
        status: String,
    },
    /// A pet package (`pet.json`): imported, or updated when the id exists.
    #[serde(rename_all = "camelCase")]
    Pet {
        pet_id: String,
        name: String,
        updated: bool,
    },
    /// A teaching (`teaching.json`): becomes a draft awaiting the user.
    #[serde(rename_all = "camelCase")]
    Teaching {
        pet_id: String,
        draft_id: String,
        summary: String,
    },
    /// An incremental outfit (`outfit.json`): installed onto an existing pet.
    #[serde(rename_all = "camelCase")]
    Outfit {
        pet_id: String,
        outfit_id: String,
        display_name: String,
        updated: bool,
    },
}

/// Decide what a delivered folder is and take it in.
fn receive(root: &Path, dir: &Path) -> Result<Arrival, String> {
    if dir.is_symlink() {
        return Err("收件箱拒收符号链接".into());
    }
    if fs::symlink_metadata(dir.join("tool.json")).is_ok() {
        let ticket = dir
            .file_name()
            .and_then(|s| s.to_str())
            .ok_or("投递编号无效")?;
        let id = crate::tool_cards::receive(root, dir, ticket)?;
        return Ok(Arrival::Tool {
            id,
            ticket: ticket.into(),
            status: "received".into(),
        });
    }
    if dir.join("pet.json").is_file() {
        let r = library::import(root, dir)?;
        return Ok(Arrival::Pet {
            pet_id: r.pet.id,
            name: r.pet.display_name,
            updated: r.updated,
        });
    }
    if dir.join("teaching.json").is_file() {
        let d = teaching::intake(root, dir)?;
        return Ok(Arrival::Teaching {
            pet_id: d.pet_id,
            draft_id: d.id,
            summary: d.summary,
        });
    }
    if dir.join("outfit.json").is_file() {
        let r = library::install_outfit(root, dir)?;
        return Ok(Arrival::Outfit {
            pet_id: r.pet_id,
            outfit_id: r.outfit_id,
            display_name: r.display_name,
            updated: r.updated,
        });
    }
    Err(t("host.unknownPackage").into())
}

/// Take in every finished folder; returns what arrived or why it failed.
pub fn scan(root: &Path) -> Vec<Result<Arrival, String>> {
    let inbox = root.join("inbox");
    let Ok(entries) = fs::read_dir(&inbox) else {
        return vec![];
    };
    let mut out = vec![];
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let path = e.path();
        if name.starts_with('.') {
            prune(&path);
            continue;
        }
        if !path.is_dir() {
            continue;
        }
        let result = receive(root, &path);
        match &result {
            Ok(arrival) => {
                let _ = library::write_json(&inbox.join(format!(".done-{name}.json")), arrival);
                let _ = fs::remove_dir_all(&path);
            }
            Err(err) => {
                let failed = inbox.join(format!(".failed-{name}"));
                let _ = fs::remove_dir_all(&failed);
                if fs::rename(&path, &failed).is_ok() {
                    let _ = fs::write(failed.join("error.txt"), err);
                }
            }
        }
        out.push(result);
    }
    out
}

/// Receipts, refused folders and abandoned `.tmp-` staging dirs are cleared after a day.
fn prune(path: &Path) {
    prune_older_than(path, Duration::from_secs(24 * 3600));
}

fn prune_older_than(path: &Path, max_age: Duration) {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    if !(name.starts_with(".decision-")
        || name.starts_with(".done-")
        || name.starts_with(".failed-")
        || name.starts_with(".tmp-"))
    {
        return;
    }
    let old = fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| SystemTime::now().duration_since(t).ok())
        .is_some_and(|age| age >= max_age);
    if old {
        let _ = if path.is_dir() {
            fs::remove_dir_all(path)
        } else {
            fs::remove_file(path)
        };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn copy_dir(from: &Path, to: &Path) {
        fs::create_dir_all(to).unwrap();
        for e in fs::read_dir(from).unwrap().flatten() {
            if e.path().is_file() {
                fs::copy(e.path(), to.join(e.file_name())).unwrap();
            }
        }
    }
    #[test]
    fn pet_packages_arrive_with_a_receipt() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let mika = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/mika");
        copy_dir(&mika, &root.join("inbox/mika-1"));
        let arrived = scan(root);
        assert!(matches!(
            &arrived[0],
            Ok(Arrival::Pet { updated: false, .. })
        ));
        assert!(!root.join("inbox/mika-1").exists());
        let receipt = fs::read_to_string(root.join("inbox/.done-mika-1.json")).unwrap();
        assert!(receipt.contains("\"kind\": \"pet\""), "{receipt}");
        assert_eq!(library::list(root).unwrap().len(), 1);
        // The same pet delivered again updates it instead of duplicating.
        copy_dir(&mika, &root.join("inbox/mika-2"));
        assert!(matches!(
            &scan(root)[0],
            Ok(Arrival::Pet { updated: true, .. })
        ));
        assert_eq!(library::list(root).unwrap().len(), 1);
    }
    #[test]
    fn refused_packages_explain_themselves() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        fs::create_dir_all(root.join("inbox/broken")).unwrap();
        fs::write(root.join("inbox/broken/teaching.json"), "{}").unwrap();
        fs::create_dir_all(root.join("inbox/mystery")).unwrap();
        fs::create_dir_all(root.join("inbox/.tmp-unfinished")).unwrap();
        let results = scan(root);
        assert_eq!(results.len(), 2, "unfinished folders are left alone");
        assert!(results.iter().all(Result::is_err));
        assert!(root.join("inbox/.failed-broken/error.txt").exists());
        let why = fs::read_to_string(root.join("inbox/.failed-mystery/error.txt")).unwrap();
        assert!(why.contains("pet.json"));
        assert!(root.join("inbox/.tmp-unfinished").exists());
        prune_older_than(&root.join("inbox/.tmp-unfinished"), Duration::ZERO);
        assert!(!root.join("inbox/.tmp-unfinished").exists());
    }

    fn make_atlas_png(version: u8, r: u8) -> Vec<u8> {
        let h = if version == 2 { 2288 } else { 1872 };
        let mut img = image::RgbaImage::new(1536, h);
        let frames = [6u32, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8];
        for row in 0..(h / 208) {
            for col in 0..frames[row as usize] {
                img.put_pixel(col * 192 + 12, row * 208 + 12, image::Rgba([r, 120, 200, 255]));
            }
        }
        if version == 2 {
            // V2 neutral pose (row 0, col 6)
            img.put_pixel(6 * 192 + 12, 12, image::Rgba([r, 120, 200, 255]));
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    fn make_strip_png(frames: u32) -> Vec<u8> {
        let mut img = image::RgbaImage::new(192 * frames, 208);
        for f in 0..frames {
            img.put_pixel(f * 192 + 6, 6, image::Rgba([180, 90, 220, 255]));
        }
        let mut buf = std::io::Cursor::new(Vec::new());
        img.write_to(&mut buf, image::ImageFormat::Png).unwrap();
        buf.into_inner()
    }

    #[test]
    fn incremental_outfit_delivery_preserves_lizi_assets_updates_in_place_and_exports_cleanly() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples");

        // Install lizi with its own sleepStrip + custom/ + teaching.json
        let pkg = tempfile::tempdir().unwrap();
        let lizi_sheet = fs::read(examples.join("lizi/spritesheet.webp")).unwrap();
        let sleep_bytes = fs::read(examples.join("lizi-sleep/actions/sleep.png")).unwrap();
        fs::write(pkg.path().join("spritesheet.webp"), &lizi_sheet).unwrap();
        fs::write(pkg.path().join("sleep.png"), &sleep_bytes).unwrap();
        fs::write(
            pkg.path().join("pet.json"),
            r#"{"id":"lizi","displayName":"栗子","description":"一只温暖的原创橘白小猫，安静陪伴，也会好奇地四处走走。","spriteVersionNumber":2,"spritesheetPath":"spritesheet.webp","sleepStrip":"sleep.png"}"#,
        )
        .unwrap();
        let base_pet = library::import(root, pkg.path()).unwrap().pet;
        let lizi_dir = root.join("pets/lizi");
        let base_sheet_path = lizi_dir.join(&base_pet.spritesheet_path);
        let base_sleep_path = lizi_dir.join(base_pet.sleep_strip.as_deref().unwrap());
        fs::create_dir_all(lizi_dir.join("custom")).unwrap();
        fs::write(lizi_dir.join("custom/action-library.json"), b"{\"saved\":1}").unwrap();
        fs::write(lizi_dir.join("teaching.json"), b"{\"rules\":[]}").unwrap();

        // 1. Deliver first outfit (pajamas) via inbox
        let d1 = root.join("inbox/lizi-pajamas-1");
        fs::create_dir_all(d1.join("outfits")).unwrap();
        let pajamas_v1 = make_atlas_png(2, 40);
        fs::write(d1.join("outfits/pajamas.png"), &pajamas_v1).unwrap();
        fs::write(
            d1.join("outfit.json"),
            r#"{
                "petId": "lizi",
                "outfit": {
                    "id": "pajamas",
                    "displayName": "睡衣",
                    "spritesheetPath": "outfits/pajamas.png"
                },
                "scheduleRule": {
                    "outfit": "pajamas",
                    "when": { "time": { "from": "22:00", "to": "07:00" } }
                }
            }"#,
        )
        .unwrap();

        let arrived = scan(root);
        assert!(matches!(
            &arrived[0],
            Ok(Arrival::Outfit {
                pet_id,
                outfit_id,
                display_name,
                updated: false
            }) if pet_id == "lizi" && outfit_id == "pajamas" && display_name == "睡衣"
        ));
        let receipt: serde_json::Value =
            serde_json::from_slice(&fs::read(root.join("inbox/.done-lizi-pajamas-1.json")).unwrap())
                .unwrap();
        assert_eq!(receipt["kind"], "outfit");
        assert_eq!(receipt["petId"], "lizi");
        assert_eq!(receipt["outfitId"], "pajamas");
        assert_eq!(receipt["displayName"], "睡衣");
        assert_eq!(receipt["updated"], false);

        // Zero-destruction check on lizi's base assets & custom layer
        assert_eq!(fs::read(&base_sheet_path).unwrap(), lizi_sheet);
        assert_eq!(fs::read(&base_sleep_path).unwrap(), sleep_bytes);
        assert_eq!(
            fs::read_to_string(lizi_dir.join("custom/action-library.json")).unwrap(),
            "{\"saved\":1}"
        );
        assert_eq!(
            fs::read_to_string(lizi_dir.join("teaching.json")).unwrap(),
            "{\"rules\":[]}"
        );
        let sheet_resolved = library::outfit_sheet_path(root, "lizi", "pajamas").unwrap();
        assert_eq!(fs::read(sheet_resolved).unwrap(), pajamas_v1);
        assert!(library::outfit_thumbnail(root, "lizi", "pajamas").unwrap().is_file());

        // 2. Update existing outfit (pajamas) -> updated: true, rule updated in place (no duplicate!)
        let d2 = root.join("inbox/lizi-pajamas-2");
        fs::create_dir_all(d2.join("outfits")).unwrap();
        let pajamas_v2 = make_atlas_png(2, 90);
        fs::write(d2.join("outfits/pajamas.png"), &pajamas_v2).unwrap();
        fs::write(
            d2.join("outfit.json"),
            r#"{
                "petId": "lizi",
                "outfit": {
                    "id": "pajamas",
                    "displayName": "星空睡衣",
                    "spritesheetPath": "outfits/pajamas.png"
                },
                "scheduleRule": {
                    "outfit": "pajamas",
                    "when": { "time": { "from": "21:30", "to": "07:30" } }
                }
            }"#,
        )
        .unwrap();
        let arrived2 = scan(root);
        assert!(matches!(
            &arrived2[0],
            Ok(Arrival::Outfit {
                outfit_id,
                display_name,
                updated: true,
                ..
            }) if outfit_id == "pajamas" && display_name == "星空睡衣"
        ));
        let p = library::pet(root, "lizi").unwrap();
        let w = p.wardrobe.as_ref().unwrap();
        assert_eq!(w.outfits.len(), 1);
        assert_eq!(w.outfits[0].display_name, "星空睡衣");
        assert_eq!(w.schedule.len(), 1);
        assert_eq!(w.schedule[0].when.time.as_ref().unwrap().from, "21:30");

        // 3. Add a second outfit (weekend) + outfit-specific activity -> preserves pajamas
        let d3 = root.join("inbox/lizi-weekend-1");
        fs::create_dir_all(d3.join("outfits")).unwrap();
        fs::create_dir_all(d3.join("activities")).unwrap();
        fs::write(d3.join("outfits/weekend.png"), make_atlas_png(2, 160)).unwrap();
        fs::write(d3.join("activities/coffee.png"), make_strip_png(6)).unwrap();
        fs::write(
            d3.join("outfit.json"),
            r#"{
                "petId": "lizi",
                "outfit": {
                    "id": "weekend",
                    "displayName": "周末卫衣",
                    "spritesheetPath": "outfits/weekend.png"
                },
                "scheduleRule": {
                    "outfit": "weekend",
                    "when": { "days": ["sat", "sun"] }
                },
                "activities": [
                    {
                        "id": "coffee",
                        "displayName": "喝咖啡",
                        "outfitId": "weekend",
                        "spritesheetPath": "activities/coffee.png",
                        "frameCount": 6,
                        "fps": 4
                    }
                ]
            }"#,
        )
        .unwrap();
        let arrived3 = scan(root);
        assert!(matches!(&arrived3[0], Ok(Arrival::Outfit { updated: false, .. })));
        let p = library::pet(root, "lizi").unwrap();
        assert_eq!(p.wardrobe.as_ref().unwrap().outfits.len(), 2);
        assert_eq!(p.wardrobe.as_ref().unwrap().schedule.len(), 2);
        assert_eq!(p.activities.as_ref().unwrap().len(), 1);
        assert!(library::pet_asset_path(root, "lizi", "activities/coffee.png").is_ok());

        // 4. Full-package export preserves sleepStrip + outfits/ + activities/ on re-import
        let out_zip = tempfile::tempdir().unwrap().path().join("lizi-full.zip");
        library::export(root, "lizi", &out_zip).unwrap();
        let fresh = tempfile::tempdir().unwrap();
        let reimported = library::import(fresh.path(), &out_zip).unwrap().pet;
        assert!(reimported.sleep_strip.is_some());
        assert_eq!(reimported.wardrobe.as_ref().unwrap().outfits.len(), 2);
        assert_eq!(reimported.activities.as_ref().unwrap().len(), 1);
    }

    #[test]
    fn incremental_outfit_rejects_bad_pet_wrong_dimensions_and_traversal() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let lizi = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples/lizi");
        library::import(root, &lizi).unwrap();

        // Unknown petId
        let bad_pet = root.join("inbox/bad-pet");
        fs::create_dir_all(bad_pet.join("outfits")).unwrap();
        fs::write(bad_pet.join("outfits/pajamas.png"), make_atlas_png(2, 10)).unwrap();
        fs::write(
            bad_pet.join("outfit.json"),
            r#"{"petId":"no-such-pet","outfit":{"id":"pajamas","displayName":"睡衣","spritesheetPath":"outfits/pajamas.png"}}"#,
        )
        .unwrap();

        // Wrong dimensions (V1 1536x1872 delivered to V2 lizi)
        let bad_dim = root.join("inbox/bad-dim");
        fs::create_dir_all(bad_dim.join("outfits")).unwrap();
        fs::write(bad_dim.join("outfits/pajamas.png"), make_atlas_png(1, 10)).unwrap();
        fs::write(
            bad_dim.join("outfit.json"),
            r#"{"petId":"lizi","outfit":{"id":"pajamas","displayName":"睡衣","spritesheetPath":"outfits/pajamas.png"}}"#,
        )
        .unwrap();

        // Path traversal in spritesheetPath
        let bad_path = root.join("inbox/bad-path");
        fs::create_dir_all(&bad_path).unwrap();
        fs::write(
            bad_path.join("outfit.json"),
            r#"{"petId":"lizi","outfit":{"id":"pajamas","displayName":"睡衣","spritesheetPath":"../escape.png"}}"#,
        )
        .unwrap();

        let results = scan(root);
        assert_eq!(results.len(), 3);
        assert!(results.iter().all(Result::is_err));
        for name in ["bad-pet", "bad-dim", "bad-path"] {
            assert!(
                root.join(format!("inbox/.failed-{name}/error.txt")).is_file(),
                "{name}"
            );
        }
        // Lizi's existing built-in wardrobe remains untouched (no bad outfit added).
        let outfits = &library::pet(root, "lizi").unwrap().wardrobe.unwrap().outfits;
        assert_eq!(outfits.len(), 1);
        assert_eq!(outfits[0].id, library::LIZI_PAJAMAS_ID);
    }

    #[test]
    fn per_outfit_sleep_strip_full_delivery_sleep_only_patch_fallback_and_export_round_trip() {
        let root = tempfile::tempdir().unwrap();
        let root = root.path();
        let examples = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../examples");

        // Install lizi with its base sleepStrip
        let pkg = tempfile::tempdir().unwrap();
        let lizi_sheet = fs::read(examples.join("lizi/spritesheet.webp")).unwrap();
        let base_sleep = fs::read(examples.join("lizi-sleep/actions/sleep.png")).unwrap();
        fs::write(pkg.path().join("spritesheet.webp"), &lizi_sheet).unwrap();
        fs::write(pkg.path().join("sleep.png"), &base_sleep).unwrap();
        fs::write(
            pkg.path().join("pet.json"),
            r#"{"id":"lizi","displayName":"栗子","spriteVersionNumber":2,"spritesheetPath":"spritesheet.webp","sleepStrip":"sleep.png"}"#,
        )
        .unwrap();
        library::import(root, pkg.path()).unwrap();

        // (a) Full outfit.json with per-outfit sleepStrip (pajamas)
        let d_full = root.join("inbox/lizi-pajamas-sleep");
        fs::create_dir_all(d_full.join("outfits")).unwrap();
        let pajamas_atlas = make_atlas_png(2, 55);
        let pajamas_sleep = make_strip_png(16);
        fs::write(d_full.join("outfits/pajamas.png"), &pajamas_atlas).unwrap();
        fs::write(d_full.join("outfits/pajamas-sleep.png"), &pajamas_sleep).unwrap();
        fs::write(
            d_full.join("outfit.json"),
            r#"{
                "petId": "lizi",
                "outfit": {
                    "id": "pajamas",
                    "displayName": "睡衣",
                    "spritesheetPath": "outfits/pajamas.png",
                    "sleepStrip": "outfits/pajamas-sleep.png"
                }
            }"#,
        )
        .unwrap();
        let res = scan(root);
        assert!(matches!(&res[0], Ok(Arrival::Outfit { outfit_id, updated: false, .. }) if outfit_id == "pajamas"));

        // outfit_sleep_path resolves outfit sleepStrip for pajamas, base sleepStrip for None / default
        assert_eq!(
            fs::read(library::outfit_sleep_path(root, "lizi", Some("pajamas")).unwrap()).unwrap(),
            pajamas_sleep
        );
        assert_eq!(
            fs::read(library::outfit_sleep_path(root, "lizi", None).unwrap()).unwrap(),
            base_sleep
        );
        assert_eq!(
            fs::read(library::outfit_sleep_path(root, "lizi", Some("default")).unwrap()).unwrap(),
            base_sleep
        );
        assert!(library::pet_asset_path(root, "lizi", "outfits/pajamas-sleep.png").is_ok());

        // (c) OpenPets outfit WITHOUT sleepStrip (moon-pajamas) falls back seamlessly to base sleepStrip
        let d_open = root.join("inbox/lizi-moon");
        fs::create_dir_all(d_open.join("outfits")).unwrap();
        let moon_atlas = make_atlas_png(2, 125);
        fs::write(d_open.join("outfits/moon-pajamas.png"), &moon_atlas).unwrap();
        fs::write(
            d_open.join("outfit.json"),
            r#"{
                "petId": "lizi",
                "outfit": {
                    "id": "moon-pajamas",
                    "displayName": "月亮睡衣",
                    "spritesheetPath": "outfits/moon-pajamas.png"
                }
            }"#,
        )
        .unwrap();
        assert!(matches!(&scan(root)[0], Ok(Arrival::Outfit { updated: false, .. })));
        let p = library::pet(root, "lizi").unwrap();
        let moon = p.wardrobe.as_ref().unwrap().outfits.iter().find(|o| o.id == "moon-pajamas").unwrap();
        assert!(moon.sleep_strip.is_none());
        // No sleepStrip on moon-pajamas -> falls back to base sleepStrip
        assert_eq!(
            fs::read(library::outfit_sleep_path(root, "lizi", Some("moon-pajamas")).unwrap()).unwrap(),
            base_sleep
        );

        // (b) Sleep-only patch onto already-installed moon-pajamas (spritesheetPath & displayName omitted)
        let rev_before_patch = library::pet(root, "lizi").unwrap().revision;
        let d_patch = root.join("inbox/lizi-moon-sleep-patch");
        fs::create_dir_all(d_patch.join("outfits")).unwrap();
        let moon_sleep = make_strip_png(16);
        fs::write(d_patch.join("outfits/moon-pajamas-sleep.png"), &moon_sleep).unwrap();
        fs::write(
            d_patch.join("outfit.json"),
            r#"{
                "petId": "lizi",
                "outfit": {
                    "id": "moon-pajamas",
                    "sleepStrip": "outfits/moon-pajamas-sleep.png"
                }
            }"#,
        )
        .unwrap();
        let patched = scan(root);
        assert!(matches!(
            &patched[0],
            Ok(Arrival::Outfit { outfit_id, display_name, updated: true, .. })
                if outfit_id == "moon-pajamas" && display_name == "月亮睡衣"
        ));
        assert_ne!(library::pet(root, "lizi").unwrap().revision, rev_before_patch);
        // Existing atlas bytes & displayName stayed 100% untouched, while sleepStrip now resolves to moon_sleep
        assert_eq!(
            fs::read(library::outfit_sheet_path(root, "lizi", "moon-pajamas").unwrap()).unwrap(),
            moon_atlas
        );
        assert_eq!(
            fs::read(library::outfit_sleep_path(root, "lizi", Some("moon-pajamas")).unwrap()).unwrap(),
            moon_sleep
        );

        // Reject invalid sleepStrip filename & wrong frame count (8 frames instead of 16)
        let d_bad_name = root.join("inbox/bad-sleep-name");
        fs::create_dir_all(d_bad_name.join("outfits")).unwrap();
        fs::write(d_bad_name.join("outfits/other.png"), &moon_sleep).unwrap();
        fs::write(
            d_bad_name.join("outfit.json"),
            r#"{"petId":"lizi","outfit":{"id":"moon-pajamas","sleepStrip":"outfits/other.png"}}"#,
        )
        .unwrap();
        let d_bad_frames = root.join("inbox/bad-sleep-frames");
        fs::create_dir_all(d_bad_frames.join("outfits")).unwrap();
        fs::write(d_bad_frames.join("outfits/moon-pajamas-sleep.png"), make_strip_png(8)).unwrap();
        fs::write(
            d_bad_frames.join("outfit.json"),
            r#"{"petId":"lizi","outfit":{"id":"moon-pajamas","sleepStrip":"outfits/moon-pajamas-sleep.png"}}"#,
        )
        .unwrap();
        let bad_res = scan(root);
        assert_eq!(bad_res.len(), 2);
        assert!(bad_res.iter().all(Result::is_err));

        // (d) Full export -> re-import round-trip preserves per-outfit sleepStrip
        let out_dir = tempfile::tempdir().unwrap();
        let zip_path = out_dir.path().join("lizi-with-outfit-sleep.zip");
        library::export(root, "lizi", &zip_path).unwrap();
        let fresh = tempfile::tempdir().unwrap();
        let reimported = library::import(fresh.path(), &zip_path).unwrap().pet;
        let outfits = &reimported.wardrobe.as_ref().unwrap().outfits;
        assert_eq!(outfits.len(), 2);
        assert_eq!(
            fs::read(library::outfit_sleep_path(fresh.path(), "lizi", Some("pajamas")).unwrap()).unwrap(),
            pajamas_sleep
        );
        assert_eq!(
            fs::read(library::outfit_sleep_path(fresh.path(), "lizi", Some("moon-pajamas")).unwrap()).unwrap(),
            moon_sleep
        );
        assert_eq!(
            fs::read(library::outfit_sleep_path(fresh.path(), "lizi", None).unwrap()).unwrap(),
            base_sleep
        );
    }
}
