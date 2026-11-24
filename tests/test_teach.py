import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
TEACH = ROOT / "skills/teach-desktop-pet/scripts/teach.py"
LIZI = ROOT / "examples/lizi"


def fake_strip(path, frames, key=(255, 0, 255), gap_scale=2):
    """A generated-looking strip: real Lizi cells, enlarged, on a flat key colour."""
    with Image.open(LIZI / "spritesheet.webp") as sheet:
        sheet = sheet.convert("RGBA")
        cells = [sheet.crop((0, 0, 192, 208))]
        cells += [
            sheet.crop((c * 192, 3 * 208, (c + 1) * 192, 4 * 208)) for c in range(4)
        ]
        cells += [sheet.crop((0, 0, 192, 208))]
    cells = cells[:frames]
    slot = 192 * gap_scale
    out = Image.new("RGBA", (slot * frames, 208 * gap_scale), key + (255,))
    for i, cell in enumerate(cells):
        big = cell.resize((192 * gap_scale, 208 * gap_scale), Image.Resampling.LANCZOS)
        out.alpha_composite(big, (i * slot, 0))
    out.convert("RGB").save(path)


class TeachTests(unittest.TestCase):
    def setUp(self):
        self.tmp = Path(tempfile.mkdtemp())
        self.data = self.tmp / "data"
        pet = self.data / "pets/lizi"
        pet.mkdir(parents=True)
        shutil.copy(LIZI / "spritesheet.webp", pet / "spritesheet.webp")
        shutil.copy(LIZI / "pet.json", pet / "pet.json")
        self.env = {**os.environ, "PET_STUDIO_DATA": str(self.data)}
        self.dir = self.tmp / "teach"

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def run_teach(self, *args, ok=True):
        r = subprocess.run(
            [sys.executable, str(TEACH), *args],
            env=self.env,
            capture_output=True,
            text=True,
        )
        if ok:
            self.assertEqual(r.returncode, 0, r.stderr + r.stdout)
        else:
            self.assertNotEqual(r.returncode, 0, r.stdout)
        return r.stdout if ok else r.stdout + r.stderr

    def test_full_teaching_flow(self):
        self.assertIn("栗子", self.run_teach("pets"))
        self.run_teach(
            "new", "--pet", "lizi", "--dir", str(self.dir), "--summary", "晚上挥挥手"
        )
        out = json.loads(
            self.run_teach(
                "prompt",
                "--dir",
                str(self.dir),
                "--name",
                "night-wave",
                "--label",
                "夜晚挥手",
                "--frames",
                "6",
                "--motion",
                "1: idle. 2-5: wave. 6: idle.",
            )
        )
        prompt = Path(out["prompt_file"]).read_text()
        self.assertIn("exactly 6 full-body frames", prompt)
        self.assertIn("#FF00FF", prompt)
        self.assertEqual(len(out["input_images"]), 3)
        strip = self.tmp / "generated.png"
        fake_strip(strip, 6)
        info = json.loads(
            self.run_teach(
                "add-action",
                "--dir",
                str(self.dir),
                "--name",
                "night-wave",
                "--label",
                "夜晚挥手",
                "--strip",
                str(strip),
            )
        )
        self.assertEqual(info["background"], "chroma")
        self.assertAlmostEqual(info["scale"], 0.5, places=2)
        self.assertEqual(info["notes"], [])
        with Image.open(self.dir / "actions/night-wave.png") as im:
            self.assertEqual(im.size, (192 * 6, 208))
            # Same placement as the source idle cell: no key colour left.
            first = im.crop((0, 0, 192, 208))
            with Image.open(LIZI / "spritesheet.webp") as sheet:
                cell = sheet.convert("RGBA").crop((0, 0, 192, 208))
                sheet_box = (
                    cell.getchannel("A").point(lambda v: 255 if v > 32 else 0).getbbox()
                )
            box = first.getchannel("A").point(lambda v: 255 if v > 32 else 0).getbbox()
            idle_box = sheet_box
            for a, b in zip(box, idle_box):
                self.assertLessEqual(abs(a - b), 3)
            raw = im.convert("RGBA").tobytes()
            pixels = [raw[i : i + 4] for i in range(0, len(raw), 4) if raw[i + 3] > 200]
            self.assertFalse(
                any(r > 200 and b > 200 and g < 60 for r, g, b, _ in pixels)
            )
        self.assertTrue((self.dir / "qa/night-wave.gif").exists())
        # A learned action plays on a double-click, at random, or at a time
        # each day (plan/29); one rule, one action, once.
        rule = {
            "id": "night",
            "label": "晚上挥手",
            "when": {"type": "clock", "at": "23:00"},
            "do": [{"play": "night-wave"}],
        }
        out = self.run_teach(
            "add-rule", "--dir", str(self.dir), "--json", json.dumps(rule)
        )
        self.assertIn("每天 23:00", out)
        self.assertIn("夜晚挥手", out)
        for bad in (
            {"when": {"type": "event", "event": "click"}},
            {"when": {"type": "every", "minutes": 60}},
            {"when": {"type": "clock", "at": "*:00"}},
            {"do": [{"play": "jumping"}]},
            {"do": [{"play": "night-wave", "repeat": 2}, {"wait": 500}]},
            {"chance": 0.5},
        ):
            self.run_teach(
                "add-rule",
                "--dir",
                str(self.dir),
                "--json",
                json.dumps({**rule, "id": "bad", **bad}),
                ok=False,
            )
        self.assertIn("检查通过", self.run_teach("check", "--dir", str(self.dir)))
        out = self.run_teach("stage", "--dir", str(self.dir), "--wait", "0.6")
        self.assertIn("收件箱", out)
        staged = [
            p for p in (self.data / "inbox").iterdir() if not p.name.startswith(".")
        ]
        self.assertEqual(len(staged), 1)
        self.assertTrue((staged[0] / "actions/night-wave.png").exists())

    def test_rejects_unclear_rules_and_strips(self):
        self.run_teach(
            "new", "--pet", "lizi", "--dir", str(self.dir), "--summary", "测试"
        )
        bad = [
            {
                "id": "a",
                "label": "x",
                "when": {"type": "clock", "at": "7:00"},
                "do": [{"play": "waving"}],
            },
            {
                "id": "a",
                "label": "x",
                "when": {"type": "event", "event": "shake"},
                "do": [{"play": "waving"}],
            },
            {
                "id": "a",
                "label": "x",
                "when": {"type": "every", "minutes": 60},
                "do": [{"play": "missing"}],
            },
            {
                "id": "a",
                "label": "x",
                "when": {"type": "every", "minutes": 60},
                "do": [{"play": "waving", "wait": 3}],
            },
            {
                "id": "A b",
                "label": "x",
                "when": {"type": "every", "minutes": 60},
                "do": [{"play": "waving"}],
            },
        ]
        for rule in bad:
            self.run_teach(
                "add-rule", "--dir", str(self.dir), "--json", json.dumps(rule), ok=False
            )
        # Poses touching each other cannot be separated reliably.
        strip = self.tmp / "crowded.png"
        fake_strip(strip, 6, gap_scale=1)
        out = self.run_teach(
            "add-action",
            "--dir",
            str(self.dir),
            "--name",
            "w",
            "--label",
            "挥手",
            "--strip",
            str(strip),
            "--frames",
            "5",
            ok=False,
        )
        self.assertIn("找不到 5 个分开的姿势", out)
        self.assertIn(
            "还没有任何改动", self.run_teach("check", "--dir", str(self.dir), ok=False)
        )

    def test_unknown_pet_lists_known_ones(self):
        out = self.run_teach(
            "new", "--pet", "nobody", "--dir", str(self.dir), "--summary", "x", ok=False
        )
        self.assertIn("lizi", out)


if __name__ == "__main__":
    unittest.main()
