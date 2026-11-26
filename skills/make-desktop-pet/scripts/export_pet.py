#!/usr/bin/env python3
"""Export an exact reviewed atlas as a portable local pet package."""

import argparse
import hashlib
import json
import math
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
SAFE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
WEEKDAYS = {"sun", "mon", "tue", "wed", "thu", "fri", "sat"}
DAYS_IN_MONTH = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)
MAX_IMAGE_BYTES = 32 * 1024 * 1024
MAX_ACTIVITY_BYTES = 4 * 1024 * 1024
CELL_W = 192
CELL_H = 208


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def parse_gaze_anchor(value):
    if value is None:
        return None
    if isinstance(value, dict):
        x, y = value.get("x"), value.get("y")
    else:
        parts = str(value).split(",")
        if len(parts) != 2:
            raise ValueError("--gaze-anchor expects 'x,y' with normalized values in [0, 1].")
        try:
            x, y = float(parts[0].strip()), float(parts[1].strip())
        except ValueError as exc:
            raise ValueError("--gaze-anchor values must be numbers in [0, 1].") from exc
    if (
        isinstance(x, bool)
        or isinstance(y, bool)
        or not isinstance(x, (int, float))
        or not isinstance(y, (int, float))
        or not (math.isfinite(x) and math.isfinite(y))
        or not (0.0 <= float(x) <= 1.0 and 0.0 <= float(y) <= 1.0)
    ):
        raise ValueError("gazeAnchor x and y must be finite numbers in [0, 1].")
    return {"x": round(float(x), 4), "y": round(float(y), 4)}


def _valid_clock(val):
    if not isinstance(val, str) or not re.fullmatch(r"\d{2}:\d{2}", val):
        return False
    h, m = int(val[:2]), int(val[3:])
    return 0 <= h <= 23 and 0 <= m <= 59


def _valid_mmdd(val):
    if not isinstance(val, str) or not re.fullmatch(r"\d{2}-\d{2}", val):
        return False
    m, d = int(val[:2]), int(val[3:])
    return 1 <= m <= 12 and 1 <= d <= DAYS_IN_MONTH[m - 1]


def _resolve_asset_file(base_dir, rel_path):
    rel = Path(rel_path)
    candidates = [base_dir / rel, base_dir / rel.name]
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    raise ValueError(f"Missing referenced asset {rel_path!r} in {base_dir}.")


