#!/usr/bin/env python3
"""Measure real motion and registration before an atlas can be exported."""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageChops, ImageStat

CONTRACT = json.loads(
    (
        Path(__file__).resolve().parents[1] / "references/runtime-contract.json"
    ).read_text()
)


def inspect(atlas):
    image = Image.open(atlas).convert("RGBA")
    errors = []
    warnings = []
    rows = {}
    for name, spec in CONTRACT["animations"].items():
        frames = []
        boxes = []
        for col in range(len(spec["durations"])):
            f = image.crop(
                (col * 192, spec["row"] * 208, (col + 1) * 192, (spec["row"] + 1) * 208)
            )
            box = f.getchannel("A").point(lambda a: 255 if a > 16 else 0).getbbox()
            if box is None:
                errors.append(f"{name}: empty frame {col}")
                continue
            boxes.append(box)
            crop = f.crop(box).resize((96, 104), Image.Resampling.LANCZOS)
            bg = Image.new("RGBA", crop.size, "#808080")
            bg.alpha_composite(crop)
            frames.append(bg.convert("RGB"))
        if not frames:
            continue
        changes = [
            sum(ImageStat.Stat(ImageChops.difference(frames[0], f)).mean) / 765
            for f in frames[1:]
        ]
        rows[name] = {
            "bottoms": [b[3] for b in boxes],
            "heights": [b[3] - b[1] for b in boxes],
            "max_registered_change": max(changes, default=0),
        }
        if (
            name in ["running-left", "running-right"]
            and max(changes, default=0) < 0.0005
        ):
            errors.append(
                f"{name}: frames only translate/resize the same pose; no actual gait"
            )
        if (
            name != "jumping"
            and max(rows[name]["bottoms"]) - min(rows[name]["bottoms"]) > 6
        ):
            warnings.append(f"{name}: check ground contact during playback")
    if "jumping" in rows and "idle" in rows:
        feet = rows["jumping"]["bottoms"]
        lift = max(feet) - min(feet)
        landing = abs(feet[-1] - rows["idle"]["bottoms"][0])
        rows["jumping"]["lift"] = lift
        rows["jumping"]["landing_delta"] = landing
        if lift < 8:
            errors.append(f"jumping: visible lift is {lift}px; needs at least 8px")
        if landing > 12:
            errors.append(f"jumping: landing differs from idle by {landing}px")
    return {"ok": not errors, "errors": errors, "warnings": warnings, "rows": rows}


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("atlas", type=Path)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    result = inspect(a.atlas)
    a.output.parent.mkdir(parents=True, exist_ok=True)
    a.output.write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps(result, indent=2))
    raise SystemExit(0 if result["ok"] else 1)
