#!/usr/bin/env python3
"""Teach an installed Pet Studio pet new actions and rules.

Builds a teaching folder (teaching.json + action strips), checks it with the
same limits the app uses, and hands it to the running app's inbox. The app
shows it as a draft; nothing changes until the user accepts it there.
"""

import argparse
import json
import math
import re
import sys
from pathlib import Path

from PIL import Image, ImageDraw
import action_edit

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deliver import Refused, data_dir, deliver, ensure_safe_work_dir  # noqa: E402

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "vendor"))
from despill_chroma_edges import decontaminate_image  # noqa: E402

SKILL = Path(__file__).resolve().parents[1]
CONTRACT = json.loads((SKILL / "references/teaching-contract.json").read_text())
LIMITS = CONTRACT["limits"]
BASE = CONTRACT["baseActions"]
CELL_W, CELL_H = CONTRACT["cellWidth"], CONTRACT["cellHeight"]
ID = re.compile(CONTRACT["idPattern"])
EVENT_WORDS = {
    "click": "单击它",
    "double-click": "双击它",
    "hover": "鼠标移到它身上",
    "drag": "拖动它的时候",
    "drop": "拖动后放下",
    "appear": "它出现在桌面上",
    "focus-start": "开始专注时",
    "focus-done": "专注完成时",
    "break-start": "开始休息时",
}
WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"]


class Problem(Exception):
    pass


def read(path, default=None):
    try:
        return json.loads(Path(path).read_text())
    except (OSError, ValueError):
        if default is None:
            raise
        return default


def write(path, value):
    Path(path).write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


# ---------- installed pets ----------


def installed(pet_id):
    root = data_dir() / "pets" / pet_id
    if not (root / "pet.json").is_file():
        known = ", ".join(p["id"] for p in all_pets()) or "无"
        raise Problem(f"随伴里没有编号为 {pet_id} 的宠物。已安装：{known}")
    pet = read(root / "pet.json")
    current_path = root / "custom/action-library.json"
    try:
        current = read(current_path) if current_path.exists() else {}
    except (OSError, ValueError) as error:
        raise Problem("当前动作资料读不出来，请先在随伴里检查。") from error
    if current:
        history = {"current": current["revision"], "versions": []}
        layer = current["layer"]
    else:
        history = read(root / "custom/history.json", {"current": 0, "versions": []})
        layer = {"actions": {}, "rules": []}
        if history.get("current"):
            layer = read(root / f"custom/versions/{history['current']}.json")
    return pet, history, layer


def all_pets():
    root = data_dir() / "pets"
    if not root.is_dir():
        return []
    return [
        read(p / "pet.json")
        for p in sorted(root.iterdir())
        if (p / "pet.json").is_file()
    ]


# ---------- rules: validation and plain-language description ----------


def label(name, layer):
    if name in layer.get("actions", {}):
        return layer["actions"][name]["label"]
    return BASE.get(name, {}).get("label", name)


def describe(rule, layer):
    w = rule["when"]
    kind = w["type"]
    if kind == "clock":
        if w["at"] == "*:00":
            when = "每个整点"
        elif w["at"].startswith("*"):
            when = f"每小时的第 {int(w['at'][2:])} 分钟"
        else:
            when = f"每天 {w['at']}"
        days = sorted(w.get("days") or range(7))
        if days == [1, 2, 3, 4, 5]:
            when += "（工作日）"
        elif days == [0, 6]:
            when += "（周末）"
        elif len(days) < 7:
            when += "（" + "、".join(WEEKDAYS[d] for d in days) + "）"
    elif kind == "every":
        when = f"每隔 {w['minutes']:g} 分钟"
    elif kind == "random":
        when = f"随机出现（权重 {w['weight']:g}）"
    elif kind == "event":
        when = EVENT_WORDS.get(w["event"], w["event"])
    elif kind == "pet-idle":
        when = f"没有碰宠物 {w['minutes']:g} 分钟后"
    elif kind == "idle":
        when = f"电脑闲置 {w['minutes']:g} 分钟后"
    else:
        when = f"连续使用电脑 {w['minutes']:g} 分钟后"
    chance = rule.get("chance")
    if chance is not None and chance < 1:
        when += f" · {round(chance * 100)}% 的机会"
    steps = " → ".join(
        f"停 {s['wait'] / 1000:g} 秒"
        if "wait" in s
        else label(s["play"], layer)
        + (f" ×{s['repeat']}" if s.get("repeat", 1) > 1 else "")
        for s in rule["do"]
    )
    return f"{when}：{steps}"


def number(value, low, high):
    return (
        isinstance(value, (int, float))
        and not isinstance(value, bool)
        and math.isfinite(value)
        and low <= value <= high
    )


