#!/usr/bin/env python3
"""Align state families with one uniform scale/translation per state.

Each state's first frame is its transition reference. Its full height must
represent the same neutral body construction, so inspect the reference sheet.
Within-state motion, including airborne displacement, is left intact.
"""

import argparse
import json
from pathlib import Path

from PIL import Image


def bounds(image):
    return image.getchannel("A").point(lambda a: 255 if a > 16 else 0).getbbox()


def anchor(image, box):
    bottom_band = image.getchannel("A").crop(
        (0, box[1] + int((box[3] - box[1]) * 0.7), 192, box[3])
    )
    band = bottom_band.point(lambda a: 255 if a > 16 else 0).getbbox()
    return ((band[0] + band[2]) / 2, box[3])


def register(source, output):
    families = {}
    limits = [150.0]
    for directory in sorted(source.iterdir()):
        if not directory.is_dir():
            continue
        files = sorted(directory.glob("*.png"))
        if not files:
            continue
        images = [Image.open(p).convert("RGBA") for p in files]
        box = bounds(images[0])
        ax, ay = anchor(images[0], box)
        height = box[3] - box[1]
        for image in images:
            b = bounds(image)
            for extent, room in [
                (ax - b[0], 90),
                (b[2] - ax, 90),
                (ay - b[1], 190),
                (b[3] - ay, 6),
            ]:
                if extent > 0:
                    limits.append(room * height / extent)
        families[directory.name] = (files, images, ax, ay, height)
    target_height = min(limits) * 0.98
    if target_height < 60:
        raise ValueError(
            "Large registration drift; repair source rows instead of shrinking the pet."
        )
    report = {
        "target_reference_height": target_height,
        "anchor": [96, 198],
        "states": {},
    }
    output.mkdir(parents=True, exist_ok=True)
    for state, (files, images, ax, ay, height) in families.items():
        scale = target_height / height
        target = output / state
        target.mkdir(exist_ok=True)
        for path, image in zip(files, images):
            resized = image.resize(
                (round(image.width * scale), round(image.height * scale)),
                Image.Resampling.LANCZOS,
            )
            frame = Image.new("RGBA", (192, 208))
            frame.alpha_composite(
                resized, (round(96 - ax * scale), round(198 - ay * scale))
            )
            frame.save(target / path.name)
        report["states"][state] = {
            "scale": scale,
            "source_anchor": [ax, ay],
            "reference_height": height,
        }
    manifest = source / "frames-manifest.json"
    if manifest.exists():
        data = json.loads(manifest.read_text())

        def rewrite(value):
            if isinstance(value, str):
                return value.replace(str(source.resolve()), str(output.resolve()))
            if isinstance(value, list):
                return [rewrite(v) for v in value]
            if isinstance(value, dict):
                return {k: rewrite(v) for k, v in value.items()}
            return value

        (output / "frames-manifest.json").write_text(
            json.dumps(rewrite(data), indent=2) + "\n"
        )
    (output / "registration.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--frames", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    print(json.dumps(register(a.frames, a.output), indent=2))
