import importlib.util
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
MAKE_SKILL = ROOT / "skills/make-desktop-pet"
DRESS_SKILL = ROOT / "skills/dress-desktop-pet"
EXPORT_PET = MAKE_SKILL / "scripts/export_pet.py"
DRESS = DRESS_SKILL / "scripts/dress.py"
LIZI = ROOT / "examples/lizi"
LIZI_SLEEP = ROOT / "examples/lizi-sleep/actions/sleep.png"


def _load_dress_module():
    spec = importlib.util.spec_from_file_location("dress_mod", DRESS)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def _make_synthetic_atlas(path, *, v2=True, color="#B77C55", neutral_cell=False):
    h = 2288 if v2 else 1872
    rows = [6, 8, 8, 4, 5, 8, 6, 6, 6] + ([8, 8] if v2 else [])
    im = Image.new("RGBA", (1536, h), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    for row, count in enumerate(rows):
        for col in range(count):
            lift = 20 if row == 4 and col == 2 else 0
            draw.rectangle(
                (col * 192 + 75, row * 208 + 80 - lift, col * 192 + 115, row * 208 + 150 - lift),
                fill=color,
            )
            draw.rectangle(
                (col * 192 + 80 + col * 2, row * 208 + 110 - lift, col * 192 + 84 + col * 2, row * 208 + 140 - lift),
                fill="#E1C5A4",
            )
    if v2 and neutral_cell:
        im.paste(im.crop((0, 0, 192, 208)), (6 * 192, 0))
    im.save(path)


def _make_activity_strip(path, frames, color="#4A90E2"):
    im = Image.new("RGBA", (192 * frames, 208), (0, 0, 0, 0))
    draw = ImageDraw.Draw(im)
    for i in range(frames):
        draw.rectangle((i * 192 + 70, 70, i * 192 + 122, 160), fill=color)
    im.save(path)


def _make_generated_row_on_chroma(ref_strip_path, out_path, chroma_rgb, tint=(180, 140, 210), scale=2):
    """Build a synthetic generated strip from a real reference row on a flat chroma key."""
    with Image.open(ref_strip_path) as ref:
        rgba = ref.convert("RGBA")
        pixels = []
        for r, g, b, a in rgba.getdata():
            if a > 16:
                nr = min(255, int(r * 0.65 + tint[0] * 0.35))
                ng = min(255, int(g * 0.65 + tint[1] * 0.35))
                nb = min(255, int(b * 0.65 + tint[2] * 0.35))
                pixels.append((nr, ng, nb, a))
            else:
                pixels.append((0, 0, 0, 0))
        tinted = Image.new("RGBA", rgba.size)
        tinted.putdata(pixels)
        big = tinted.resize((rgba.width * scale, rgba.height * scale), Image.Resampling.LANCZOS)
        canvas = Image.new("RGBA", big.size, tuple(chroma_rgb) + (255,))
        canvas.alpha_composite(big)
        canvas.convert("RGB").save(out_path)


class BorderFloodFillMattingTests(unittest.TestCase):
    def test_border_flood_fill_protects_interior_key_pixels_and_white_whiskers(self):
        dress = _load_dress_module()
        # Draw a dark-fur head with protruding fine anti-aliased white whiskers
        # AND an intentional pure #FF00FF button dot right inside the torso.
        img = Image.new("RGB", (96, 96), (255, 0, 255))
        draw = ImageDraw.Draw(img)
        # Solid dark torso/head
        draw.rectangle((24, 24, 72, 76), fill=(36, 30, 28))
        # Intentional interior #FF00FF button dot (must NOT get punched into a hole!)
        draw.ellipse((42, 46, 54, 58), fill=(255, 0, 255))
        # Fine protruding white whiskers extending right into #FF00FF background:
        # opaque white core + semi-transparent white tip blended over #FF00FF
        px = img.load()
        for x in range(73, 83):
            px[x, 40] = (255, 255, 255)  # opaque white whisker
        px[83, 40] = (255, 160, 255)  # 63% white whisker tip blended over #FF00FF

        matted, mode = dress.remove_background(img, (255, 0, 255))
        self.assertEqual(mode, "chroma")
        out_px = matted.load()

        # 1. Exterior background completely transparent
        self.assertEqual(out_px[2, 2], (0, 0, 0, 0))
        self.assertEqual(out_px[90, 90], (0, 0, 0, 0))
        # 2. Interior #FF00FF button stays 100% opaque and exact color (ZERO holes!)
        self.assertEqual(out_px[48, 52], (255, 0, 255, 255))
        # 3. Opaque white whisker stays pure bright white & opaque (ZERO darkening/erosion!)
        for x in range(73, 83):
            self.assertEqual(out_px[x, 40], (255, 255, 255, 255))
        # 4. Anti-aliased white whisker tip unmixes back to clean white without magenta cast!
        r, g, b, a = out_px[83, 40]
        self.assertGreaterEqual(a, 140)
        self.assertGreaterEqual(r, 235)
        self.assertGreaterEqual(g, 235)
        self.assertGreaterEqual(b, 235)

    def test_real_lizi_on_magenta_matting_preserves_whiskers_and_interior_button(self):
        dress = _load_dress_module()
        with Image.open(LIZI / "spritesheet.webp") as sheet:
            lizi_cell = sheet.convert("RGBA").crop((0, 0, 192, 208))

        # Composite real Lizi onto flat #FF00FF and add an interior #FF00FF button on torso.
        bg = Image.new("RGBA", lizi_cell.size, (255, 0, 255, 255))
        bg.alpha_composite(lizi_cell)
        rgb = bg.convert("RGB")
        # Find a guaranteed opaque interior pixel near the torso center.
        alpha = lizi_cell.getchannel("A")
        bbox = alpha.point(lambda v: 255 if v > 200 else 0).getbbox()
        cx = (bbox[0] + bbox[2]) // 2
        cy = (bbox[1] + bbox[3]) // 2
        draw = ImageDraw.Draw(rgb)
        draw.ellipse((cx - 3, cy - 3, cx + 3, cy + 3), fill=(255, 0, 255))

        matted, mode = dress.remove_background(rgb, (255, 0, 255))
        self.assertEqual(mode, "chroma")
        m_px = matted.load()
        orig_px = lizi_cell.load()

        # Exterior corners removed cleanly
        self.assertEqual(m_px[2, 2][3], 0)
        self.assertEqual(m_px[189, 2][3], 0)
        # Interior magenta button is 100% opaque (0 holes!)
        self.assertEqual(m_px[cx, cy], (255, 0, 255, 255))

        # Check all bright cream/white pixels (whiskers / white fur / paws) on original Lizi:
        # none should be darkened, eroded, or shifted into opposite-hue green artifacts!
        bright_total = 0
        bright_preserved = 0
        green_artifacts = 0
        for y in range(208):
            for x in range(192):
                if abs(x - cx) <= 4 and abs(y - cy) <= 4:
                    continue
                r, g, b, a = orig_px[x, y]
                mr, mg, mb, ma = m_px[x, y]
                if ma > 32 and (mg - max(mr, mb)) > 25 and (g - max(r, b)) <= 10:
                    green_artifacts += 1
                if a >= 200 and min(r, g, b) >= 180:
                    bright_total += 1
                    if ma >= 200 and min(mr, mg, mb) >= 170:
                        bright_preserved += 1
        self.assertEqual(green_artifacts, 0)
        self.assertGreater(bright_total, 50)
        self.assertGreaterEqual(bright_preserved / float(bright_total), 0.99)


class ExportPetOpenPetsTests(unittest.TestCase):
    def test_export_with_wardrobe_activities_and_gaze_anchor_and_deliver(self):
        with tempfile.TemporaryDirectory() as d:
            tmp = Path(d)
            data_dir = tmp / "suiby-data"
            atlas = tmp / "atlas.png"
            _make_synthetic_atlas(atlas, v2=True)

            # Create review via review-template CLI
            review_path = tmp / "review.json"
            subprocess.run(
                [sys.executable, str(EXPORT_PET), "review-template", "--atlas", str(atlas), "--output", str(review_path)],
                check=True,
                capture_output=True,
            )
            review = json.loads(review_path.read_text())
            review["reviewedBy"] = "unit-test"
            ok = {"pass": True, "note": "Synthetic fixture check passed."}
            review["identity"] = ok
            review["transitions"] = ok
            review["motions"] = {k: ok for k in review["motions"]}
            review["directions"] = {k: ok for k in review["directions"]}
            review_path.write_text(json.dumps(review))

            # Prepare wardrobe + outfits (including per-outfit sleepStrip)
            outfits_dir = tmp / "src-outfits"
            outfits_dir.mkdir()
            _make_synthetic_atlas(outfits_dir / "pajamas.webp", v2=True, color="#7A68C8", neutral_cell=True)
            shutil.copy(LIZI_SLEEP, outfits_dir / "pajamas-sleep.png")
            wardrobe_path = tmp / "wardrobe.json"
            wardrobe_path.write_text(
                json.dumps(
                    {
                        "outfits": [
                            {
                                "id": "pajamas",
                                "displayName": "睡衣",
                                "spritesheetPath": "outfits/pajamas.webp",
                                "sleepStrip": "outfits/pajamas-sleep.png",
                            }
                        ],
                        "schedule": [
                            {
                                "outfit": "pajamas",
                                "when": {"time": {"from": "22:00", "to": "07:00"}},
                            }
                        ],
                    },
                    ensure_ascii=False,
                )
            )

            # Prepare activities + outfit variant
            acts_dir = tmp / "src-activities"
            acts_dir.mkdir()
            _make_activity_strip(acts_dir / "coffee.webp", 8, color="#8B5A2B")
            _make_activity_strip(acts_dir / "coffee.pajamas.webp", 8, color="#7A68C8")
            activities_path = tmp / "activities.json"
            activities_path.write_text(
                json.dumps(
                    [
                        {
                            "id": "coffee",
                            "displayName": "喝咖啡",
                            "outfitId": "default",
                            "spritesheetPath": "activities/coffee.webp",
                            "frameCount": 8,
                            "fps": 4,
                            "outfitVariants": [
                                {
                                    "outfitId": "pajamas",
                                    "spritesheetPath": "activities/coffee.pajamas.webp",
                                    "frameCount": 8,
                                    "fps": 4,
                                }
                            ],
                        }
                    ],
                    ensure_ascii=False,
                )
            )

            pkg_out = tmp / "exported-pet"
            env = {**os.environ, "PET_STUDIO_DATA": str(data_dir)}
            proc = subprocess.run(
                [
                    sys.executable,
                    str(EXPORT_PET),
                    "export",
                    "--atlas",
                    str(atlas),
                    "--review",
                    str(review_path),
                    "--sleep-strip",
                    str(LIZI_SLEEP),
                    "--id",
                    "dressed-pet",
                    "--name",
                    "测试猫",
                    "--revision",
                    "1",
                    "--chroma-key",
                    "#00FF00",
                    "--wardrobe",
                    str(wardrobe_path),
                    "--outfits-dir",
                    str(outfits_dir),
                    "--activities",
                    str(activities_path),
                    "--activities-dir",
                    str(acts_dir),
                    "--gaze-anchor",
                    "0.5,0.42",
                    "--output",
                    str(pkg_out),
                ],
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )
            res = json.loads(proc.stdout)
            pet_json = json.loads((pkg_out / "pet.json").read_text())
            self.assertEqual(pet_json["sleepStrip"], "sleep.png")
            self.assertEqual(pet_json["gazeAnchor"], {"x": 0.5, "y": 0.42})
            self.assertEqual(len(pet_json["wardrobe"]["outfits"]), 1)
            self.assertEqual(pet_json["wardrobe"]["outfits"][0]["sleepStrip"], "outfits/pajamas-sleep.png")
            self.assertEqual(len(pet_json["activities"]), 1)

            with zipfile.ZipFile(res["zip"]) as z:
                self.assertEqual(
                    set(z.namelist()),
                    {
                        "pet.json",
                        "spritesheet.png",
                        "sleep.png",
                        "outfits/pajamas.webp",
                        "outfits/pajamas-sleep.png",
                        "activities/coffee.webp",
                        "activities/coffee.pajamas.webp",
                    },
                )

            # Deliver staged folder and confirm outfits/ (with sleepStrip) and activities/ arrive in inbox
            deliver_proc = subprocess.run(
                [sys.executable, str(EXPORT_PET), "deliver", "--package", str(pkg_out), "--wait", "0.4"],
                env=env,
                check=True,
                capture_output=True,
                text=True,
            )
            d_info = json.loads(deliver_proc.stdout)
            self.assertEqual(d_info["status"], "queued")
            queued = [p for p in (data_dir / "inbox").iterdir() if not p.name.startswith(".")]
            self.assertEqual(len(queued), 1)
            self.assertTrue((queued[0] / "outfits/pajamas.webp").is_file())
            self.assertTrue((queued[0] / "outfits/pajamas-sleep.png").is_file())
            self.assertTrue((queued[0] / "activities/coffee.webp").is_file())
            self.assertTrue((queued[0] / "activities/coffee.pajamas.webp").is_file())
            self.assertTrue((queued[0] / "sleep.png").is_file())


class DressDesktopPetTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = self.tmp / "data"
        pet = self.data / "pets/lizi"
        pet.mkdir(parents=True)
        shutil.copy(LIZI / "spritesheet.webp", pet / "spritesheet.webp")
        shutil.copy(LIZI / "pet.json", pet / "pet.json")
        self.env = {**os.environ, "PET_STUDIO_DATA": str(self.data)}

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_dress(self, *args, ok=True):
        proc = subprocess.run(
            [sys.executable, str(DRESS), *args],
            env=self.env,
            capture_output=True,
            text=True,
        )
        if ok:
            self.assertEqual(proc.returncode, 0, proc.stderr + proc.stdout)
        else:
            self.assertNotEqual(proc.returncode, 0, proc.stdout)
        return proc.stdout if ok else proc.stdout + proc.stderr

    def test_skill_doc_hygiene_and_links(self):
        text = (DRESS_SKILL / "SKILL.md").read_text(encoding="utf-8")
        self.assertLess(len(text.encode("utf-8")), 9000)
        self.assertIn("## 先确认用对了 Skill", text)
        self.assertIn("## 决定留给用户", text)
        self.assertIn("## 省着用上下文", text)
        self.assertIn("computer use", text)
        for md in [DRESS_SKILL / "SKILL.md", *DRESS_SKILL.glob("references/*.md")]:
            content = md.read_text(encoding="utf-8")
            self.assertNotIn("完整读一遍", content)
            for link in re.findall(r"\]\(([^)#]+)\)", content):
                if "://" not in link:
                    self.assertTrue((md.parent / link).exists(), f"broken link in {md}: {link}")

    def test_chroma_color_avoidance(self):
        w1 = self.tmp / "work-green"
        out1 = json.loads(
            self.run_dress(
                "init",
                "--pet",
                "lizi",
                "--outfit",
                "forest-coat",
                "--label",
                "森林风衣",
                "--desc",
                "sage green corduroy raincoat with mint buttons",
                "--dir",
                str(w1),
            )
        )
        self.assertNotEqual(out1["chromaKey"], "#00FF00")

        w2 = self.tmp / "work-pink"
        out2 = json.loads(
            self.run_dress(
                "init",
                "--pet",
                "lizi",
                "--outfit",
                "sakura-hoodie",
                "--label",
                "樱花粉卫衣",
                "--desc",
                "soft pastel pink hoodie with lavender ribbons",
                "--dir",
                str(w2),
            )
        )
        self.assertNotEqual(out2["chromaKey"], "#FF00FF")

    def test_full_end_to_end_dress_workflow_on_real_lizi(self):
        # 1. pets listing
        pets_text = self.run_dress("pets")
        self.assertIn("栗子", pets_text)
        self.assertIn("V2", pets_text)

        # 2. init with pajamas preset on real examples/lizi
        work = self.tmp / "dress-lizi-pajamas"
        init_res = json.loads(
            self.run_dress(
                "init",
                "--pet",
                "lizi",
                "--outfit",
                "pajamas",
                "--label",
                "睡衣",
                "--desc",
                "cozy cream-and-lavender striped pajamas with a tiny sleep cap",
                "--preset",
                "pajamas",
                "--dir",
                str(work),
            )
        )
        self.assertEqual(init_res["layout"], "v2")
        self.assertEqual(init_res["ready"], ["base"])
        self.assertEqual(init_res["total"], 12)
        self.assertNotEqual(init_res["chromaKey"], "#FF00FF")
        self.assertTrue((work / "refs/base-idle-0.png").is_file())
        self.assertTrue((work / "refs/anchor.json").is_file())
        self.assertTrue((work / "refs/rows/gaze-1.png").is_file())
        self.assertTrue((work / "refs/rows/gaze-2.png").is_file())

        idle_prompt = (work / "jobs/idle.txt").read_text(encoding="utf-8")
        self.assertIn("approved/base.png", idle_prompt)
        self.assertIn("refs/rows/idle.png", idle_prompt)
        self.assertIn(init_res["chromaKey"], idle_prompt)

        state = json.loads((work / "outfit-state.json").read_text())
        chroma_rgb = state["chromaKey"]["rgb"]

        # 3. Gating: cannot accept a row before base is approved, and base requires --reviewer user
        gen_dir = self.tmp / "generated"
        gen_dir.mkdir()
        base_gen = gen_dir / "base.png"
        _make_generated_row_on_chroma(work / "refs/base-idle-0.png", base_gen, chroma_rgb)
        idle_gen = gen_dir / "idle.png"
        _make_generated_row_on_chroma(work / "refs/rows/idle.png", idle_gen, chroma_rgb)

        self.run_dress("accept", "--dir", str(work), "--job", "idle", "--image", str(idle_gen), ok=False)
        self.run_dress("accept", "--dir", str(work), "--job", "base", "--image", str(base_gen), "--reviewer", "agent", ok=False)

        acc_base = json.loads(
            self.run_dress(
                "accept",
                "--dir",
                str(work),
                "--job",
                "base",
                "--image",
                str(base_gen),
                "--reviewer",
                "user",
                "--note",
                "用户确认睡衣造型",
            )
        )
        self.assertTrue((work / "approved/base.png").is_file())
        self.assertTrue((work / "qa/base-preview.png").is_file())
        self.assertEqual(len(acc_base["status"]["ready"]), 3)

        # 4. Accept all 9 standard rows + 2 gaze rows
        row_jobs = [
            "idle",
            "running-right",
            "running-left",
            "waving",
            "jumping",
            "failed",
            "waiting",
            "running",
            "review",
            "gaze-1",
            "gaze-2",
        ]
        for job in row_jobs:
            gen_path = gen_dir / f"{job}.png"
            _make_generated_row_on_chroma(work / "refs/rows" / f"{job}.png", gen_path, chroma_rgb)
            res = json.loads(
                self.run_dress(
                    "accept",
                    "--dir",
                    str(work),
                    "--job",
                    job,
                    "--image",
                    str(gen_path),
                    "--reviewer",
                    "agent",
                    "--note",
                    f"{job} checked",
                )
            )
            self.assertTrue((work / "qa" / f"{job}-sheet.png").is_file())
            self.assertTrue((work / "qa" / f"{job}.gif").is_file())
            self.assertTrue((work / "registered" / f"{job}.png").is_file())
            self.assertIn("anchorMetrics", res)

        # Surgical single-row repair
        rep = json.loads(
            self.run_dress("repair", "--dir", str(work), "--job", "waving", "--reason", "sleeve color tweak")
        )
        self.assertEqual(rep["affected"], ["waving"])
        self.assertEqual(rep["status"]["remaining"], 1)
        self.assertEqual(rep["status"]["ready"], ["waving"])
        self.run_dress(
            "accept",
            "--dir",
            str(work),
            "--job",
            "waving",
            "--image",
            str(gen_dir / "waving.png"),
            "--reviewer",
            "agent",
            "--note",
            "re-accepted waving",
        )

        # 5. Compose & verify V2 WebP (1536x2288, (0,6) neutral cell populated, exact anchor lock)
        comp = json.loads(self.run_dress("compose", "--dir", str(work)))
        self.assertTrue(comp["ok"])
        self.assertEqual(comp["size"], [1536, 2288])
        self.assertTrue(comp["neutralCellPopulated"])
        self.assertTrue(comp["anchorCheck"]["ok"])
        self.assertTrue((work / "qa/compare-base-vs-outfit.png").is_file())

        out_webp = work / "outfits/pajamas.webp"
        self.assertTrue(out_webp.is_file())
        with Image.open(out_webp) as im:
            self.assertEqual(im.format, "WEBP")
            self.assertEqual(im.size, (1536, 2288))
            rgba = im.convert("RGBA")
            self.assertEqual(
                rgba.crop((0, 0, 192, 208)).tobytes(),
                rgba.crop((6 * 192, 0, 7 * 192, 208)).tobytes(),
            )
            self.assertIsNone(rgba.crop((7 * 192, 0, 8 * 192, 208)).getchannel("A").getbbox())

        # 6. Deliver stages valid outfit.json + outfits/pajamas.webp into inbox
        deliv = json.loads(self.run_dress("deliver", "--dir", str(work), "--wait", "0.4"))
        self.assertEqual(deliv["status"], "queued")
        staged_dirs = [p for p in (self.data / "inbox").iterdir() if not p.name.startswith(".")]
        self.assertEqual(len(staged_dirs), 1)
        staged = staged_dirs[0]
        self.assertTrue((staged / "outfit.json").is_file())
        self.assertTrue((staged / "outfits/pajamas.webp").is_file())
        self.assertFalse((staged / "pet.json").exists())

        manifest = json.loads((staged / "outfit.json").read_text(encoding="utf-8"))
        self.assertEqual(
            manifest,
            {
                "petId": "lizi",
                "outfit": {
                    "id": "pajamas",
                    "displayName": "睡衣",
                    "spritesheetPath": "outfits/pajamas.webp",
                },
                "scheduleRule": {
                    "outfit": "pajamas",
                    "when": {"time": {"from": "22:00", "to": "07:00"}},
                },
            },
        )

    def _install_lizi_with_sleep_and_moon_pajamas(self):
        pet_dir = self.data / "pets/lizi"
        shutil.copy(LIZI_SLEEP, pet_dir / "sleep.png")
        (pet_dir / "outfits").mkdir(exist_ok=True)
        shutil.copy(LIZI / "spritesheet.webp", pet_dir / "outfits/moon-pajamas.webp")
        pet_json = json.loads((pet_dir / "pet.json").read_text(encoding="utf-8"))
        pet_json["sleepStrip"] = "sleep.png"
        pet_json["wardrobe"] = {
            "outfits": [
                {
                    "id": "moon-pajamas",
                    "displayName": "月牙睡衣",
                    "spritesheetPath": "outfits/moon-pajamas.webp",
                }
            ],
            "schedule": [],
        }
        (pet_dir / "pet.json").write_text(json.dumps(pet_json, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    def test_full_outfit_with_sleep_strip_and_no_sleep_opt_out(self):
        self._install_lizi_with_sleep_and_moon_pajamas()

        # Verify --no-sleep opts out cleanly even on a sleeping pet
        opt_out_work = self.tmp / "dress-no-sleep"
        opt_out = json.loads(
            self.run_dress(
                "init",
                "--pet",
                "lizi",
                "--outfit",
                "hoodie",
                "--label",
                "卫衣",
                "--desc",
                "cozy navy hoodie",
                "--no-sleep",
                "--dir",
                str(opt_out_work),
            )
        )
        self.assertFalse(opt_out["includesSleep"])
        self.assertEqual(opt_out["total"], 12)
        self.assertNotIn("sleep", opt_out["pending"])

        # Full workflow WITH auto-detected sleepStrip
        work = self.tmp / "dress-lizi-pajamas-sleep"
        init_res = json.loads(
            self.run_dress(
                "init",
                "--pet",
                "lizi",
                "--outfit",
                "pajamas",
                "--label",
                "睡衣",
                "--desc",
                "soft cream-and-lavender striped pajamas",
                "--preset",
                "pajamas",
                "--dir",
                str(work),
            )
        )
        self.assertTrue(init_res["includesSleep"])
        self.assertEqual(init_res["total"], 13)  # base + 9 std + 2 gaze + sleep
        self.assertIn("sleep", init_res["pending"])
        self.assertTrue((work / "refs/rows/sleep.png").is_file())
        sleep_prompt = (work / "jobs/sleep.txt").read_text(encoding="utf-8")
        self.assertIn("Frames 1–4", sleep_prompt)
        self.assertIn("Frames 5–12", sleep_prompt)
        self.assertIn("Frames 13–16", sleep_prompt)
        self.assertIn("approved/base.png", sleep_prompt)
        self.assertIn("refs/rows/sleep.png", sleep_prompt)

        state = json.loads((work / "outfit-state.json").read_text())
        chroma_rgb = state["chromaKey"]["rgb"]
        gen_dir = self.tmp / "gen-sleep-full"
        gen_dir.mkdir()

        base_gen = gen_dir / "base.png"
        _make_generated_row_on_chroma(work / "refs/base-idle-0.png", base_gen, chroma_rgb)
        self.run_dress(
            "accept", "--dir", str(work), "--job", "base", "--image", str(base_gen), "--reviewer", "user", "--note", "ok"
        )

        for job in [
            "idle", "running-right", "running-left", "waving", "jumping",
            "failed", "waiting", "running", "review", "gaze-1", "gaze-2", "sleep",
        ]:
            gen_path = gen_dir / f"{job}.png"
            _make_generated_row_on_chroma(work / "refs/rows" / f"{job}.png", gen_path, chroma_rgb)
            self.run_dress(
                "accept", "--dir", str(work), "--job", job, "--image", str(gen_path), "--reviewer", "agent", "--note", "ok"
            )

        comp = json.loads(self.run_dress("compose", "--dir", str(work)))
        self.assertTrue(comp["ok"])
        self.assertEqual(comp["size"], [1536, 2288])
        self.assertEqual(comp["sleepSize"], [3072, 208])
        self.assertTrue(comp["sleepAnchorCheck"]["ok"])
        self.assertTrue((work / "outfits/pajamas.webp").is_file())
        self.assertTrue((work / "outfits/pajamas-sleep.png").is_file())
        self.assertTrue((work / "qa/sleep.gif").is_file())
        self.assertTrue((work / "qa/compare-sleep.png").is_file())
        with Image.open(work / "outfits/pajamas-sleep.png") as sim:
            self.assertEqual(sim.format, "PNG")
            self.assertEqual(sim.size, (3072, 208))

        deliv = json.loads(self.run_dress("deliver", "--dir", str(work), "--wait", "0.4"))
        self.assertEqual(deliv["status"], "queued")
        staged = [p for p in (self.data / "inbox").iterdir() if not p.name.startswith(".")][0]
        self.assertTrue((staged / "outfits/pajamas.webp").is_file())
        self.assertTrue((staged / "outfits/pajamas-sleep.png").is_file())
        manifest = json.loads((staged / "outfit.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["outfit"]["spritesheetPath"], "outfits/pajamas.webp")
        self.assertEqual(manifest["outfit"]["sleepStrip"], "outfits/pajamas-sleep.png")

    def test_only_sleep_patch_mode_for_installed_outfit(self):
        self._install_lizi_with_sleep_and_moon_pajamas()

        # Cannot patch an outfit that is not installed yet
        self.run_dress(
            "init", "--pet", "lizi", "--outfit", "missing-outfit", "--only-sleep", "--dir", str(self.tmp / "bad-patch"),
            ok=False,
        )

        work = self.tmp / "patch-moon-pajamas-sleep"
        init_res = json.loads(
            self.run_dress(
                "init",
                "--pet",
                "lizi",
                "--outfit",
                "moon-pajamas",
                "--only-sleep",
                "--dir",
                str(work),
            )
        )
        self.assertEqual(init_res["mode"], "only-sleep")
        self.assertEqual(init_res["total"], 1)
        self.assertEqual(init_res["ready"], ["sleep"])
        self.assertTrue((work / "approved/base.png").is_file())
        self.assertTrue((work / "refs/rows/sleep.png").is_file())

        state = json.loads((work / "outfit-state.json").read_text())
        chroma_rgb = state["chromaKey"]["rgb"]
        sleep_gen = self.tmp / "moon-sleep.png"
        _make_generated_row_on_chroma(work / "refs/rows/sleep.png", sleep_gen, chroma_rgb)
        self.run_dress(
            "accept", "--dir", str(work), "--job", "sleep", "--image", str(sleep_gen), "--reviewer", "agent", "--note", "ok"
        )

        comp = json.loads(self.run_dress("compose", "--dir", str(work)))
        self.assertTrue(comp["ok"])
        self.assertEqual(comp["mode"], "only-sleep")
        self.assertEqual(comp["sleepSize"], [3072, 208])
        self.assertTrue((work / "outfits/moon-pajamas-sleep.png").is_file())
        self.assertFalse((work / "outfits/moon-pajamas.webp").exists())
        self.assertTrue((work / "qa/sleep.gif").is_file())
        self.assertTrue((work / "qa/compare-sleep.png").is_file())

        deliv = json.loads(self.run_dress("deliver", "--dir", str(work), "--wait", "0.4"))
        self.assertEqual(deliv["status"], "queued")
        staged = [p for p in (self.data / "inbox").iterdir() if not p.name.startswith(".")][0]
        self.assertTrue((staged / "outfit.json").is_file())
        self.assertTrue((staged / "outfits/moon-pajamas-sleep.png").is_file())
        self.assertFalse((staged / "outfits/moon-pajamas.webp").exists())
        manifest = json.loads((staged / "outfit.json").read_text(encoding="utf-8"))
        self.assertEqual(
            manifest,
            {
                "petId": "lizi",
                "outfit": {
                    "id": "moon-pajamas",
                    "displayName": "月牙睡衣",
                    "sleepStrip": "outfits/moon-pajamas-sleep.png",
                },
            },
        )
        # Verify 3x looped qa/sleep.gif for default 1-based [5, 12] (total duration ~6030ms vs 3230ms unlooped)
        with Image.open(work / "qa/sleep.gif") as gif_im:
            self.assertGreater(gif_im.n_frames, 20)
            total_ms = 0
            for i in range(gif_im.n_frames):
                gif_im.seek(i)
                total_ms += gif_im.info.get("duration", 0)
            self.assertGreater(total_ms, 5500)
        self.assertEqual(comp["sleepLoopFrames"], [5, 12])
        self.assertTrue(comp["sleepLoopQa"]["ok"])

    def test_dynamic_sleep_loop_frames_prompt_mapping_and_loop_qa(self):
        self._install_lizi_with_sleep_and_moon_pajamas()
        # Install a custom sleep action with 1-based loopFrames [4, 10]
        custom_dir = self.data / "pets/lizi/custom"
        custom_dir.mkdir(parents=True, exist_ok=True)
        (custom_dir / "action-library.json").write_text(
            json.dumps(
                {
                    "revision": 1,
                    "layer": {
                        "actions": {
                            "sleep": {
                                "label": "睡觉",
                                "image": "actions/sleep.png",
                                "durations": [150] * 16,
                                "loopFrames": [4, 10],
                            }
                        },
                        "rules": [],
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        work = self.tmp / "patch-custom-loop"
        self.run_dress(
            "init",
            "--pet",
            "lizi",
            "--outfit",
            "moon-pajamas",
            "--only-sleep",
            "--dir",
            str(work),
        )
        state = json.loads((work / "outfit-state.json").read_text(encoding="utf-8"))
        self.assertEqual(state["sleepLoopFrames"], [4, 10])
        self.assertEqual(state["sleepDurations"], [150] * 16)

        prompt = (work / "jobs/sleep.txt").read_text(encoding="utf-8")
        self.assertIn("Frames 1–3", prompt)
        self.assertIn("Frames 4–10", prompt)
        self.assertIn("Frames 11–16", prompt)
        self.assertIn("through Frame 10", prompt)
        self.assertIn("starting at Frame 11", prompt)

        # Verify 3x looped GIF covers 30 frames' worth of duration (4500ms vs 2400ms unlooped) for [4, 10]
        sleep_gen = self.tmp / "custom-loop-sleep.png"
        _make_generated_row_on_chroma(work / "refs/rows/sleep.png", sleep_gen, state["chromaKey"]["rgb"])
        self.run_dress(
            "accept", "--dir", str(work), "--job", "sleep", "--image", str(sleep_gen), "--reviewer", "agent", "--note", "ok"
        )
        with Image.open(work / "qa/sleep.gif") as gif_im:
            self.assertGreater(gif_im.n_frames, 20)
            total_ms = 0
            for i in range(gif_im.n_frames):
                gif_im.seek(i)
                total_ms += gif_im.info.get("duration", 0)
            self.assertEqual(total_ms, 4500)

        # Verify inspect_sleep_loop directly: clean on real lizi-sleep, warns on jitter/seam jump
        dress = _load_dress_module()
        with Image.open(LIZI_SLEEP) as sim:
            rgba = sim.convert("RGBA")
            real_cells = [rgba.crop((i * 192, 0, (i + 1) * 192, 208)) for i in range(16)]
        clean_qa = dress.inspect_sleep_loop(real_cells, [5, 12])
        self.assertTrue(clean_qa["ok"])
        self.assertEqual(clean_qa["warnings"], [])

        # Inject a bright contrasting jump on the last hold frame (1-based #12 = 0-based index 11)
        jitter_cells = [c.copy() for c in real_cells]
        draw = ImageDraw.Draw(jitter_cells[11])
        draw.rectangle((60, 120, 135, 185), fill=(20, 20, 220, 255))
        bad_qa = dress.inspect_sleep_loop(jitter_cells, [5, 12])
        self.assertFalse(bad_qa["ok"])
        self.assertTrue(any("接缝" in w for w in bad_qa["warnings"]))
        self.assertGreater(bad_qa["wrapMad"], 0.035)


if __name__ == "__main__":
    unittest.main()