def check_action(name, action):
    if not ID.match(name) or (name in BASE and name not in CONTRACT["replaceableBaseActions"]):
        raise Problem(f"动作名 {name} 无效或与基础动作重名；用小写字母、数字和连字符")
    if set(action) - {"loopFrames"} != {"label", "image", "durations"}:
        raise Problem(f"动作 {name} 只能有 label、image、durations")
    if not 1 <= len(action["label"].strip()) <= LIMITS["maxLabel"]:
        raise Problem(f"动作 {name} 需要 1–{LIMITS['maxLabel']} 字的中文名")
    d = action["durations"]
    if name in BASE and action.get("loopFrames"):
        raise Problem("基础动作替换应保留原循环方式")
    if "loopFrames" in action:
        bounds = action["loopFrames"]
        if not (isinstance(bounds, list) and len(bounds) == 2
                and all(type(v) is int for v in bounds)
                and 1 < bounds[0] < bounds[1] < len(d)):
            raise Problem("循环段至少两帧，前后各留一帧，帧号从 1 开始")
    if not 1 <= len(d) <= LIMITS["maxFrames"] or not all(
        isinstance(ms, int) and LIMITS["minFrameMs"] <= ms <= LIMITS["maxFrameMs"]
        for ms in d
    ):
        raise Problem(
            f"动作 {name} 应有 1–{LIMITS['maxFrames']} 帧，每帧 "
            f"{LIMITS['minFrameMs']}–{LIMITS['maxFrameMs']} 毫秒的整数"
        )


def check_rule(rule, actions):
    rid = rule.get("id", "")
    allowed = {"id", "label", "enabled", "when", "do", "chance", "cooldownMinutes"}
    if not ID.match(rid) or not set(rule) <= allowed:
        raise Problem(
            f"规则 {rid or '?'}：编号无效，或含有未知字段 {sorted(set(rule) - allowed)}"
        )
    if not 1 <= len(str(rule.get("label", "")).strip()) <= LIMITS["maxLabel"]:
        raise Problem(f"规则 {rid} 需要 1–{LIMITS['maxLabel']} 字的说明")
    w = rule.get("when", {})
    kind, fields = w.get("type"), set(w) - {"type"}
    ok = False
    if kind == "clock":
        at = w.get("at", "")
        ok = (
            bool(re.fullmatch(r"(\*|[01]\d|2[0-3]):[0-5]\d", at))
            and fields <= {"at", "days", "windowMinutes"}
            and all(isinstance(d, int) and 0 <= d <= 6 for d in w.get("days", [0]))
            and w.get("days", [0]) != []
            and number(w.get("windowMinutes", 30), 1, 720)
        )
    elif kind == "pet-idle":
        ok = ("minutes" in fields and fields <= {"minutes", "includeDefaultSleep"}
              and number(w["minutes"], 0.001, LIMITS["maxMinutes"])
              and isinstance(w.get("includeDefaultSleep", False), bool))
    elif kind in ("every", "idle", "active"):
        ok = fields == {"minutes"} and number(w["minutes"], 0.001, LIMITS["maxMinutes"])
    elif kind == "random":
        ok = fields == {"weight"} and number(w["weight"], 0.001, 100)
    elif kind == "event":
        ok = fields == {"event"} and w["event"] in CONTRACT["events"]
    if not ok:
        raise Problem(f"规则 {rid} 的触发条件无效：{json.dumps(w, ensure_ascii=False)}")
    steps = rule.get("do", [])
    if not 1 <= len(steps) <= LIMITS["maxSteps"]:
        raise Problem(f"规则 {rid} 应有 1–{LIMITS['maxSteps']} 步")
    for s in steps:
        if set(s) <= {"play", "repeat"} and "play" in s:
            if s["play"] not in BASE and s["play"] not in actions:
                raise Problem(f"规则 {rid} 用到了不存在的动作 {s['play']}")
            if not number(s.get("repeat", 1), 1, LIMITS["maxRepeat"]) or not isinstance(
                s.get("repeat", 1), int
            ):
                raise Problem(
                    f"规则 {rid} 的 repeat 应为 1–{LIMITS['maxRepeat']} 的整数"
                )
        elif set(s) == {"wait"}:
            if (
                not isinstance(s["wait"], int)
                or not 1 <= s["wait"] <= LIMITS["maxWaitMs"]
            ):
                raise Problem(f"规则 {rid} 的 wait 应为 1–{LIMITS['maxWaitMs']} 毫秒")
        else:
            raise Problem(
                f'规则 {rid} 的每一步写成 {{"play": 动作}} 或 {{"wait": 毫秒}}'
            )
    if kind == "event" and w["event"] == "drag" and "play" not in steps[0]:
        raise Problem(f"规则 {rid}：拖动时的第一步必须是动作")
    if "chance" in rule and not number(rule["chance"], 0.0001, 1):
        raise Problem(f"规则 {rid} 的 chance 应在 0–1 之间")
    if "cooldownMinutes" in rule and not number(
        rule["cooldownMinutes"], 0, LIMITS["maxMinutes"]
    ):
        raise Problem(f"规则 {rid} 的 cooldownMinutes 无效")
    if "enabled" in rule and not isinstance(rule["enabled"], bool):
        raise Problem(f"规则 {rid} 的 enabled 应为 true 或 false")