def _stage_wardrobe(wardrobe_path, outfits_dir, staged, expected_size):
    data = json.loads(Path(wardrobe_path).read_text(encoding="utf-8"))
    if not isinstance(data, dict):
        raise ValueError("wardrobe JSON must be an object with 'outfits'.")
    raw_outfits = data.get("outfits")
    if not isinstance(raw_outfits, list) or not (1 <= len(raw_outfits) <= 16):
        raise ValueError("wardrobe.outfits must list between 1 and 16 outfits.")
    src_dir = (
        Path(outfits_dir).expanduser().resolve()
        if outfits_dir is not None
        else Path(wardrobe_path).expanduser().resolve().parent / "outfits"
    )
    seen = set()
    outfits = []
    staged_paths = []
    for entry in raw_outfits:
        if not isinstance(entry, dict):
            raise ValueError("Each wardrobe outfit must be an object.")
        oid = str(entry.get("id", ""))
        if not SAFE_ID_RE.match(oid) or oid in ("default", "auto"):
            raise ValueError(f"Invalid outfit id: {oid!r}")
        if oid in seen:
            raise ValueError(f"Duplicate outfit id: {oid!r}")
        seen.add(oid)
        display_name = str(entry.get("displayName", "")).strip()
        if not (1 <= len(display_name) <= 40):
            raise ValueError(f"Invalid outfit displayName for {oid!r}")
        sp = str(entry.get("spritesheetPath", ""))
        if sp not in (f"outfits/{oid}.webp", f"outfits/{oid}.png"):
            raise ValueError(
                f"Outfit spritesheetPath must be outfits/{oid}.webp or outfits/{oid}.png"
            )
        src_file = _resolve_asset_file(src_dir, sp)
        if src_file.stat().st_size > MAX_IMAGE_BYTES:
            raise ValueError(f"Outfit {oid} exceeds 32 MiB.")
        with Image.open(src_file) as im:
            if im.format not in ("PNG", "WEBP") or im.size != expected_size:
                raise ValueError(
                    f"Outfit {oid} must be PNG/WebP matching {expected_size}, got {im.format} {im.size}."
                )
        dest = staged / sp
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src_file, dest)
        staged_paths.append(sp)
        outfit_obj = {"id": oid, "displayName": display_name, "spritesheetPath": sp}
        if entry.get("sleepStrip") is not None:
            sleep_sp = str(entry["sleepStrip"])
            if sleep_sp not in (f"outfits/{oid}-sleep.png", f"outfits/{oid}-sleep.webp"):
                raise ValueError(
                    f"Outfit sleepStrip must be outfits/{oid}-sleep.png or outfits/{oid}-sleep.webp"
                )
            sleep_src = _resolve_asset_file(src_dir, sleep_sp)
            if sleep_src.stat().st_size > MAX_ACTIVITY_BYTES:
                raise ValueError(f"Outfit sleepStrip {sleep_sp} exceeds 4 MiB.")
            with Image.open(sleep_src) as sim:
                if sim.format not in ("PNG", "WEBP") or sim.size != (CELL_W * 16, CELL_H):
                    raise ValueError(
                        f"Outfit sleepStrip {sleep_sp} must be 16-frame PNG/WebP ({CELL_W * 16}x{CELL_H}), got {sim.format} {sim.size}."
                    )
                s_alpha = sim.convert("RGBA").getchannel("A")
                if any(
                    s_alpha.crop((i * CELL_W, 0, (i + 1) * CELL_W, CELL_H)).getbbox() is None
                    for i in range(16)
                ):
                    raise ValueError(f"Outfit sleepStrip {sleep_sp} contains an empty frame.")
            sleep_dest = staged / sleep_sp
            sleep_dest.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(sleep_src, sleep_dest)
            staged_paths.append(sleep_sp)
            outfit_obj["sleepStrip"] = sleep_sp
        outfits.append(outfit_obj)

    raw_schedule = data.get("schedule", [])
    if not isinstance(raw_schedule, list) or len(raw_schedule) > 32:
        raise ValueError("wardrobe.schedule must be a list of at most 32 rules.")
    schedule = []
    for rule in raw_schedule:
        if not isinstance(rule, dict):
            raise ValueError("Each schedule rule must be an object.")
        target = str(rule.get("outfit", ""))
        if target != "default" and target not in seen:
            raise ValueError(f"Schedule references unknown outfit: {target!r}")
        when = rule.get("when")
        if not isinstance(when, dict):
            raise ValueError("Schedule rule requires a 'when' object.")
        clean_when = {}
        if "time" in when and when["time"] is not None:
            t = when["time"]
            if (
                not isinstance(t, dict)
                or not _valid_clock(t.get("from"))
                or not _valid_clock(t.get("to"))
                or t["from"] == t["to"]
            ):
                raise ValueError("Schedule time requires distinct HH:MM from/to.")
            clean_when["time"] = {"from": t["from"], "to": t["to"]}
        if "days" in when and when["days"] is not None:
            days = when["days"]
            if not isinstance(days, list) or not days or any(d not in WEEKDAYS for d in days):
                raise ValueError("Schedule days must be a non-empty list of sun..sat.")
            clean_when["days"] = [d for d in ("sun", "mon", "tue", "wed", "thu", "fri", "sat") if d in days]
        if "dates" in when and when["dates"] is not None:
            dr = when["dates"]
            if not isinstance(dr, dict) or not _valid_mmdd(dr.get("from")) or not _valid_mmdd(dr.get("to")):
                raise ValueError("Schedule dates requires MM-DD from/to.")
            clean_when["dates"] = {"from": dr["from"], "to": dr["to"]}
        if not clean_when:
            raise ValueError("Schedule rule must have at least one condition.")
        clean_rule = {"outfit": target, "when": clean_when}
        if rule.get("enabled") is False:
            clean_rule["enabled"] = False
        schedule.append(clean_rule)

    return {"outfits": outfits, "schedule": schedule}, seen, staged_paths


