//! One-time import of existing pictures and pending candidates. Old files stay intact.
use super::*;

pub(super) fn load(root: &Path, pet: &str) -> Result<Collection, String> {
    let p = library::pet(root, pet)?;
    if path(root, pet).exists() {
        return read_json(&path(root, pet));
    }
    let h = legacy_history(root, pet)?;
    let layer = if h.current == 0 {
        Layer::default()
    } else {
        read_json(&custom_dir(root, pet).join(format!("versions/{}.json", h.current)))?
    };
    let mut c = Collection {
        revision: h.current,
        layer,
        items: vec![],
    };
    // Save every shipped base action too; these never rewrite the base atlas.
    let runtime: serde_json::Value = serde_json::from_str(include_str!(
        "../../../../skills/make-desktop-pet/references/runtime-contract.json"
    ))
    .unwrap();
    library::relative(&p.spritesheet_path)?;
    let atlas = image::open(root.join("pets").join(pet).join(&p.spritesheet_path))
        .map_err(|e| e.to_string())?;
    for name in ACTIONS {
        let spec = &runtime["animations"][name];
        let durations: Vec<u32> = spec["durations"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_u64().unwrap() as u32)
            .collect();
        let strip = atlas.crop_imm(
            0,
            spec["row"].as_u64().unwrap() as u32 * 208,
            192 * durations.len() as u32,
            208,
        );
        let mut bytes = std::io::Cursor::new(Vec::new());
        strip
            .write_to(&mut bytes, image::ImageFormat::Png)
            .map_err(|e| e.to_string())?;
        let a = CustomAction {
            label: spec["label"].as_str().unwrap().into(),
            image: String::new(),
            durations,
            loop_frames: None,
        };
        remember_bytes(
            root,
            pet,
            &mut c,
            name,
            &a,
            bytes.get_ref(),
            "",
            true,
            0,
            true,
        )?;
    }
    if p.sleep_strip.is_some() || p.id == "lizi" {
        let template: serde_json::Value = serde_json::from_str(include_str!(
            "../../../../examples/lizi-sleep/teaching.json"
        ))
        .unwrap();
        let mut a: CustomAction =
            serde_json::from_value(template["actions"]["sleep"].clone()).unwrap();
        let bytes = if let Some(file) = &p.sleep_strip {
            library::relative(file)?;
            library::bounded(
                &root.join("pets").join(pet).join(file),
                limits().max_image_bytes,
            )?
        } else {
            include_bytes!("../../../../examples/lizi-sleep/actions/sleep.png").to_vec()
        };
        a.image = String::new();
        remember_bytes(root, pet, &mut c, "sleep", &a, &bytes, "", true, 0, true)?;
    }
    let mut versions: BTreeMap<u32, (String, u64)> = h
        .versions
        .iter()
        .map(|v| (v.version, (v.summary.clone(), v.accepted_at)))
        .collect();
    for file in fs::read_dir(custom_dir(root, pet).join("versions"))
        .into_iter()
        .flatten()
        .flatten()
    {
        let p = file.path();
        if p.extension().and_then(|v| v.to_str()) == Some("json") {
            if let Some(n) = p
                .file_stem()
                .and_then(|v| v.to_str())
                .and_then(|v| v.parse::<u32>().ok())
            {
                versions.entry(n).or_insert((String::new(), 0));
            }
        }
    }
    for (n, (summary, at)) in versions {
        let old: Layer = read_json(&custom_dir(root, pet).join(format!("versions/{n}.json")))?;
        for (name, a) in &old.actions {
            remember(
                root,
                pet,
                &mut c,
                name,
                a,
                &custom_dir(root, pet),
                &summary,
                true,
                at,
                false,
            )?;
        }
    }
    for e in fs::read_dir(root.join("drafts"))
        .into_iter()
        .flatten()
        .flatten()
    {
        let id = e.file_name().to_string_lossy().to_string();
        if id.starts_with('.') {
            continue;
        }
        if let Ok((t, _)) = load_draft(root, &id) {
            if t.pet_id == pet {
                collect_draft(root, &mut c, &id)?;
            }
        }
    }
    for (name, a) in c.layer.actions.clone() {
        remember(
            root,
            pet,
            &mut c,
            &name,
            &a,
            &custom_dir(root, pet),
            "",
            true,
            now(),
            false,
        )?;
    }
    // Canonicalize currently selected image paths to the same saved records.
    for (name, a) in c.layer.actions.clone() {
        let bytes = library::bounded(
            &custom_dir(root, pet).join(&a.image),
            limits().max_image_bytes,
        )?;
        let ext = validate_strip(&bytes, a.durations.len())?;
        let mut canonical = a;
        canonical.image = format!(
            "assets/{}.{ext}",
            &format!("{:x}", Sha256::digest(&bytes))[..16]
        );
        c.layer.actions.insert(name, canonical);
    }
    write(root, pet, &c)?;
    Ok(c)
}
