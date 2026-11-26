import importlib.util
import json
import os
import tempfile
import threading
import time
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
COPIES = [
    ROOT / "skills/make-desktop-pet/scripts/deliver.py",
    ROOT / "skills/teach-desktop-pet/scripts/deliver.py",
    ROOT / "skills/dress-desktop-pet/scripts/deliver.py",
]


def load():
    spec = importlib.util.spec_from_file_location("deliver", COPIES[0])
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def fake_app(inbox, verdict, stop):
    """Stands in for Pet Studio: answers each finished folder once."""
    while not stop.is_set():
        for item in inbox.iterdir() if inbox.exists() else []:
            if item.name.startswith(".") or not item.is_dir():
                continue
            if verdict == "ok":
                receipt = {
                    "kind": "pet",
                    "petId": "lizi",
                    "name": "栗子",
                    "updated": False,
                }
                (inbox / f".done-{item.name}.json").write_text(json.dumps(receipt))
                for f in item.iterdir():
                    f.unlink()
                item.rmdir()
            else:
                failed = inbox / f".failed-{item.name}"
                item.rename(failed)
                (failed / "error.txt").write_text("v2 图集应为 1536 × 2288")
        time.sleep(0.05)


class DeliverTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.data = Path(self.tmp.name) / "data"
        os.environ["PET_STUDIO_DATA"] = str(self.data)
        self.pkg = Path(self.tmp.name) / "pkg"
        self.pkg.mkdir()
        (self.pkg / "pet.json").write_text("{}")
        (self.pkg / "spritesheet.webp").write_bytes(b"x")
        self.deliver = load()

    def tearDown(self):
        os.environ.pop("PET_STUDIO_DATA", None)
        self.tmp.cleanup()

    def run_with_app(self, verdict):
        stop = threading.Event()
        t = threading.Thread(target=fake_app, args=(self.data / "inbox", verdict, stop))
        t.start()
        try:
            return self.deliver.deliver(
                self.pkg, ["pet.json", "spritesheet.webp"], "lizi", 3
            )
        finally:
            stop.set()
            t.join()

    def test_both_skills_carry_the_same_client(self):
        expected = COPIES[0].read_bytes()
        for copy in COPIES[1:]:
            self.assertEqual(expected, copy.read_bytes(), str(copy))

    def test_receipt_is_returned_and_cleared(self):
        r = self.run_with_app("ok")
        self.assertEqual(r["status"], "received")
        self.assertEqual(r["petId"], "lizi")
        self.assertEqual(list((self.data / "inbox").iterdir()), [])

    def test_refusal_carries_the_reason(self):
        with self.assertRaises(self.deliver.Refused) as caught:
            self.run_with_app("refuse")
        self.assertIn("1536", str(caught.exception))

    def test_app_not_running_leaves_it_queued(self):
        r = self.deliver.deliver(
            self.pkg, ["pet.json", "spritesheet.webp"], "lizi", 0.4
        )
        self.assertEqual(r["status"], "queued")
        waiting = [
            p for p in (self.data / "inbox").iterdir() if not p.name.startswith(".")
        ]
        self.assertEqual(len(waiting), 1)
        self.assertEqual(
            sorted(f.name for f in waiting[0].iterdir()),
            ["pet.json", "spritesheet.webp"],
        )

    def test_failed_copy_cleans_up_tmp_folder(self):
        with self.assertRaises(FileNotFoundError):
            self.deliver.deliver(
                self.pkg, ["pet.json", "missing-sheet.webp"], "lizi", 0.2
            )
        inbox = self.data / "inbox"
        self.assertEqual(list(inbox.iterdir()), [])

    def test_safe_work_dir_blocks_dangerous_locations(self):
        skill = ROOT / "skills/make-desktop-pet"
        safe = Path(self.tmp.name) / "isolated-work"
        self.assertEqual(
            self.deliver.ensure_safe_work_dir(safe, skill), safe.resolve()
        )
        # 1. Inside skill or skills folder
        with self.assertRaises(ValueError):
            self.deliver.ensure_safe_work_dir(skill / "work", skill)
        with self.assertRaises(ValueError):
            self.deliver.ensure_safe_work_dir(ROOT / "skills" / "work", skill)
        # 2. Inside PET_STUDIO_DATA
        with self.assertRaises(ValueError):
            self.deliver.ensure_safe_work_dir(self.data / "work", skill)
        # 3. Inside a .app bundle
        app_work = Path(self.tmp.name) / "Suiban.app" / "Contents" / "work"
        with self.assertRaises(ValueError):
            self.deliver.ensure_safe_work_dir(app_work, skill)
        # 4. Inside Suiban's own project source tree (blocked), while an unrelated user .git folder is allowed.
        suiban_src = Path(self.tmp.name) / "suiban-repo"
        (suiban_src / "apps" / "desktop").mkdir(parents=True)
        (suiban_src / "skills").mkdir(parents=True)
        with self.assertRaises(ValueError):
            self.deliver.ensure_safe_work_dir(suiban_src / "pet-work", skill)
        user_git = Path(self.tmp.name) / "my-pet-assets"
        (user_git / ".git").mkdir(parents=True)
        self.assertEqual(
            self.deliver.ensure_safe_work_dir(user_git / "lizi", skill),
            (user_git / "lizi").resolve(),
        )
        # 5. Inside a Windows portable install dir alongside skills/
        win_app = Path(self.tmp.name) / "win-portable"
        win_skill = win_app / "skills" / "make-desktop-pet"
        win_skill.mkdir(parents=True)
        (win_app / "companion-brain.exe").write_bytes(b"mz")
        with self.assertRaises(ValueError):
            self.deliver.ensure_safe_work_dir(win_app / "work", win_skill)


if __name__ == "__main__":
    unittest.main()