def check_plan_rule(rule, actions):
    """A new rule plays one learned action once: on a double-click, now and
    then at random, or at a time each day (optionally weekdays only)."""
    rid = rule.get("id", "?")
    w, steps = rule.get("when", {}), rule.get("do", [])
    step = steps[0] if len(steps) == 1 else {}
    play = step.get("play")
    learned = play and play != "sleep" and play not in BASE and play in actions
    single = learned and set(step) <= {"play", "repeat"} and step.get("repeat", 1) == 1
    kind = w.get("type")
    when_ok = (
        (kind == "event" and w.get("event") == "double-click")
        or kind == "random"
        or (kind == "clock" and not str(w.get("at", "")).startswith("*")
            and set(w) <= {"type", "at", "days"}
            and w.get("days", [1, 2, 3, 4, 5]) == [1, 2, 3, 4, 5])
    )
    if not (single and when_ok and not set(rule) & {"chance", "cooldownMinutes"}
            and rule.get("enabled", True)):
        raise Problem(
            f"规则 {rid}：学会的动作只能双击时做、随机出现，或每天定时（可只在工作日），"
            "每条规则播一个学会的动作一次，不写 chance 和 cooldownMinutes"
        )


def check_replacements(teaching, layer):
    replacements = teaching.get("replaceActions", [])
    for name, action in teaching["actions"].items():
        if name in BASE and name not in replacements:
            raise Problem("替换基础动作请用 new --replace 开始")
        old = layer.get("actions", {}).get(name)
        ongoing = old and old.get("loopFrames") and name not in replacements
        if old and (name == "sleep" or ongoing) and old != action:
            raise Problem("睡觉和持续动作保持原样；要重画请用 new --replace")
    if not replacements:
        return
    if (len(set(replacements)) != len(replacements) or set(replacements) != set(teaching["actions"])
            or teaching["rules"] or any(teaching["remove"].values()) or "baseVersion" not in teaching):
        raise Problem("修改动作包只包含选定动作，不改触发规则")
    pet, history, current = installed(teaching["petId"])
    if history.get("current", 0) != teaching["baseVersion"]:
        raise Problem("参考动作版本已变化，请重新导出后制作")
    for name in replacements:
        try:
            info, _ = action_edit.source(pet, history, current, data_dir(), CONTRACT, name)
        except ValueError as e:
            raise Problem(str(e))
        action = teaching["actions"][name]
        if (action.get("loopFrames") != info.get("loopFrames")
                or action["durations"] != info["durations"]):
            raise Problem("修改动作应保留原来的帧数、播放节奏和循环段")


def merged(teaching, layer):
    check_replacements(teaching, layer)
    out = {
        "actions": dict(layer.get("actions", {})),
        "rules": list(layer.get("rules", [])),
    }
    for name in teaching["remove"]["actions"]:
        if out["actions"].pop(name, None) is None:
            raise Problem(f"要删除的动作 {name} 不存在")
    for rid in teaching["remove"]["rules"]:
        if not any(r["id"] == rid for r in out["rules"]):
            raise Problem(f"要删除的规则 {rid} 不存在")
        out["rules"] = [r for r in out["rules"] if r["id"] != rid]
    out["actions"].update(teaching["actions"])
    for rule in teaching["rules"]:
        check_plan_rule(rule, out["actions"])
        ids = [r["id"] for r in out["rules"]]
        if rule["id"] in ids:
            out["rules"][ids.index(rule["id"])] = rule
        else:
            out["rules"].append(rule)
    if (
        len(out["actions"]) > LIMITS["maxActions"]
        or len(out["rules"]) > LIMITS["maxRules"]
    ):
        raise Problem(
            f"最多 {LIMITS['maxActions']} 个自定义动作、{LIMITS['maxRules']} 条规则"
        )
    for name, action in out["actions"].items():
        check_action(name, action)
    for rule in out["rules"]:
        check_rule(rule, out["actions"])
    return out


def check_strip(folder, name, action):
    path = (folder / action["image"]).resolve()
    if not path.is_relative_to(folder.resolve()) or not path.is_file():
        raise Problem(f"动作 {name} 的图片 {action['image']} 不在新本领包里")
    if path.stat().st_size > LIMITS["maxImageBytes"]:
        raise Problem(f"动作 {name} 的图片超过 4 MiB")
    with Image.open(path) as im:
        frames = len(action["durations"])
        if im.format not in ("PNG", "WEBP") or im.size != (CELL_W * frames, CELL_H):
            raise Problem(
                f"动作 {name} 应为 PNG/WebP、{CELL_W * frames} × {CELL_H}；实际 {im.format} {im.size}"
            )
        alpha = im.convert("RGBA").getchannel("A")
        for f in range(frames):
            if alpha.crop((f * CELL_W, 0, (f + 1) * CELL_W, CELL_H)).getbbox() is None:
                raise Problem(f"动作 {name} 第 {f + 1} 帧是空的")


def load_teaching(folder):
    folder = Path(folder)
    t = read(folder / "teaching.json")
    if t.get("kind") != "pet-teaching" or t.get("schemaVersion") != 1:
        raise Problem("teaching.json 不是随伴的新本领包")
    t.setdefault("actions", {})
    t.setdefault("rules", [])
    t.setdefault("remove", {"actions": [], "rules": []})
    t["remove"].setdefault("actions", [])
    t["remove"].setdefault("rules", [])
    return t