def _stage_activity_strip(act_id, outfit_id, sp, frame_count, fps, primary, available_outfits, seen_outfits, src_dir, staged):
    if not SAFE_ID_RE.match(outfit_id) or (outfit_id != "default" and outfit_id not in available_outfits):
        raise ValueError(f"Activity {act_id!r} references unknown outfit {outfit_id!r}.")
    if outfit_id in seen_outfits:
        raise ValueError(f"Activity {act_id!r} duplicates outfit {outfit_id!r}.")
    seen_outfits.add(outfit_id)
    if primary:
        allowed = (f"activities/{act_id}.webp", f"activities/{act_id}.png")
    else:
        allowed = (
            f"activities/{act_id}.{outfit_id}.webp",
            f"activities/{act_id}.{outfit_id}.png",
        )
    if sp not in allowed:
        raise ValueError(f"Activity spritesheetPath must be one of {allowed}, got {sp!r}.")
    if not isinstance(frame_count, int) or isinstance(frame_count, bool) or not (4 <= frame_count <= 32):
        raise ValueError(f"Activity {act_id!r} frameCount must be an integer 4..32.")
    if not isinstance(fps, int) or isinstance(fps, bool) or not (1 <= fps <= 12):
        raise ValueError(f"Activity {act_id!r} fps must be an integer 1..12.")
    duration_ms = frame_count * 1000.0 / fps
    if not (1000.0 <= duration_ms <= 12000.0):
        raise ValueError(f"Activity {act_id!r} duration must be 1000..12000 ms.")
    src_file = _resolve_asset_file(src_dir, sp)
    if src_file.stat().st_size > MAX_ACTIVITY_BYTES:
        raise ValueError(f"Activity strip {sp} exceeds 4 MiB.")
    with Image.open(src_file) as im:
        if im.format not in ("PNG", "WEBP") or im.size != (CELL_W * frame_count, CELL_H):
            raise ValueError(
                f"Activity strip {sp} must be PNG/WebP {CELL_W * frame_count}x{CELL_H}, got {im.format} {im.size}."
            )
        alpha = im.convert("RGBA").getchannel("A")
        if any(alpha.crop((i * CELL_W, 0, (i + 1) * CELL_W, CELL_H)).getbbox() is None for i in range(frame_count)):
            raise ValueError(f"Activity strip {sp} contains an empty frame.")
    dest = staged / sp
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src_file, dest)
    return {
        "outfitId": outfit_id,
        "spritesheetPath": sp,
        "frameCount": frame_count,
        "fps": fps,
    }, sp


def _stage_activities(activities_path, activities_dir, staged, available_outfits):
    data = json.loads(Path(activities_path).read_text(encoding="utf-8"))
    if isinstance(data, dict) and "activities" in data:
        data = data["activities"]
    if not isinstance(data, list) or len(data) > 16:
        raise ValueError("activities JSON must be a list of at most 16 activities.")
    src_dir = (
        Path(activities_dir).expanduser().resolve()
        if activities_dir is not None
        else Path(activities_path).expanduser().resolve().parent / "activities"
    )
    seen_ids = set()
    activities = []
    staged_paths = []
    for entry in data:
        if not isinstance(entry, dict):
            raise ValueError("Each activity must be an object.")
        aid = str(entry.get("id", ""))
        if not SAFE_ID_RE.match(aid):
            raise ValueError(f"Invalid activity id: {aid!r}")
        if aid in seen_ids:
            raise ValueError(f"Duplicate activity id: {aid!r}")
        seen_ids.add(aid)
        display_name = str(entry.get("displayName", "")).strip()
        if not (1 <= len(display_name) <= 40):
            raise ValueError(f"Invalid activity displayName for {aid!r}")
        seen_outfits = set()
        primary, sp = _stage_activity_strip(
            aid,
            str(entry.get("outfitId", "")),
            str(entry.get("spritesheetPath", "")),
            entry.get("frameCount"),
            entry.get("fps"),
            True,
            available_outfits,
            seen_outfits,
            src_dir,
            staged,
        )
        staged_paths.append(sp)
        clean_act = {
            "id": aid,
            "displayName": display_name,
            **primary,
        }
        raw_variants = entry.get("outfitVariants")
        if raw_variants:
            if not isinstance(raw_variants, list) or len(raw_variants) > 16:
                raise ValueError(f"Activity {aid!r} outfitVariants must list at most 16 entries.")
            variants = []
            for v in raw_variants:
                if not isinstance(v, dict):
                    raise ValueError(f"Activity {aid!r} variant must be an object.")
                clean_v, v_sp = _stage_activity_strip(
                    aid,
                    str(v.get("outfitId", "")),
                    str(v.get("spritesheetPath", "")),
                    v.get("frameCount"),
                    v.get("fps"),
                    False,
                    available_outfits,
                    seen_outfits,
                    src_dir,
                    staged,
                )
                staged_paths.append(v_sp)
                variants.append(clean_v)
            clean_act["outfitVariants"] = variants
        activities.append(clean_act)
    return activities, staged_paths


