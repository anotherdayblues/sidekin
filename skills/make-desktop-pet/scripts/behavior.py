#!/usr/bin/env python3
"""Change only a portable pet package's behavior defaults."""

import argparse
import json
import math
from pathlib import Path

CONTRACT = json.loads(
    (
        Path(__file__).resolve().parents[1] / "references/runtime-contract.json"
    ).read_text()
)


def update(
    path,
    minimum=None,
    maximum=None,
    weights=None,
    quiet=False,
    click=None,
    double_click=None,
    no_gaze=False,
):
    pet = json.loads(path.read_text())
    behavior = {**CONTRACT["defaultBehavior"], **pet.get("behavior", {})}
    if minimum is not None:
        behavior["minSeconds"] = minimum
    if maximum is not None:
        behavior["maxSeconds"] = maximum
    if not 5 <= behavior["minSeconds"] <= behavior["maxSeconds"] <= 7200:
        raise ValueError("Intervals must satisfy 5 <= min <= max <= 7200.")
    if weights is not None:
        if any(
            k in {"idle", "running-left", "running-right"}
            or k not in CONTRACT["animations"]
            or not math.isfinite(v)
            or not 0 <= v <= 100
            for k, v in weights.items()
        ):
            raise ValueError(
                "Use existing non-idle actions with finite weights from 0 to 100."
            )
        behavior["weights"] = weights
    behavior["enabled"] = not quiet
    if click:
        behavior["clickAction"] = click
    if double_click:
        behavior["doubleClickAction"] = double_click
    if no_gaze:
        behavior["gaze"] = False
    pet["behavior"] = behavior
    # Preserve the preceding manifest for easy reversal.
    backup = path.with_name("pet.before-behavior.json")
    if not backup.exists():
        backup.write_bytes(path.read_bytes())
    path.write_text(json.dumps(pet, ensure_ascii=False, indent=2) + "\n")
    return behavior


if __name__ == "__main__":
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument("manifest", type=Path)
    p.add_argument("--min", type=float)
    p.add_argument("--max", type=float)
    p.add_argument("--weight", action="append")
    p.add_argument("--quiet", action="store_true")
    p.add_argument("--no-gaze", action="store_true")
    p.add_argument("--click", choices=[*CONTRACT["animations"], "open-studio"])
    p.add_argument("--double-click", choices=CONTRACT["animations"])
    a = p.parse_args()
    try:
        weights = (
            dict(
                (key, float(value))
                for key, value in (item.split("=", 1) for item in a.weight)
            )
            if a.weight
            else None
        )
        print(
            json.dumps(
                update(
                    a.manifest,
                    a.min,
                    a.max,
                    weights,
                    a.quiet,
                    a.click,
                    a.double_click,
                    a.no_gaze,
                ),
                ensure_ascii=False,
                indent=2,
            )
        )
    except ValueError as e:
        raise SystemExit(str(e))
