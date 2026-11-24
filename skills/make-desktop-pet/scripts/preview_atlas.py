#!/usr/bin/env python3
"""Render original pixels into GIF previews; never synthesize character art."""

import argparse
import json
from pathlib import Path

from PIL import Image, ImageDraw

CONTRACT = json.loads(
    (
        Path(__file__).resolve().parents[1] / "references/runtime-contract.json"
    ).read_text()
)


def render(atlas, output):
    output.mkdir(parents=True, exist_ok=True)
    image = Image.open(atlas).convert("RGBA")
    if image.size != (1536, 2288):
        raise ValueError("Expected a v2 atlas: 1536 × 2288.")
    sheet = Image.new("RGB", (192 * 5, 238 * 2), "#f4f2e9")
    draw = ImageDraw.Draw(sheet)
    for index, (name, spec) in enumerate(CONTRACT["animations"].items()):
        frames = []
        for col in range(len(spec["durations"])):
            frame = image.crop(
                (col * 192, spec["row"] * 208, (col + 1) * 192, (spec["row"] + 1) * 208)
            )
            background = Image.new("RGB", (192, 208), "#f4f2e9")
            background.paste(frame, (0, 0), frame)
            frames.append(background)
        frames[0].save(
            output / (name + ".gif"),
            save_all=True,
            append_images=frames[1:],
            duration=spec["durations"],
            loop=0,
            disposal=2,
        )
        x, y = index % 5 * 192, index // 5 * 238
        sheet.paste(frames[0], (x, y + 24))
        draw.text((x + 8, y + 5), name, fill="#3e5d4a")
    sheet.save(output / "contact-sheet.png")
    # Include explicit idle -> action -> idle sequences for switching review.
    idle = image.crop((0, 0, 192, 208))
    for name, spec in CONTRACT["animations"].items():
        if name == "idle":
            continue
        sequence = (
            [idle]
            + [
                image.crop(
                    (i * 192, spec["row"] * 208, (i + 1) * 192, (spec["row"] + 1) * 208)
                )
                for i in range(len(spec["durations"]))
            ]
            + [idle]
        )
        frames = []
        for frame in sequence:
            bg = Image.new("RGB", (192, 208), "#f4f2e9")
            bg.paste(frame, (0, 0), frame)
            frames.append(bg)
        frames[0].save(
            output / ("transition-" + name + ".gif"),
            save_all=True,
            append_images=frames[1:],
            duration=[500] + spec["durations"] + [500],
            loop=0,
        )
    return output


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("--atlas", type=Path, required=True)
    p.add_argument("--output", type=Path, required=True)
    a = p.parse_args()
    print(render(a.atlas, a.output))