def check(folder):
    folder = Path(folder)
    t = load_teaching(folder)
    if not 1 <= len(t.get("summary", "").strip()) <= LIMITS["maxSummary"]:
        raise Problem("summary 应为 1–200 字，写给用户看的一句话")
    _, _, layer = installed(t["petId"])
    if not (
        t["actions"] or t["rules"] or t["remove"]["actions"] or t["remove"]["rules"]
    ):
        raise Problem("这个包还没有任何改动")
    result = merged(t, layer)
    for name, action in t["actions"].items():
        check_strip(folder, name, action)
    for rule in t["rules"]:
        uses = {s.get("play") for s in rule["do"]} - {None}
        if not uses & (set(t["actions"]) | set(BASE) | set(layer["actions"])):
            raise Problem(f"规则 {rule['id']} 没有可播放的动作")
    return t, result


# ---------- action strips ----------


def chroma_of(path):
    with Image.open(path) as im:
        rgb = im.convert("RGB")
        w, h = rgb.size
        corners = [
            rgb.getpixel(p) for p in [(2, 2), (w - 3, 2), (2, h - 3), (w - 3, h - 3)]
        ]
    return tuple(round(sum(c[i] for c in corners) / 4) for i in range(3))


def remove_background(image, key, threshold=96):
    """Keep native alpha; otherwise clear the flat key colour like the Hatch Pet pipeline."""
    rgba = image.convert("RGBA")
    if rgba.getchannel("A").getextrema()[0] < 250:
        return rgba, "alpha"
    data = bytearray(rgba.tobytes())
    for i in range(0, len(data), 4):
        if math.dist(data[i : i + 3], key) <= threshold:
            data[i : i + 4] = b"\0\0\0\0"
    return Image.frombytes("RGBA", rgba.size, bytes(data)), "chroma"


def pose_groups(rgba, frames, min_gap=4):
    """Left-to-right pose groups split by fully transparent columns."""
    w, h = rgba.size
    alpha = rgba.getchannel("A").point(lambda v: 255 if v > 32 else 0)
    cols = [alpha.crop((x, 0, x + 1, h)).getbbox() is not None for x in range(w)]
    runs, start, gap = [], None, 0
    for x, filled in enumerate(cols + [False] * (min_gap + 1)):
        if filled:
            if start is None:
                start = x
            gap, end = 0, x
        elif start is not None:
            gap += 1
            if gap >= min_gap:
                runs.append([start, end + 1])
                start = None
    runs = [r for r in runs if r[1] - r[0] >= 6]
    if len(runs) != frames:
        return None
    groups = []
    for x0, x1 in runs:
        box = alpha.crop((x0, 0, x1, h)).getbbox()
        groups.append((x0, box[1], x1, box[3]))
    return groups


def solid_box(image):
    """Bounding box of clearly visible pixels, ignoring faint edge haze."""
    return image.getchannel("A").point(lambda v: 255 if v > 32 else 0).getbbox()


def idle_cell(pet_id):
    pet, _, _ = installed(pet_id)
    path = data_dir() / "pets" / pet_id / pet["spritesheetPath"]
    with Image.open(path) as sheet:
        return sheet.convert("RGBA").crop((0, 0, CELL_W, CELL_H))


