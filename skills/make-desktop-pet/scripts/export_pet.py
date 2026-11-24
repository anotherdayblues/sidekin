#!/usr/bin/env python3
"""Export an exact reviewed atlas as a portable local pet package."""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path

from deliver import Refused, deliver, ensure_safe_work_dir
from PIL import Image
from quality import inspect as inspect_motion

SKILL = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((SKILL / "references/runtime-contract.json").read_text())
DIRECTIONS = [f"{i * 22.5:g}" for i in range(16)]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_review(atlas, review):
    if review.get("atlasSha256") != digest(atlas):
        raise ValueError(
            "Review belongs to different image bytes. Render and review the final atlas again."
        )
    if not str(review.get("reviewedBy", "")).strip():
        raise ValueError("Record who actually reviewed the images.")
    checks = [
        ("identity", review.get("identity")),
        ("transitions", review.get("transitions")),
    ]
    checks += [
        (key, review.get("motions", {}).get(key)) for key in CONTRACT["animations"]
    ]
    checks += [(key, review.get("directions", {}).get(key)) for key in DIRECTIONS]
    for name, check in checks:
        if (
            not isinstance(check, dict)
            or check.get("pass") is not True
            or len(str(check.get("note", "")).strip()) < 4
        ):
            raise ValueError(f"Visual review is incomplete or failed: {name}")


def export(atlas, review_path, output, pet_id, name, description, revision, chroma, sleep_strip):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", pet_id):
        raise ValueError(
            "Use a stable ID containing letters, numbers, hyphens or underscores."
        )
    if not name.strip() or len(name) > 100:
        raise ValueError("Give the pet a name of 1–100 characters.")
    output = ensure_safe_work_dir(output, SKILL)
    zip_path = output.parent / (output.name + ".zip")
    if output.exists() or zip_path.exists():
        raise ValueError("Output already exists. Use a new revision directory.")
    validate_review(atlas, json.loads(review_path.read_text()))
    motion = inspect_motion(atlas)
    review_path.with_name("motion-quality.json").write_text(
        json.dumps(motion, indent=2) + "\n"
    )
    if not motion["ok"]:
        raise ValueError("Motion quality failed: " + "; ".join(motion["errors"]))
    if atlas.stat().st_size > 20 * 1024 * 1024:
        raise ValueError("Atlas exceeds 20 MiB.")
    with Image.open(atlas) as img:
        if img.format not in ["PNG", "WEBP"]:
            raise ValueError("Atlas must be PNG or WebP.")
        suffix = ".png" if img.format == "PNG" else ".webp"
    output.parent.mkdir(parents=True, exist_ok=True)
    # Keep validation reports outside the portable pet package.
    report = review_path.with_name("export-validation-" + digest(atlas)[:12] + ".json")
    subprocess.run(
        [
            sys.executable,
            str(SKILL / "scripts/hatch.py"),
            "validate_atlas",
            str(atlas),
            "--require-v2",
            "--chroma-key",
            chroma,
            "--json-out",
            str(report),
        ],
        check=True,
        capture_output=True,
        text=True,
    )
    with tempfile.TemporaryDirectory(prefix="pet-export-", dir=output.parent) as temp:
        staged = Path(temp) / "pet"
        staged.mkdir()
        filename = "spritesheet" + suffix
        shutil.copy2(atlas, staged / filename)
        pet = {
            "id": pet_id,
            "displayName": name,
            "description": description,
            "revision": revision,
            "spriteVersionNumber": 2,
            "spritesheetPath": filename,
            "behavior": CONTRACT["defaultBehavior"],
        }
        with Image.open(sleep_strip) as sleep:
            if sleep.format != "PNG" or sleep.size != (192 * 16, 208) or sleep_strip.stat().st_size > 4 * 1024 * 1024:
                raise ValueError("睡眠动画需要 16 格透明 PNG 横条，3072 × 208，最多 4 MiB。")
            alpha = sleep.convert("RGBA").getchannel("A")
            if any(not alpha.crop((i*192,0,(i+1)*192,208)).getbbox() for i in range(16)):
                raise ValueError("睡眠横条里有空帧。")
        shutil.copyfile(sleep_strip, staged / "sleep.png")
        pet["sleepStrip"] = "sleep.png"
        (staged / "pet.json").write_text(
            json.dumps(pet, ensure_ascii=False, indent=2) + "\n"
        )
        if digest(staged / filename) != digest(atlas):
            raise ValueError("Export bytes changed unexpectedly.")
        staged.rename(output)
    with zipfile.ZipFile(zip_path, "x", compression=zipfile.ZIP_DEFLATED) as package:
        for member_name in ["pet.json", filename] + ([pet["sleepStrip"]] if "sleepStrip" in pet else []):
            package.write(output / member_name, member_name)
    return {
        "directory": str(output),
        "zip": str(zip_path),
        "sha256": digest(atlas),
        "validation": str(report),
    }


