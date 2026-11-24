"""References and constraints for editing one accepted action; no app data writes."""
import json
from pathlib import Path
from PIL import Image


def source(pet, history, layer, root, contract, name):
    custom = layer.get("actions", {}).get(name)
    base = name in contract["baseActions"]
    if name == "sleep":
        raise ValueError("睡觉保持原样")
    if base and name not in contract["redrawableBaseActions"]:
        raise ValueError("基础动作暂不开放重画，只能重画学会的动作")
    if not base and not custom:
        raise ValueError("只能重画已学会的动作")
    pet_root = (root / "pets" / pet["id"]).resolve()
    if custom:
        path = (pet_root / "custom" / custom["image"]).resolve()
        durations, label = custom["durations"], custom["label"]
        if not path.is_relative_to(pet_root):
            raise ValueError("参考动作应位于宠物文件夹中")
        with Image.open(path) as im:
            strip = im.convert("RGBA")
    else:
        runtime = json.loads((Path(__file__).resolve().parents[2] / "make-desktop-pet/references/runtime-contract.json").read_text())
        animation = runtime["animations"][name]
        durations, label = animation["durations"], contract["baseActions"][name]["label"]
        path = (pet_root / pet["spritesheetPath"]).resolve()
        if not path.is_relative_to(pet_root):
            raise ValueError("宠物图集应位于宠物文件夹中")
        with Image.open(path) as im:
            y = animation["row"] * 208
            strip = im.convert("RGBA").crop((0, y, 192 * len(durations), y + 208))
    if not path.is_relative_to(pet_root):
        raise ValueError("参考动作应位于宠物文件夹中")
    meta = {"action": name, "label": label, "durations": durations,
            "baseVersion": history.get("current", 0)}
    if custom and custom.get("loopFrames"):
        meta["loopFrames"] = custom["loopFrames"]
    return meta, strip


def export(folder, metadata, strip):
    (folder / "references/current-action.png").write_bytes(png(strip))
    (folder / "replacement.json").write_text(json.dumps(metadata, ensure_ascii=False, indent=2) + "\n")


def png(image):
    from io import BytesIO
    buffer = BytesIO()
    image.save(buffer, format="PNG")
    return buffer.getvalue()


PROMPT = '''Modify exactly one existing animation of the reference pet: "{label}".

The attached current-action strip is the currently accepted animation. The identity sheet and idle reference define the same character and its normal proportions. Attach and use ALL these images; a filename in text is not an image attachment. The layout guide is only for spacing and must not appear in the result.

Keep the reference character's exact appearance, head-to-body ratio, body thickness and length, face, markings, materials, palette and style. Change only the requested action. Adapt the movement to the character's existing anatomy; do not add limbs, force a species-specific posture, widen the body or make the head larger. Preserve the action's existing purpose and its original entry, exit and loop behavior. An ongoing working loop must remain a working loop, not become a one-off gesture.

Output exactly {frames} complete full-body frames in one horizontal row on pure {chroma_name} {chroma}. One pose per invisible equal-width slot, with safe padding and clear separation. Use the same apparent scale and baseline as the current-action reference throughout; retain the original motion's intentional vertical displacement where applicable.

Requested motion, frame by frame:
{motion}

Props, only when needed: {props}. Keep a prop simple, attached to or overlapping the character and stable across frames. It must not hide the parts performing the movement or shrink the pet to fit the frame.

Clean extraction: crisp opaque edges. No visible layout lines, text, labels, scenery, ground patches, cast shadows, glow, motion blur, speed lines, detached symbols or effects, or chroma-key colours inside the pet or its prop. The original frame count and playback timings are retained by the delivery script.
'''


def comparison(folder, name, old, new, durations):
    frames = []
    for i in range(len(durations)):
        canvas = Image.new("RGBA", (384, 208), "#edf0f3")
        for x, sheet in ((0, old), (192, new)):
            canvas.alpha_composite(sheet.crop((i * 192, 0, (i + 1) * 192, 208)), (x, 0))
        frames.append(canvas.convert("RGB"))
    out = folder / "qa" / f"{name}-before-after.gif"
    frames[0].save(out, save_all=True, append_images=frames[1:], duration=durations, loop=0)
    return out