def build_strip(strip_path, pet_id, frames, chroma=None, fit=False, equal_slots=False, anchor=None):
    with Image.open(strip_path) as raw:
        key = chroma or chroma_of(strip_path)
        rgba, mode = remove_background(raw, key)
    slot = rgba.width / frames
    groups = pose_groups(rgba, frames)
    notes = []
    if groups is None:
        if not equal_slots:
            raise Problem(
                f"在生成图里找不到 {frames} 个分开的姿势。请重新生成，让每个姿势之间留出明显空隙；"
                "确认原图的姿势确实整齐地各占一格时，才加 --equal-slots"
            )
        notes.append("按等宽格子切分")
        groups = []
        for i in range(frames):
            box = rgba.crop(
                (round(i * slot), 0, round((i + 1) * slot), rgba.height)
            ).getbbox()
            if box is None:
                raise Problem(f"第 {i + 1} 格是空的")
            groups.append(
                (round(i * slot) + box[0], box[1], round(i * slot) + box[2], box[3])
            )
    idle = anchor if anchor is not None else idle_cell(pet_id)
    ib = solid_box(idle)
    idle_h, idle_cx, idle_bottom = ib[3] - ib[1], (ib[0] + ib[2]) / 2, ib[3]
    first = groups[0]
    scale = idle_h / (first[3] - first[1])
    ground = first[3]
    first_offset = (first[0] + first[2]) / 2 - slot / 2

    def placements(s):
        out = []
        for i, (x0, y0, x1, y1) in enumerate(groups):
            offset = (x0 + x1) / 2 - (i + 0.5) * slot - first_offset
            w, h = max(1, round((x1 - x0) * s)), max(1, round((y1 - y0) * s))
            left = round(idle_cx + offset * s - w / 2)
            top = round(idle_bottom - (ground - y0) * s)
            out.append((left, top, w, h))
        return out

    boxes = placements(scale)
    outside = [
        i + 1
        for i, (left, top, w, h) in enumerate(boxes)
        if left < 0 or top < 0 or left + w > CELL_W or top + h > CELL_H
    ]
    if outside:
        if not fit:
            raise Problem(
                f"第 {', '.join(map(str, outside))} 帧按待机大小放进 192×208 后会被裁切。"
                "让动作幅度小一点重新生成；或加 --fit 整体缩小（宠物会比平时小）"
            )
        need = 1.0
        for left, top, w, h in boxes:
            for extent, limit in [
                (idle_cx - left, idle_cx),
                (left + w - idle_cx, CELL_W - idle_cx),
                (idle_bottom - top, idle_bottom),
            ]:
                if extent > limit:
                    need = min(need, limit / extent)
        scale *= need * 0.98
        boxes = placements(scale)
        notes.append(f"为放进格子整体缩小到 {need * 0.98:.0%}")
    out = Image.new("RGBA", (CELL_W * frames, CELL_H))
    for i, ((x0, y0, x1, y1), (left, top, w, h)) in enumerate(zip(groups, boxes)):
        pose = rgba.crop((x0, y0, x1, y1)).resize((w, h), Image.Resampling.LANCZOS)
        cell = Image.new("RGBA", (CELL_W, CELL_H))
        cell.alpha_composite(
            pose, (max(0, left), max(0, top)), (max(0, -left), max(0, -top))
        )
        out.paste(cell, (i * CELL_W, 0))
    if mode == "chroma":
        # Same edge-local spill suppression as the official pipeline, run once.
        out, _ = decontaminate_image(out, chroma_key=key)
    for i, label_ in [(0, "第一帧"), (frames - 1, "最后一帧")]:
        box = solid_box(out.crop((i * CELL_W, 0, (i + 1) * CELL_W, CELL_H)))
        h = box[3] - box[1]
        if abs(h - idle_h) / idle_h > 0.15 or abs(box[3] - idle_bottom) > 6:
            notes.append(f"{label_}和待机姿势差别较大，切换时可能跳一下")
    return out, {"background": mode, "scale": round(scale, 3), "notes": notes}


def previews(strip, durations, pet_id, out_dir, name, loop_frames=None):
    """GIF with idle before and after (transition check) and a contact sheet."""
    out_dir.mkdir(parents=True, exist_ok=True)
    idle = idle_cell(pet_id)
    frames = [
        strip.crop((i * CELL_W, 0, (i + 1) * CELL_W, CELL_H))
        for i in range(len(durations))
    ]
    bg = (238, 241, 232, 255)

    def on_bg(cell):
        canvas = Image.new("RGBA", (CELL_W, CELL_H), bg)
        canvas.alpha_composite(cell)
        return canvas.resize(
            (CELL_W * 2, CELL_H * 2), Image.Resampling.LANCZOS
        ).convert("RGB")

    sequence = [idle] + frames + [idle]
    times = [600] + list(durations) + [600]
    gif = out_dir / f"{name}.gif"
    if loop_frames:
        first, last = loop_frames
        sample = frames[:last] + frames[first-1:last] * 2 + frames[last:]
        times = [600] + durations[:last] + durations[first-1:last] * 2 + durations[last:] + [600]
    else:
        sample = frames
    images = [on_bg(c) for c in [idle] + sample + [idle]]
    images[0].save(gif, save_all=True, append_images=images[1:], duration=times, loop=0)
    sheet = Image.new("RGB", (CELL_W * len(sequence), CELL_H + 22), bg[:3])
    draw = ImageDraw.Draw(sheet)
    for i, cell in enumerate(sequence):
        sheet.paste(
            Image.alpha_composite(Image.new("RGBA", cell.size, bg), cell).convert(
                "RGB"
            ),
            (i * CELL_W, 22),
        )
        draw.text(
            (i * CELL_W + 6, 4),
            "idle" if i in (0, len(sequence) - 1) else str(i),
            fill=(80, 90, 80),
        )
    contact = out_dir / f"{name}-sheet.png"
    sheet.save(contact)
    return gif, contact