def package_members(pet):
    """Collect all relative file paths belonging to an exported pet package."""
    members = ["pet.json", pet["spritesheetPath"]]
    if "sleepStrip" in pet and pet["sleepStrip"]:
        members.append(pet["sleepStrip"])
    wardrobe = pet.get("wardrobe")
    if isinstance(wardrobe, dict):
        for outfit in wardrobe.get("outfits", []):
            for key in ("spritesheetPath", "sleepStrip"):
                sp = outfit.get(key)
                if sp and sp not in members:
                    members.append(sp)
    for act in pet.get("activities", []) or []:
        sp = act.get("spritesheetPath")
        if sp and sp not in members:
            members.append(sp)
        for v in act.get("outfitVariants", []) or []:
            vsp = v.get("spritesheetPath")
            if vsp and vsp not in members:
                members.append(vsp)
    return members


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


def export(
    atlas,
    review_path,
    output,
    pet_id,
    name,
    description,
    revision,
    chroma,
    sleep_strip,
    *,
    wardrobe_path=None,
    outfits_dir=None,
    activities_path=None,
    activities_dir=None,
    gaze_anchor=None,
):
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", pet_id):
        raise ValueError(
            "Use a stable ID containing letters, numbers, hyphens or underscores."
        )
    if not name.strip() or len(name) > 100:
        raise ValueError("Give the pet a name of 1–100 characters.")
    parsed_anchor = parse_gaze_anchor(gaze_anchor)
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
    if atlas.stat().st_size > MAX_IMAGE_BYTES:
        raise ValueError("Atlas exceeds 32 MiB.")
    with Image.open(atlas) as img:
        if img.format not in ["PNG", "WEBP"]:
            raise ValueError("Atlas must be PNG or WebP.")
        suffix = ".png" if img.format == "PNG" else ".webp"
        atlas_size = img.size
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
            if (
                sleep.format != "PNG"
                or sleep.size != (192 * 16, 208)
                or sleep_strip.stat().st_size > 4 * 1024 * 1024
            ):
                raise ValueError("睡眠动画需要 16 格透明 PNG 横条，3072 × 208，最多 4 MiB。")
            alpha = sleep.convert("RGBA").getchannel("A")
            if any(not alpha.crop((i * 192, 0, (i + 1) * 192, 208)).getbbox() for i in range(16)):
                raise ValueError("睡眠横条里有空帧。")
        shutil.copyfile(sleep_strip, staged / "sleep.png")
        pet["sleepStrip"] = "sleep.png"
        if parsed_anchor is not None:
            pet["gazeAnchor"] = parsed_anchor
        available_outfits = set()
        if wardrobe_path is not None:
            wardrobe, available_outfits, _ = _stage_wardrobe(
                wardrobe_path, outfits_dir, staged, atlas_size
            )
            pet["wardrobe"] = wardrobe
        if activities_path is not None:
            activities, _ = _stage_activities(
                activities_path, activities_dir, staged, available_outfits
            )
            if activities:
                pet["activities"] = activities
        (staged / "pet.json").write_text(
            json.dumps(pet, ensure_ascii=False, indent=2) + "\n"
        )
        if digest(staged / filename) != digest(atlas):
            raise ValueError("Export bytes changed unexpectedly.")
        staged.rename(output)
    members = package_members(pet)
    with zipfile.ZipFile(zip_path, "x", compression=zipfile.ZIP_DEFLATED) as package:
        for member_name in members:
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
        r = deliver(package, package_members(pet), pet["id"], wait)
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
                "--wardrobe",
                type=Path,
                help="Optional wardrobe.json describing outfits and schedule rules.",
            )
            p.add_argument(
                "--outfits-dir",
                type=Path,
                help="Directory containing outfit spritesheets referenced by --wardrobe.",
            )
            p.add_argument(
                "--activities",
                type=Path,
                help="Optional activities.json describing idle activity strips.",
            )
            p.add_argument(
                "--activities-dir",
                type=Path,
                help="Directory containing activity strips referenced by --activities.",
            )
            p.add_argument(
                "--gaze-anchor",
                help="Optional normalized gaze anchor 'x,y' (e.g. '0.5,0.42').",
            )
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
                wardrobe_path=args.wardrobe.resolve() if args.wardrobe else None,
                outfits_dir=args.outfits_dir.resolve() if args.outfits_dir else None,
                activities_path=args.activities.resolve() if args.activities else None,
                activities_dir=args.activities_dir.resolve() if args.activities_dir else None,
                gaze_anchor=args.gaze_anchor,
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