def send(package, wait):
    """Hand an exported package to Pet Studio and say plainly what happened."""
    package = Path(package)
    pet = json.loads((package / "pet.json").read_text())
    try:
        r = deliver(package, ["pet.json", pet["spritesheetPath"]] + ([pet["sleepStrip"]] if "sleepStrip" in pet else []), pet["id"], wait)
    except Refused as exc:
        raise SystemExit("随伴拒收了这个宠物包：" + str(exc))
    if r["status"] == "received":
        r["message"] = (
            f"{pet['displayName']} 已经更新到随伴里。"
            if r.get("updated")
            else f"{pet['displayName']} 已经送进随伴，主窗口会弹出来。"
        )
    else:
        r["message"] = "随伴现在没有运行。宠物包已放进它的收件箱，下次打开随伴会自动出现。"
    return r


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for command in ["review-template", "export"]:
        p = sub.add_parser(command)
        p.add_argument("--atlas", type=Path, required=True)
        p.add_argument("--output", type=Path, required=True)
        if command == "export":
            p.add_argument("--sleep-strip", type=Path, required=True)
            p.add_argument("--review", type=Path, required=True)
            p.add_argument("--id", required=True)
            p.add_argument("--name", required=True)
            p.add_argument("--description", default="")
            p.add_argument("--revision", required=True)
            p.add_argument("--chroma-key", required=True)
            p.add_argument(
                "--deliver",
                action="store_true",
                help="Send the package straight into Pet Studio when done.",
            )
    p = sub.add_parser("deliver", help="Send an exported package into Pet Studio.")
    p.add_argument("--package", type=Path, required=True)
    p.add_argument("--wait", type=float, default=8)
    args = parser.parse_args()
    if args.command == "deliver":
        print(json.dumps(send(args.package, args.wait), ensure_ascii=False, indent=2))
        return
    if args.command == "review-template":
        if args.output.exists():
            raise SystemExit(
                "Review already exists; inspect or choose a new output path."
            )

        def check():
            return {"pass": False, "note": ""}

        data = {
            "atlasSha256": digest(args.atlas),
            "reviewedBy": "",
            "identity": check(),
            "transitions": check(),
            "motions": {key: check() for key in CONTRACT["animations"]},
            "directions": {key: check() for key in DIRECTIONS},
        }
        args.output.parent.mkdir(parents=True, exist_ok=True)
        args.output.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")
        print(args.output)
    else:
        try:
            result = export(
                args.atlas.resolve(),
                args.review.resolve(),
                args.output.resolve(),
                args.id,
                args.name,
                args.description,
                args.revision,
                args.chroma_key,
                args.sleep_strip,
            )
        except subprocess.CalledProcessError as exc:
            raise SystemExit(exc.stdout + exc.stderr)
        except ValueError as exc:
            raise SystemExit(str(exc))
        if args.deliver:
            result["delivery"] = send(Path(result["directory"]), 8)
        print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
