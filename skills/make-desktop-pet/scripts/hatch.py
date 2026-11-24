#!/usr/bin/env python3
"""Run pinned Hatch tools with Pet Studio's neutral-frame contract.

Upstream keeps an extra neutral cell at (0, 6). This application uses idle/0
as the neutral frame, leaving all fifteen unused standard cells transparent.
The original vendored source remains unchanged and independently attributable.
"""

import importlib.util
import json
import sys
from pathlib import Path

VENDOR = Path(__file__).resolve().parents[1] / "vendor/hatch-pet/scripts"


def sprite_cuts(source, frame_count):
    """Cut points between sprites, or None when equal slots already fit.

    Upstream mirrors running-right slot by slot. A sprite that crosses its
    slot edge would be split and leave a ghost, so cut in the gaps between
    sprites instead. Strips whose sprites fit their slots keep upstream's
    exact output.
    """
    path = getattr(source, "filename", "")
    if not path:
        return None
    extract = load_tool("extract_strip_frames")
    key = extract.load_chroma_key(Path(path).parent, None)
    keyed = extract.remove_chroma_background(source.convert("RGBA"), key, 96.0)
    groups = extract.component_frame_groups(keyed, frame_count)
    if groups is None:
        return None
    spans = sorted(
        (min(c["bbox"][0] for c in group), max(c["bbox"][2] for c in group))
        for group in groups
    )
    slot = source.width / frame_count
    if all(
        round(index * slot) <= left and right <= round((index + 1) * slot)
        for index, (left, right) in enumerate(spans)
    ):
        return None
    cuts = [0]
    for (_, right), (left, _) in zip(spans, spans[1:]):
        if right > left:
            raise SystemExit(
                "running-right sprites touch each other, so they cannot be "
                "mirrored one by one; regenerate running-right with clear gaps"
            )
        cuts.append((right + left) // 2)
    return cuts + [source.width]


def load_tool(name):
    if not name.replace("_", "").isalnum():
        raise ValueError("Invalid tool name")
    path = VENDOR / (name + ".py")
    if not path.is_file():
        raise ValueError("Unknown bundled tool: " + name)
    sys.path.insert(0, str(VENDOR))
    spec = importlib.util.spec_from_file_location("hatch_" + name, path)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    if hasattr(module, "remove_chroma_background"):
        chroma_remove = module.remove_chroma_background

        def preserve_native_alpha(image, key, threshold):
            if "A" in image.getbands() and image.getchannel("A").getextrema()[0] == 0:
                rgba = image.convert("RGBA")
                # Generated opaque sprites can carry nearly invisible alpha
                # noise in otherwise empty background. Preserve real edges;
                # normalize only the lowest 3% alpha, with no color keying.
                rgba.putdata(
                    [
                        (0, 0, 0, 0) if pixel[3] <= 8 else pixel
                        for pixel in rgba.getdata()
                    ]
                )
                return rgba
            return chroma_remove(image, key, threshold)

        module.remove_chroma_background = preserve_native_alpha
    if name == "extract_strip_frames":

        def registered_components(strip, frame_count):
            if module.component_frame_groups(strip, frame_count) is None:
                return None
            return module.extract_stable_slot_frames(strip, frame_count)

        module.extract_component_frames = registered_components
    if name == "derive_running_left_from_running_right":
        slot_mirror = module.mirror_strip_preserving_frame_order

        def sprite_mirror(source, frame_count=module.RUNNING_FRAME_COUNT):
            cuts = sprite_cuts(source, frame_count)
            if cuts is None:
                return slot_mirror(source, frame_count)
            rgba = source.convert("RGBA")
            mirrored = module.Image.new("RGBA", rgba.size, (0, 0, 0, 0))
            for left, right in zip(cuts, cuts[1:]):
                mirrored.alpha_composite(
                    module.ImageOps.mirror(rgba.crop((left, 0, right, rgba.height))),
                    (left, 0),
                )
            return mirrored

        module.mirror_strip_preserving_frame_order = sprite_mirror
    if hasattr(module, "EXTENDED_NEUTRAL_LOOK_FRAME"):
        module.EXTENDED_NEUTRAL_LOOK_FRAME = (0, 0)
    if hasattr(module, "NEUTRAL_COLUMN_INDEX"):
        module.NEUTRAL_COLUMN_INDEX = 0
    if name == "make_contact_sheet":
        module.frame_count_label = lambda rows, row: f"{module.USED_COUNTS[row]} frames"
    if name == "measure_direction_continuity" and sys.version_info < (3, 10):
        builtin_zip = zip

        def compat_zip(*iterables, strict=False):
            if not strict:
                return builtin_zip(*iterables)
            seqs = [list(it) for it in iterables]
            if seqs and len({len(s) for s in seqs}) != 1:
                raise ValueError("zip() arguments have different lengths")
            return builtin_zip(*seqs)

        module.zip = compat_zip
    if name == "assemble_extended_atlas":
        def load_registration_scale(path):
            data = json.loads(path.read_text(encoding="utf-8"))
            scale = data.get("scale")
            if (
                not isinstance(scale, (int, float))
                or isinstance(scale, bool)
                or scale <= 0
            ):
                raise SystemExit(f"registration manifest has invalid scale: {scale!r}")
            return float(scale)

        module.load_registration_scale = load_registration_scale
        module.paste_neutral_cell = lambda atlas, neutral: None
        original = module.write_manifest

        def manifest(path, atlas_path):
            original(path, atlas_path)
            data = json.loads(path.read_text())
            data["spritesheetLayout"]["neutralLookFrame"] = {
                "rowIndex": 0,
                "columnIndex": 0,
            }
            path.write_text(json.dumps(data, indent=2) + "\n")

        module.write_manifest = manifest
    return module


if __name__ == "__main__":
    if len(sys.argv) < 2:
        raise SystemExit("Usage: hatch.py <tool_name_without_py> [tool arguments]")
    name = sys.argv.pop(1)
    load_tool(name).main()
