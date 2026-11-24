import importlib.util
import json
import re
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]
SKILL = ROOT / "skills/make-desktop-pet"


def module(name):
    sys.path.insert(0, str(SKILL / "scripts"))
    spec = importlib.util.spec_from_file_location(
        name, SKILL / "scripts" / (name + ".py")
    )
    result = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(result)
    return result


exporter = module("export_pet")
behavior = module("behavior")


class SkillTests(unittest.TestCase):
    def test_static_gait_and_grounded_jump_are_rejected(self):
        quality = module("quality")
        result = quality.inspect(ROOT / "examples/mika/spritesheet.webp")
        self.assertFalse(result["ok"])
        self.assertTrue(any("no actual gait" in error for error in result["errors"]))
        self.assertTrue(
            any("visible lift is 0px" in error for error in result["errors"])
        )

    def make_atlas(self, path):
        # Geometric test data only; never distributed as character artwork.
        im = Image.new("RGBA", (1536, 2288))
        draw = ImageDraw.Draw(im)
        for row, count in enumerate([6, 8, 8, 4, 5, 8, 6, 6, 6, 8, 8]):
            for col in range(count):
                lift = 20 if row == 4 and col == 2 else 0
                draw.rectangle(
                    (
                        col * 192 + 75,
                        row * 208 + 80 - lift,
                        col * 192 + 115,
                        row * 208 + 150 - lift,
                    ),
                    fill="#B77C55",
                )
                draw.rectangle(
                    (
                        col * 192 + 80 + col * 2,
                        row * 208 + 110 - lift,
                        col * 192 + 84 + col * 2,
                        row * 208 + 140 - lift,
                    ),
                    fill="#E1C5A4",
                )
        im.save(path)

    def review(self, path):
        check = {
            "pass": True,
            "note": "Synthetic test fixture, not an artwork judgment.",
        }
        return {
            "atlasSha256": exporter.digest(path),
            "reviewedBy": "unit-test fixture",
            "identity": check,
            "transitions": check,
            "motions": {a: check for a in exporter.CONTRACT["animations"]},
            "directions": {a: check for a in exporter.DIRECTIONS},
        }

    def test_export_exact_bytes_and_private_files_excluded(self):
        import zipfile

        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            atlas = p / "source.png"
            self.make_atlas(atlas)
            (p / "private-photo.txt").write_text("not for export")
            review = p / "review.json"
            review.write_text(json.dumps(self.review(atlas)))
            result = exporter.export(
                atlas, review, p / "package", "test-pet", "Test", "", "1", "#00FF00",
                Path(__file__).resolve().parents[1] / "examples/lizi-sleep/actions/sleep.png"
            )
            self.assertEqual(
                exporter.digest(atlas), exporter.digest(p / "package/spritesheet.png")
            )
            with zipfile.ZipFile(result["zip"]) as z:
                self.assertEqual(set(z.namelist()), {"pet.json", "spritesheet.png", "sleep.png"})

    def test_stale_or_failed_review_is_rejected(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "atlas.png"
            self.make_atlas(p)
            review = self.review(p)
            review["atlasSha256"] = "old"
            with self.assertRaises(ValueError):
                exporter.validate_review(p, review)
            review = self.review(p)
            review["directions"]["0"] = {"pass": False, "note": "wrong cardinal"}
            with self.assertRaises(ValueError):
                exporter.validate_review(p, review)

    def test_behavior_change_preserves_identity_and_art(self):
        with tempfile.TemporaryDirectory() as d:
            p = Path(d) / "pet.json"
            p.write_text(json.dumps({"id": "original", "spritesheetPath": "same.webp"}))
            behavior.update(p, 30, 90, {"waving": 2})
            v = json.loads(p.read_text())
            self.assertEqual(v["id"], "original")
            self.assertEqual(v["spritesheetPath"], "same.webp")
            self.assertEqual(v["behavior"]["weights"], {"waving": 2})
            with self.assertRaises(ValueError):
                behavior.update(p, 90, 10)

    def test_prepare_resume_and_dependency_aware_repair(self):
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "pet"
            cmd = [sys.executable, str(SKILL / "scripts/project.py")]
            subprocess.run(
                cmd
                + [
                    "prepare",
                    "--run",
                    str(run),
                    "--name",
                    "test",
                    "--notes",
                    "original test concept",
                ],
                check=True,
                capture_output=True,
            )
            manifest = json.loads((run / "imagegen-jobs.json").read_text())
            self.assertEqual(len(manifest["jobs"]), 13)
            Image.new("RGB", (24, 24), "white").save(run / "decoded/base.png")
            bad = subprocess.run(
                cmd
                + [
                    "accept",
                    "--run",
                    str(run),
                    "--job",
                    "idle",
                    "--reviewer",
                    "codex",
                    "--note",
                    "test fixture",
                ],
                capture_output=True,
            )
            self.assertNotEqual(bad.returncode, 0)
            subprocess.run(
                cmd
                + [
                    "accept",
                    "--run",
                    str(run),
                    "--job",
                    "base",
                    "--reviewer",
                    "user",
                    "--note",
                    "unit test fixture",
                ],
                check=True,
                capture_output=True,
            )
            state = json.loads(
                subprocess.run(
                    cmd + ["status", "--run", str(run)],
                    check=True,
                    capture_output=True,
                    text=True,
                ).stdout
            )
            self.assertIn("idle", state["ready"])
            subprocess.run(
                cmd
                + [
                    "repair",
                    "--run",
                    str(run),
                    "--job",
                    "base",
                    "--reason",
                    "fixture revision",
                ],
                check=True,
                capture_output=True,
            )
            state = json.loads((run / "project-state.json").read_text())
            self.assertEqual(state["jobs"]["base"]["status"], "pending")
            self.assertTrue(list((run / "history").rglob("base.png")))

    def test_hatch_tools_work_on_python_39_and_no_unpatched_310_syntax(self):
        import ast

        hatch = module("hatch")
        assemble = hatch.load_tool("assemble_extended_atlas")
        with tempfile.TemporaryDirectory() as d:
            p = Path(d)
            reg = p / "reg.json"
            reg.write_text(json.dumps({"scale": 0.75}))
            self.assertEqual(assemble.load_registration_scale(reg), 0.75)
            reg.write_text(json.dumps({"scale": 2}))
            self.assertEqual(assemble.load_registration_scale(reg), 2.0)
            reg.write_text(json.dumps({"scale": True}))
            with self.assertRaises(SystemExit):
                assemble.load_registration_scale(reg)

            atlas = p / "atlas.png"
            self.make_atlas(atlas)
            out = p / "continuity.json"
            subprocess.run(
                [
                    sys.executable,
                    str(SKILL / "scripts/hatch.py"),
                    "measure_direction_continuity",
                    str(atlas),
                    "--json-out",
                    str(out),
                ],
                check=True,
                capture_output=True,
                text=True,
            )
            self.assertTrue(json.loads(out.read_text())["ok"])

        # Catch any new Python 3.10+ runtime syntax across all bundled skills.
        known_vendored_patches = {
            ("assemble_extended_atlas.py", "isinstance"),
            ("measure_direction_continuity.py", "zip_strict"),
        }
        for py in sorted((ROOT / "skills").rglob("*.py")):
            tree = ast.parse(py.read_text(encoding="utf-8"), filename=str(py))
            has_future = any(
                isinstance(n, ast.ImportFrom)
                and n.module == "__future__"
                and any(a.name == "annotations" for a in n.names)
                for n in tree.body[:10]
            )
            for node in ast.walk(tree):
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name)
                    and node.func.id in ("isinstance", "issubclass")
                    and len(node.args) >= 2
                    and isinstance(node.args[1], ast.BinOp)
                    and isinstance(node.args[1].op, ast.BitOr)
                ):
                    self.assertIn(
                        (py.name, "isinstance"),
                        known_vendored_patches,
                        f"{py}:{node.lineno} uses A | B in {node.func.id}()",
                    )
                if (
                    isinstance(node, ast.Call)
                    and isinstance(node.func, ast.Name)
                    and node.func.id == "zip"
                    and any(kw.arg == "strict" for kw in node.keywords)
                ):
                    self.assertIn(
                        (py.name, "zip_strict"),
                        known_vendored_patches,
                        f"{py}:{node.lineno} uses zip(..., strict=...)",
                    )
                if not has_future and isinstance(
                    node, (ast.FunctionDef, ast.AsyncFunctionDef)
                ):
                    anns = [
                        a.annotation
                        for a in node.args.posonlyargs
                        + node.args.args
                        + node.args.kwonlyargs
                        if a.annotation
                    ]
                    if node.returns:
                        anns.append(node.returns)
                    for ann in anns:
                        self.assertFalse(
                            any(
                                isinstance(s, ast.BinOp) and isinstance(s.op, ast.BitOr)
                                for s in ast.walk(ann)
                            ),
                            f"{py}:{node.lineno} uses union annotation without __future__.annotations",
                        )