def layout_guide(path, frames):
    w = CELL_W * 2
    image = Image.new("RGB", (w * frames, CELL_H * 2), "#f7f7f7")
    draw = ImageDraw.Draw(image)
    for i in range(frames):
        x = i * w
        draw.rectangle((x, 0, x + w - 1, CELL_H * 2 - 1), outline="#111111", width=2)
        draw.rectangle(
            (x + 24, 24, x + w - 25, CELL_H * 2 - 25), outline="#2f80ed", width=2
        )
        draw.line((x + w // 2, 24, x + w // 2, CELL_H * 2 - 25), fill="#b8b8b8")
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path)


PROMPT = """Create one horizontal animation strip for the desktop pet "{name}": a new action called "{label}".

Use the attached reference images for identity: the same character in every frame, with the same face, proportions, markings, palette, material, style and size. Use the attached layout guide only for slot count, spacing, centering and padding; do not draw the guide.

Output exactly {frames} full-body frames in one left-to-right row on a perfectly flat pure {chroma_name} {chroma} background. One complete pose per invisible equal-width slot, evenly spaced, with clear empty background between neighbouring poses. No overlap, clipping, empty slots, labels or borders.

Action, in order across the frames:
{motion}

Continuity: the first frame and the last frame are the character's normal calm standing pose, matching the attached idle frame in pose, scale and ground position, so the action starts and ends seamlessly from idle. Keep the same scale and the same ground line across the whole row; move the pose inside its slot instead of drawing the character bigger or smaller.

Props: a prop is allowed only when the action needs it ({props}). It must touch or be held by the character, be opaque, sit inside the same slot, and stay readable at 192x208. No other objects.

Clean extraction: crisp opaque edges, safe padding. No scenery, floor, text, speech bubbles, shadows, glows, motion blur, speed lines, sparkles, floating symbols, detached effects, or {chroma_name} and similar colours inside the character or props.
"""


# ---------- commands ----------


def cmd_pets(a):
    pets = all_pets()
    if not pets:
        print(f"随伴里还没有宠物（{data_dir()}）。先用 $make-desktop-pet 制作并导入。")
        return
    drafts = data_dir() / "drafts"
    for p in pets:
        _, history, layer = installed(p["id"])
        print(
            f"{p['displayName']}  编号 {p['id']}  已学会 {len(layer['actions'])} 个动作、{len(layer['rules'])} 条安排"
        )
        if p.get("sleepStrip") or p["id"] == "lizi" or layer["actions"].get("sleep", {}).get("loopFrames"):
            settings = read(data_dir() / "settings.json", {})
            minutes = settings.get("behaviors", {}).get(p["id"], {}).get("napMinutes", 10)
            competing = [r for r in layer["rules"] if r.get("enabled", True)
                         and r["when"].get("type") == "pet-idle" and r["when"].get("minutes") == minutes]
            if not competing or any(r["when"].get("includeDefaultSleep") for r in competing):
                print(f"  默认睡觉：{minutes} 分钟没碰宠物，点它才醒")
        for name, act in layer["actions"].items():
            print(f"  动作 {name}：{act['label']}，{len(act['durations'])} 帧")
        for rule in layer["rules"]:
            state = "" if rule.get("enabled", True) else "（已停用）"
            print(
                f"  规则 {rule['id']}：{rule['label']}{state} — {describe(rule, layer)}"
            )
        if drafts.is_dir():
            for d in sorted(drafts.iterdir()):
                t = read(d / "teaching.json", {})
                if not d.name.startswith(".") and t.get("petId") == p["id"]:
                    print(f"  待确认草稿：{t.get('summary')}")
    print("\n基础动作：" + "、".join(f"{k}（{v['label']}）" for k, v in BASE.items()))


def cmd_new(a):
    pet, history, layer = installed(a.pet)
    replacement = None
    if a.replace:
        try:
            replacement = action_edit.source(pet, history, layer, data_dir(), CONTRACT, a.replace)
        except ValueError as e:
            raise Problem(str(e))
    try:
        folder = ensure_safe_work_dir(a.dir, SKILL)
    except ValueError as e:
        raise Problem(str(e))
    if folder.exists() and any(folder.iterdir()):
        raise Problem(f"{folder} 不是空文件夹")
    (folder / "references").mkdir(parents=True, exist_ok=True)
    idle = idle_cell(a.pet)
    idle.save(folder / "references/idle.png")
    idle.resize((CELL_W * 2, CELL_H * 2), Image.Resampling.LANCZOS).save(
        folder / "references/idle-2x.png"
    )
    path = data_dir() / "pets" / a.pet / pet["spritesheetPath"]
    with Image.open(path) as sheet:
        # Identity sheet: one frame from each standard row.
        sheet = sheet.convert("RGBA")
        cells = [
            sheet.crop((0, v["row"] * CELL_H, CELL_W, (v["row"] + 1) * CELL_H))
            for v in BASE.values()
        ]
    strip = Image.new("RGBA", (CELL_W * len(cells), CELL_H))
    for i, c in enumerate(cells):
        strip.alpha_composite(c, (i * CELL_W, 0))
    strip.save(folder / "references/identity.png")
    write(
        folder / "teaching.json",
        {
            "kind": "pet-teaching",
            "schemaVersion": 1,
            "petId": a.pet,
            "summary": a.summary,
            "actions": {},
            "rules": [],
            "remove": {"actions": [], "rules": []},
        },
    )
    if replacement:
        metadata, current_strip = replacement
        action_edit.export(folder, metadata, current_strip)
        t = load_teaching(folder)
        t.update({"replaceActions": [a.replace], "baseVersion": metadata["baseVersion"]})
        write(folder / "teaching.json", t)
    print(
        json.dumps(
            {
                "dir": str(folder.resolve()),
                "pet": pet["displayName"],
                "description": pet.get("description", ""),
                "references": [
                    str((folder / "references" / n).resolve())
                    for n in (("idle-2x.png", "identity.png", "current-action.png") if replacement else ("idle-2x.png", "identity.png"))
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_prompt(a):
    folder = Path(a.dir)
    t = load_teaching(folder)
    pet, _, _ = installed(t["petId"])
    editing = bool(t.get("replaceActions"))
    if editing and t["replaceActions"] != [a.name]:
        raise Problem("本次只修改选定的原动作编号")
    if not ID.match(a.name) or (a.name in BASE and not editing):
        raise Problem("基础动作请用 new --replace 开始")
    if editing and a.frames != len(read(folder / "replacement.json")["durations"]):
        raise Problem("保留原动作的帧数")
    if not (1 if editing else 3) <= a.frames <= LIMITS["maxFrames"]:
        raise Problem(f"新动作用 3–{LIMITS['maxFrames']} 帧")
    names = {
        "#FF00FF": "magenta",
        "#00FF00": "green",
        "#00FFFF": "cyan",
        "#0000FF": "blue",
    }
    prompt = (action_edit.PROMPT if editing else PROMPT).format(
        name=pet["displayName"],
        label=a.label,
        frames=a.frames,
        motion=a.motion.strip(),
        chroma=a.chroma.upper(),
        chroma_name=names.get(a.chroma.upper(), "key-colour"),
        props=a.props or "none for this action",
    )
    if editing and a.name == "running" and a.work_row == "laptop":
        prompt += "\nQuiet study experiment: Keep the head and torso almost still. Use tiny but readable alternating operating movements, a small blink, and attention toward the task so it is clearly studying. No body bouncing, swaying, large nods or energetic typing. Respect the user's chosen activity and prop instead of forcing a particular species or device. The first and last frames join calmly for a quiet ongoing loop.\n"
    (folder / "prompts").mkdir(exist_ok=True)
    out = folder / "prompts" / f"{a.name}.md"
    out.write_text(prompt)
    guide = folder / "references" / f"layout-{a.frames}.png"
    layout_guide(guide, a.frames)
    t.setdefault("notes", {})[a.name] = {
        "chroma": a.chroma.upper(),
        "frames": a.frames,
        "prompt": f"prompts/{a.name}.md",
    }
    write(folder / "teaching.json", t)
    print(
        json.dumps(
            {
                "prompt_file": str(out.resolve()),
                "input_images": [
                    {
                        "path": str((folder / "references/idle-2x.png").resolve()),
                        "role": "idle frame: identity, scale, and the start/end pose",
                    },
                    {
                        "path": str((folder / "references/identity.png").resolve()),
                        "role": "identity sheet: the same character in its standard poses",
                    },
                    *([{ "path": str((folder / "references/current-action.png").resolve()), "role": "currently accepted complete action: existing pose, proportions, sequence and loop" }] if editing else []),
                    {
                        "path": str(guide.resolve()),
                        "role": f"layout guide for {a.frames} slots; spacing only, never draw it",
                    },
                ],
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_add_action(a):
    folder = Path(a.dir)
    t = load_teaching(folder)
    note = t.get("notes", {}).get(a.name, {})
    editing = bool(t.get("replaceActions"))
    metadata = read(folder / "replacement.json") if editing else None
    loop = metadata.get("loopFrames") if editing else None
    if editing and (t["replaceActions"] != [a.name] or a.label != metadata["label"]
                    or (a.loop_frames and a.loop_frames != loop)):
        raise Problem("修改动作要保留原编号、名称和循环方式")
    if loop:
        a.loop_frames = loop
    frames = a.frames or note.get("frames")
    if not frames:
        raise Problem("请用 --frames 说明帧数")
    if a.durations:
        durations = [int(x) for x in a.durations.split(",")]
        if len(durations) != frames:
            raise Problem(f"--durations 需要 {frames} 个数")
    else:
        durations = [a.ms] * frames
        durations[-1] = max(durations[-1], 220)
    if editing:
        if frames != len(metadata["durations"]) or (a.durations and durations != metadata["durations"]):
            raise Problem("修改动作应保留原来的帧数和播放节奏")
        durations = metadata["durations"]
    chroma = a.chroma or note.get("chroma")
    key = tuple(int(chroma[i : i + 2], 16) for i in (1, 3, 5)) if chroma else None
    strip, info = build_strip(
        Path(a.strip), t["petId"], frames, key, a.fit, a.equal_slots,
        anchor=Image.open(folder / "references/current-action.png").convert("RGBA").crop((0, 0, CELL_W, CELL_H)) if editing else None,
    )
    (folder / "actions").mkdir(exist_ok=True)
    image = folder / "actions" / f"{a.name}.png"
    strip.save(image)
    action = {
        "label": a.label,
        "image": f"actions/{a.name}.png",
        "durations": durations,
    }
    if a.loop_frames:
        action["loopFrames"] = a.loop_frames
    check_action(a.name, action)
    t["actions"][a.name] = action
    write(folder / "teaching.json", t)
    gif, sheet = previews(strip, durations, t["petId"], folder / "qa", a.name, a.loop_frames)
    if editing:
        action_edit.comparison(folder, a.name, Image.open(folder / "references/current-action.png").convert("RGBA"), strip, durations)
    print(
        json.dumps(
            {
                "action": a.name,
                "frames": frames,
                "durations": durations,
                **info,
                "preview_gif": str(gif.resolve()),
                "contact_sheet": str(sheet.resolve()),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_add_rule(a):
    folder = Path(a.dir)
    t = load_teaching(folder)
    rule = json.loads(Path(a.file).read_text() if a.file else a.json)
    _, _, layer = installed(t["petId"])
    t["rules"] = [r for r in t["rules"] if r["id"] != rule.get("id")] + [rule]
    result = merged(t, layer)
    write(folder / "teaching.json", t)
    print(f"规则 {rule['id']}：{describe(rule, result)}")


def cmd_remove(a):
    folder = Path(a.dir)
    t = load_teaching(folder)
    _, _, layer = installed(t["petId"])
    if a.action:
        t["remove"]["actions"].append(a.action)
    if a.rule:
        t["remove"]["rules"].append(a.rule)
    merged(t, layer)
    write(folder / "teaching.json", t)
    print("已加入删除清单")


def cmd_check(a):
    t, result = check(a.dir)
    pet, _, layer = installed(t["petId"])
    print(f"{pet['displayName']}：{t['summary']}")
    for name in t["actions"]:
        print(f"  {'替换动作' if name in t.get('replaceActions', []) else '新动作'} {name}：{t['actions'][name]['label']}")
    for rule in t["rules"]:
        verb = (
            "替换" if any(r["id"] == rule["id"] for r in layer["rules"]) else "新规则"
        )
        print(f"  {verb} {rule['label']}：{describe(rule, result)}")
    for name in t["remove"]["actions"]:
        print(f"  去掉动作 {name}")
    for rid in t["remove"]["rules"]:
        print(f"  去掉规则 {rid}")
    print("检查通过。")


def cmd_stage(a):
    folder = Path(a.dir)
    t, _ = check(folder)
    include = ["teaching.json"] + (["actions"] if (folder / "actions").is_dir() else [])
    try:
        r = deliver(folder, include, t["petId"], a.wait)
    except Refused as e:
        raise Problem("随伴拒收了这个包：" + str(e))
    if r["status"] == "received":
        print(
            "已送到随伴，变成了一张草稿。请用户在随伴的“新本领”里预览，点“接受”后生效。"
        )
    else:
        print(
            "已放进随伴的收件箱。随伴现在没有运行；打开随伴后会出现在“新本领”里等用户确认。"
        )


def main():
    p = argparse.ArgumentParser(description=__doc__)
    sub = p.add_subparsers(dest="command", required=True)
    sub.add_parser("pets", help="列出已安装的宠物、新本领和待确认草稿")
    s = sub.add_parser("new", help="为一次教学新建文件夹并导出参考图")
    s.add_argument("--pet", required=True)
    s.add_argument("--dir", required=True)
    s.add_argument("--summary", required=True, help="给用户看的一句话")
    s.add_argument("--replace", help="修改一个当前已接受的普通动作")
    s = sub.add_parser("prompt", help="为一个新动作写生图提示词和排版参考")
    s.add_argument("--dir", required=True)
    s.add_argument("--name", required=True)
    s.add_argument("--label", required=True)
    s.add_argument("--frames", type=int, required=True)
    s.add_argument("--motion", required=True, help="逐帧动作描述（英文更稳定）")
    s.add_argument("--props", default="")
    s.add_argument("--work-row", choices=["original", "laptop"], default="laptop", help="专心工作默认用安静学习实验，original 关闭")
    s.add_argument("--chroma", default="#FF00FF")
    s = sub.add_parser("add-action", help="把生成的横条图处理成动作")
    s.add_argument("--dir", required=True)
    s.add_argument("--name", required=True)
    s.add_argument("--label", required=True)
    s.add_argument("--strip", required=True)
    s.add_argument("--frames", type=int)
    s.add_argument("--ms", type=int, default=140)
    s.add_argument("--durations")
    s.add_argument("--loop-frames", nargs=2, type=int, metavar=("FIRST", "LAST"))
    s.add_argument("--chroma")
    s.add_argument("--fit", action="store_true")
    s.add_argument("--equal-slots", action="store_true")
    s = sub.add_parser("add-rule", help="新增或替换一条规则")
    s.add_argument("--dir", required=True)
    g = s.add_mutually_exclusive_group(required=True)
    g.add_argument("--json")
    g.add_argument("--file")
    s = sub.add_parser("remove", help="去掉已学会的动作或规则")
    s.add_argument("--dir", required=True)
    s.add_argument("--action")
    s.add_argument("--rule")
    s = sub.add_parser("check", help="完整检查，并用中文说明效果")
    s.add_argument("--dir", required=True)
    s = sub.add_parser("stage", help="检查后送到随伴，等待用户确认")
    s.add_argument("--dir", required=True)
    s.add_argument("--wait", type=float, default=8)
    a = p.parse_args()
    try:
        globals()["cmd_" + a.command.replace("-", "_")](a)
    except Problem as e:
        raise SystemExit("✗ " + str(e))


if __name__ == "__main__":
    main()