class PromptTests(unittest.TestCase):
    def prepare(self, run, notes):
        return subprocess.run(
            [
                sys.executable,
                str(SKILL / "scripts/project.py"),
                "prepare",
                "--run",
                str(run),
                "--name",
                "test",
                "--notes",
                notes,
            ],
            capture_output=True,
            text=True,
        )

    def running_strip(self, folder, lefts):
        # Geometric test data only: a body with a head on its right side,
        # on the run's flat chroma background.
        decoded = Path(folder) / "decoded"
        decoded.mkdir()
        (Path(folder) / "pet_request.json").write_text(
            json.dumps({"chroma_key": {"hex": "#00FFFF"}})
        )
        strip = Image.new("RGB", (1376, 200), "#00FFFF")
        draw = ImageDraw.Draw(strip)
        for left in lefts:
            draw.rectangle((left, 90, left + 130, 150), fill="#F2EEE8")
            draw.rectangle((left + 130, 60, left + 160, 110), fill="#3A2E28")
        path = decoded / "running-right.png"
        strip.save(path)
        return path

    def mirror_both_ways(self, path):
        hatch = module("hatch")
        spec = importlib.util.spec_from_file_location(
            "upstream_mirror",
            hatch.VENDOR / "derive_running_left_from_running_right.py",
        )
        upstream = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(upstream)
        ours = hatch.load_tool("derive_running_left_from_running_right")
        with Image.open(path) as strip:
            return (
                ours.mirror_strip_preserving_frame_order(strip),
                upstream.mirror_strip_preserving_frame_order(strip),
            )

    def sprite_count(self, image):
        extract = module("hatch").load_tool("extract_strip_frames")
        keyed = extract.remove_chroma_background(image, (0, 255, 255), 96.0)
        return len(
            [c for c in extract.connected_components(keyed) if c["area"] > 50]
        )

    def test_mirror_keeps_upstream_output_when_sprites_fit_their_slots(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.running_strip(d, [i * 172 + 5 for i in range(8)])
            ours, upstream = self.mirror_both_ways(path)
            self.assertEqual(ours.tobytes(), upstream.tobytes())

    def test_mirror_does_not_split_sprites_that_cross_slot_edges(self):
        # A weaker image model drew sprites over their slot edges; slot-by-slot
        # mirroring split them into ghosts and the agent regenerated for hours.
        with tempfile.TemporaryDirectory() as d:
            lefts = [18, 185, 352, 520, 690, 860, 1030, 1206]
            path = self.running_strip(d, lefts)
            ours, upstream = self.mirror_both_ways(path)
            self.assertGreater(self.sprite_count(upstream), 8)
            self.assertEqual(self.sprite_count(ours), 8)
            for left in lefts:
                # The head moved from the right side to the left side.
                self.assertEqual(ours.getpixel((left + 5, 70))[:3], (0x3A, 0x2E, 0x28))
                self.assertEqual(ours.getpixel((left + 150, 70))[:3], (0, 255, 255))

    def test_mirror_refuses_sprites_reaching_into_each_other(self):
        with tempfile.TemporaryDirectory() as d:
            path = self.running_strip(d, [i * 172 + 5 for i in range(8)])
            with Image.open(path) as strip:
                # A floating tail of sprite 3 reaches over sprite 4.
                draw = ImageDraw.Draw(strip)
                draw.rectangle((3 * 172 + 125, 20, 4 * 172 + 45, 35), fill="#F2EEE8")
                strip.save(path)
            with self.assertRaises(SystemExit):
                self.mirror_both_ways(path)

    def test_notes_describe_appearance_only(self):
        with tempfile.TemporaryDirectory() as d:
            bad = self.prepare(Path(d) / "a", "橘猫，九种标准动作和十六个方向完整制作")
            self.assertNotEqual(bad.returncode, 0)
            self.assertIn("动作", bad.stderr)
            self.assertFalse((Path(d) / "a").exists())

    def test_every_prompt_uses_the_runs_chroma_key(self):
        with tempfile.TemporaryDirectory() as d:
            run = Path(d) / "b"
            ok = self.prepare(run, "orange tabby cat with amber eyes and a ringed tail")
            self.assertEqual(ok.returncode, 0, ok.stderr)
            key = json.loads((run / "pet_request.json").read_text())["chroma_key"][
                "hex"
            ]
            prompts = list((run / "prompts").rglob("*.md"))
            self.assertGreater(len(prompts), 10)
            for prompt in prompts:
                text = prompt.read_text()
                if prompt.name == "base-pet.md" or (
                    prompt.parent.name == "rows" and not prompt.stem.startswith("look")
                ):
                    self.assertIn("orange tabby cat", text, prompt.name)
                if prompt.name == "base-pet.md":
                    self.assertIn("natural neutral standing", text)
                    self.assertIn("do not copy a sitting", text)
                if prompt.name in ("running-right.md", "running-left.md"):
                    self.assertIn("natural everyday walking gait", text, prompt)
                if "background" in text:
                    self.assertIn(key, text, prompt.name)
                self.assertNotIn("transparent RGBA background", text)


if __name__ == "__main__":
    unittest.main()


class SkillContextTests(unittest.TestCase):
    """Skills load little up front and point to exactly what each step needs."""

    SKILLS = [ROOT / "skills/make-desktop-pet", ROOT / "skills/teach-desktop-pet"]

    def test_entry_files_stay_small(self):
        for skill in self.SKILLS:
            text = (skill / "SKILL.md").read_text()
            self.assertLess(len(text.encode()), 9000, skill.name)
            self.assertIn("## 先确认用对了 Skill", text, skill.name)
            self.assertIn("## 省着用上下文", text, skill.name)
            # Accepting, discarding and undoing are the user's decisions; an
            # agent with computer use must not click them in the app.
            self.assertIn("## 决定留给用户", text, skill.name)
            self.assertIn("computer use", text, skill.name)

    def test_linked_files_exist(self):
        for skill in self.SKILLS:
            for md in [skill / "SKILL.md", *skill.glob("references/*.md")]:
                for link in re.findall(r"\]\(([^)#]+)\)", md.read_text()):
                    if "://" not in link:
                        self.assertTrue((md.parent / link).exists(), f"{md}: {link}")

    def test_official_guide_is_read_by_section(self):
        guide = (SKILL / "vendor/hatch-pet/SKILL.md").read_text().splitlines()
        index = (SKILL / "references/official-index.md").read_text()
        ranges = re.findall(r"\| (\d+)–(\d+) \| `([^`]+)` \|", index)
        self.assertGreater(len(ranges), 15)
        for start, end, anchor in ranges:
            self.assertTrue(guide[int(start) - 1].startswith(anchor), anchor)
            self.assertLessEqual(int(end), len(guide))
        for skill in self.SKILLS:
            for md in [skill / "SKILL.md", *skill.glob("references/*.md")]:
                self.assertNotIn("完整读一遍", md.read_text(), md)
