#!/usr/bin/env python3
"""Clean-room wardrobe outfit authoring workflow for Suiby desktop pets.

Extracts exact per-row references and anchors from an installed pet, guides
dual-reference generation with base-look user approval gating, cleans edges,
locks frames 1:1 to the pet's original proportions, composes V1/V2 outfit
atlases, and delivers incremental outfit.json packages via Suiby's inbox.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import math
import re
import shutil
import sys
from collections import deque
from datetime import datetime, timezone
from pathlib import Path

from PIL import Image, ImageChops, ImageDraw, ImageStat

sys.path.insert(0, str(Path(__file__).resolve().parent))
from deliver import Refused, data_dir, deliver, ensure_safe_work_dir  # noqa: E402

SKILL = Path(__file__).resolve().parents[1]
CELL_W = 192
CELL_H = 208
ATLAS_W = CELL_W * 8
V1_HEIGHT = CELL_H * 9
V2_HEIGHT = CELL_H * 11
MAX_IMAGE_BYTES = 32 * 1024 * 1024
SLEEP_FRAMES = 16
SLEEP_MAX_BYTES = 4 * 1024 * 1024
SLEEP_DEFAULT_LOOP_FRAMES = [5, 12]  # 1-based inclusive (0-based f04..f11), matching player.ts & teaching.rs
SLEEP_DURATIONS = [
    160, 220, 300, 180,
    175, 175, 175, 175, 175, 175, 175, 175,
    140, 320, 290, 220,
]

SAFE_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,31}$")
WEEKDAYS = ("sun", "mon", "tue", "wed", "thu", "fri", "sat")
DAYS_IN_MONTH = (31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31)

STANDARD_ROWS = [
    ("idle", "待机", 0, [280, 110, 110, 140, 140, 320]),
    ("running-right", "向右跑", 1, [120, 120, 120, 120, 120, 120, 120, 220]),
    ("running-left", "向左跑", 2, [120, 120, 120, 120, 120, 120, 120, 220]),
    ("waving", "打招呼", 3, [140, 140, 140, 280]),
    ("jumping", "跳跃", 4, [140, 140, 140, 140, 280]),
    ("failed", "失落", 5, [140, 140, 140, 140, 140, 140, 140, 240]),
    ("waiting", "等待", 6, [150, 150, 150, 150, 150, 260]),
    ("running", "专心工作", 7, [120, 120, 120, 120, 120, 220]),
    ("review", "观察", 8, [150, 150, 150, 150, 150, 280]),
]

GAZE_ROWS = [
    ("gaze-1", "注视方向 1 (0°–157.5°)", 9, [220] * 8),
    ("gaze-2", "注视方向 2 (180°–337.5°)", 10, [220] * 8),
]

ALL_ROW_META = {
    **{name: (label, row_idx, durs) for name, label, row_idx, durs in STANDARD_ROWS + GAZE_ROWS},
    "sleep": ("睡觉", None, SLEEP_DURATIONS),
}

PRESET_SCHEDULES = {
    "pajamas": {"time": {"from": "22:00", "to": "07:00"}},
    "weekend": {"days": ["sat", "sun"]},
    "summer": {"dates": {"from": "06-01", "to": "08-31"}},
    "halloween": {"dates": {"from": "10-25", "to": "11-01"}},
    "holidays": {"dates": {"from": "12-15", "to": "01-05"}},
}

CHROMA_CANDIDATES = [
    (
        "#FF00FF",
        "magenta",
        ("pink", "magenta", "purple", "violet", "lavender", "rose", "fuchsia", "crimson", "red", "plum", "berry",
         "粉", "紫", "红", "玫", "桃", "洋红", "薰衣草", "樱桃", "酒红"),
    ),
    (
        "#00FF00",
        "lime green",
        ("green", "lime", "sage", "mint", "emerald", "olive", "forest", "jade", "moss", "khaki", "chartreuse",
         "绿", "翠", "薄荷", "抹茶", "草", "森", "橄榄", "青绿"),
    ),
    (
        "#00FFFF",
        "cyan",
        ("cyan", "aqua", "teal", "turquoise", "sky", "blue", "navy", "ice", "cerulean", "denim",
         "青", "蓝", "天蓝", "冰蓝", "水蓝", "湖蓝", "藏青", "牛仔"),
    ),
    (
        "#0000FF",
        "pure blue",
        ("blue", "navy", "indigo", "cobalt", "denim", "sapphire", "royal",
         "蓝", "靛", "藏青", "牛仔", "宝蓝"),
    ),
    (
        "#FFFF00",
        "yellow",
        ("yellow", "gold", "amber", "mustard", "lemon", "sun", "cream",
         "黄", "金", "柠檬", "鹅黄", "琥珀"),
    ),
]


class Problem(Exception):
    """Actionable user-facing workflow error."""


def _now():
    return datetime.now(timezone.utc).isoformat()


def _ts_slug():
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")


def _read_json(path):
    return json.loads(Path(path).read_text(encoding="utf-8"))


def _write_json(path, value):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")


def _digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def _parse_hex(value):
    if not re.fullmatch(r"#[0-9a-fA-F]{6}", value):
        raise Problem(f"色键格式无效：{value!r}，应为 #RRGGBB。")
    return tuple(int(value[i : i + 2], 16) for i in (1, 3, 5))


def pick_safe_chroma_key(description):
    """Choose a chroma-key color that avoids colors mentioned in the outfit description."""
    low = (description or "").lower()
    scored = []
    for order, (hex_code, name, keywords) in enumerate(CHROMA_CANDIDATES):
        hits = 0
        for kw in keywords:
            if kw.isascii():
                if re.search(r"\b" + re.escape(kw) + r"\b", low):
                    hits += 1
            else:
                if kw in low:
                    hits += 1
        scored.append((hits, order, hex_code, name))
    scored.sort()
    _, _, hex_code, name = scored[0]
    return {"hex": hex_code, "name": name, "rgb": list(_parse_hex(hex_code))}


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


def validate_schedule_rule(raw, outfit_id):
    if not isinstance(raw, dict):
        raise Problem("时间表规则必须是 JSON 对象。")
    if "when" in raw:
        when = raw["when"]
        target = raw.get("outfit", outfit_id)
        if target != outfit_id:
            raise Problem(f"scheduleRule.outfit 必须等于当前服装编号 {outfit_id}。")
        enabled = raw.get("enabled")
    else:
        when = raw
        enabled = None
    if not isinstance(when, dict):
        raise Problem("scheduleRule.when 必须是 JSON 对象。")
    clean_when = {}
    if when.get("time") is not None:
        t = when["time"]
        if (
            not isinstance(t, dict)
            or not _valid_clock(t.get("from"))
            or not _valid_clock(t.get("to"))
            or t["from"] == t["to"]
        ):
            raise Problem("时间段 time 需要不同的 HH:MM 起止时间（如 22:00 到 07:00）。")
        clean_when["time"] = {"from": t["from"], "to": t["to"]}
    if when.get("days") is not None:
        days = when["days"]
        if not isinstance(days, list) or not days or any(d not in WEEKDAYS for d in days):
            raise Problem("星期 days 必须是非空数组，取值为 sun..sat。")
        clean_when["days"] = [d for d in WEEKDAYS if d in days]
    if when.get("dates") is not None:
        dr = when["dates"]
        if not isinstance(dr, dict) or not _valid_mmdd(dr.get("from")) or not _valid_mmdd(dr.get("to")):
            raise Problem("日期范围 dates 需要 MM-DD 格式的 from 和 to。")
        clean_when["dates"] = {"from": dr["from"], "to": dr["to"]}
    if not clean_when:
        raise Problem("时间表规则至少需要 time、days、dates 之一。")
    rule = {"outfit": outfit_id, "when": clean_when}
    if enabled is False:
        rule["enabled"] = False
    return rule


def _format_when(when):
    parts = []
    if when.get("dates"):
        parts.append(f"{when['dates']['from']}..{when['dates']['to']}")
    if when.get("days"):
        parts.append(",".join(when["days"]))
    if when.get("time"):
        parts.append(f"{when['time']['from']}-{when['time']['to']}")
    return " ".join(parts) or "-"


# ---------- installed pet discovery ----------


def all_installed_pets():
    root = data_dir() / "pets"
    if not root.is_dir():
        return []
    items = []
    for folder in sorted(root.iterdir()):
        manifest = folder / "pet.json"
        if not manifest.is_file():
            continue
        pet = _read_json(manifest)
        sheet_path = folder / pet.get("spritesheetPath", "")
        layout = "unknown"
        size = None
        if sheet_path.is_file():
            with Image.open(sheet_path) as im:
                size = list(im.size)
                if im.size == (ATLAS_W, V2_HEIGHT):
                    layout = "v2"
                elif im.size == (ATLAS_W, V1_HEIGHT):
                    layout = "v1"
        items.append({"dir": folder, "pet": pet, "layout": layout, "size": size})
    return items


def load_installed_pet(pet_id):
    root = data_dir() / "pets" / pet_id
    manifest = root / "pet.json"
    if not manifest.is_file():
        known = ", ".join(item["pet"]["id"] for item in all_installed_pets()) or "无"
        raise Problem(f"随伴里没有编号为 {pet_id} 的宠物。已安装：{known}")
    pet = _read_json(manifest)
    sheet_path = root / pet["spritesheetPath"]
    if not sheet_path.is_file():
        raise Problem(f"宠物 {pet_id} 缺少基础图集文件：{sheet_path}")
    with Image.open(sheet_path) as im:
        size = im.size
    if size == (ATLAS_W, V2_HEIGHT):
        layout = "v2"
    elif size == (ATLAS_W, V1_HEIGHT):
        layout = "v1"
    else:
        raise Problem(
            f"宠物 {pet_id} 的图集尺寸 {size[0]}x{size[1]} 不是标准 V1 ({ATLAS_W}x{V1_HEIGHT}) 或 V2 ({ATLAS_W}x{V2_HEIGHT})。"
        )
    return root, pet, sheet_path, layout, size


# ---------- clean-room border-connected matting & anchor math ----------


def _solid_bbox(image, threshold=16):
    return image.getchannel("A").point(lambda v: 255 if v > threshold else 0).getbbox()


def _hue_similarity(rgb, key):
    rm = (rgb[0] + rgb[1] + rgb[2]) / 3.0
    km = (key[0] + key[1] + key[2]) / 3.0
    rc = (rgb[0] - rm, rgb[1] - rm, rgb[2] - rm)
    kc = (key[0] - km, key[1] - km, key[2] - km)
    denom = math.sqrt(
        (rc[0] * rc[0] + rc[1] * rc[1] + rc[2] * rc[2])
        * (kc[0] * kc[0] + kc[1] * kc[1] + kc[2] * kc[2])
    )
    if denom <= 1e-6:
        return -1.0
    return (rc[0] * kc[0] + rc[1] * kc[1] + rc[2] * kc[2]) / denom


def _saturation(rgb):
    hi = max(rgb)
    return 0.0 if hi <= 0 else (hi - min(rgb)) / float(hi)


def _refine_border_key(rgba, key_rgb):
    w, h = rgba.size
    pts = [
        (min(1, w - 1), min(1, h - 1)),
        (max(0, w - 2), min(1, h - 1)),
        (min(1, w - 1), max(0, h - 2)),
        (max(0, w - 2), max(0, h - 2)),
    ]
    corners = [rgba.getpixel(pt)[:3] for pt in pts]
    avg = tuple(round(sum(c[i] for c in corners) / 4.0) for i in range(3))
    if all(math.dist(c, avg) <= 45.0 for c in corners) and math.dist(avg, key_rgb) <= 65.0:
        return avg
    return tuple(key_rgb)


def _unmix_key_color(rgb, key):
    """Chroma-key-only spill unmixing without opposite-channel amplification.

    Measures only the excess chroma-key component (minimum of key-high channels
    above maximum of key-low channels), preventing opposite-hue artifacts (such
    as green fringe on magenta keys) while recovering exact white whiskers and
    dark fur alpha edges.
    """
    hi_ch = [c for c in range(3) if key[c] >= 128]
    lo_ch = [c for c in range(3) if key[c] < 128]
    if not hi_ch or not lo_ch:
        return (rgb[0], rgb[1], rgb[2], 255)
    hi_val = min(rgb[c] for c in hi_ch)
    lo_val = max(rgb[c] for c in lo_ch)
    key_span = max(1.0, float(min(key[c] for c in hi_ch) - max(key[c] for c in lo_ch)))
    spill = max(0.0, float(hi_val - lo_val))
    if spill <= 0.5:
        return (rgb[0], rgb[1], rgb[2], 255)
    bg_frac = min(1.0, spill / key_span)
    a = 1.0 - bg_frac
    if a <= 1e-4:
        return (0, 0, 0, 0)
    fg = [
        max(0, min(255, round((rgb[c] - bg_frac * key[c]) / a)))
        for c in range(3)
    ]
    alpha = max(0, min(255, round(a * 255.0)))
    return (fg[0], fg[1], fg[2], alpha)


def remove_background(image, key_rgb, threshold=52.0):
    """Border-connected BFS flood-fill matting + exterior chroma-only despill.

    - Native transparent inputs keep their alpha and RGB untouched (clearing only
      invisible alpha dust <= 8).
    - Opaque chroma-keyed inputs flood-fill strictly from the image perimeter so
      interior pixels matching the key color (buttons, eyes, patterns) are 100%
      protected from holes.
    - Only the 1-2px exterior fringe directly adjacent to the flooded background
      undergoes chroma-key-only alpha unmixing/despill, preserving fine white
      whiskers and non-key edge pixels intact.
    """
    rgba = image.convert("RGBA")
    if rgba.getchannel("A").getextrema()[0] < 245:
        data = [(0, 0, 0, 0) if p[3] <= 8 else p for p in rgba.getdata()]
        out = Image.new("RGBA", rgba.size)
        out.putdata(data)
        return out, "alpha"

    w, h = rgba.size
    pixels = list(rgba.getdata())
    effective_key = _refine_border_key(rgba, key_rgb)
    kr, kg, kb = effective_key
    thresh2 = threshold * threshold

    def is_key_bg(idx):
        r, g, b, _ = pixels[idx]
        dr = r - kr
        dg = g - kg
        db = b - kb
        return (dr * dr + dg * dg + db * db) <= thresh2

    # 1. Border-connected 4-neighbor BFS flood fill from perimeter pixels only.
    bg_mask = bytearray(w * h)
    queue = deque()

    def seed(x, y):
        idx = y * w + x
        if not bg_mask[idx] and is_key_bg(idx):
            bg_mask[idx] = 1
            queue.append(idx)

    for x in range(w):
        seed(x, 0)
        if h > 1:
            seed(x, h - 1)
    for y in range(1, h - 1):
        seed(0, y)
        if w > 1:
            seed(w - 1, y)

    while queue:
        idx = queue.popleft()
        x = idx % w
        y = idx // w
        if x > 0:
            n = idx - 1
            if not bg_mask[n] and is_key_bg(n):
                bg_mask[n] = 1
                queue.append(n)
        if x + 1 < w:
            n = idx + 1
            if not bg_mask[n] and is_key_bg(n):
                bg_mask[n] = 1
                queue.append(n)
        if y > 0:
            n = idx - w
            if not bg_mask[n] and is_key_bg(n):
                bg_mask[n] = 1
                queue.append(n)
        if y + 1 < h:
            n = idx + w
            if not bg_mask[n] and is_key_bg(n):
                bg_mask[n] = 1
                queue.append(n)

    # 2. Identify exterior 1-2px fringe strictly adjacent to the flooded background.
    ring_map = bytearray(w * h)  # 0 = interior, 1 = 1px exterior fringe, 2 = 2px exterior fringe
    ring1 = []
    for idx in range(w * h):
        if bg_mask[idx]:
            continue
        x = idx % w
        y = idx // w
        y0 = max(0, y - 1)
        y1 = min(h - 1, y + 1)
        x0 = max(0, x - 1)
        x1 = min(w - 1, x + 1)
        touches_bg = False
        for ny in range(y0, y1 + 1):
            row_off = ny * w
            for nx in range(x0, x1 + 1):
                if bg_mask[row_off + nx]:
                    touches_bg = True
                    break
            if touches_bg:
                break
        if touches_bg:
            ring_map[idx] = 1
            ring1.append(idx)

    ring2 = []
    for idx in ring1:
        x = idx % w
        y = idx // w
        for ny in range(max(0, y - 1), min(h, y + 2)):
            row_off = ny * w
            for nx in range(max(0, x - 1), min(w, x + 2)):
                n = row_off + nx
                if not bg_mask[n] and ring_map[n] == 0:
                    ring_map[n] = 2
                    ring2.append(n)

    output = [(0, 0, 0, 0) if bg_mask[i] else pixels[i] for i in range(w * h)]

    # 3. Apply chroma-key-only feathering & despill exclusively on exterior fringe.
    def is_contaminated(rgb, ring):
        d = math.dist(rgb, effective_key)
        sat = _saturation(rgb)
        sim = _hue_similarity(rgb, effective_key)
        if ring == 1:
            return d <= 95.0 or (sim >= 0.72 and sat >= 0.12)
        return d <= 70.0 or (sim >= 0.80 and sat >= 0.18)

    # Mark clean opaque interior/non-contaminated reference pixels.
    clean_ref = bytearray(w * h)
    for idx in range(w * h):
        if bg_mask[idx]:
            continue
        if ring_map[idx] == 0 or not is_contaminated(pixels[idx][:3], ring_map[idx]):
            clean_ref[idx] = 1

    for idx in ring1 + ring2:
        rgb = pixels[idx][:3]
        ring = ring_map[idx]
        if not is_contaminated(rgb, ring):
            continue

        x = idx % w
        y = idx // w
        acc_r = acc_g = acc_b = acc_w = 0.0
        for ny in range(max(0, y - 2), min(h, y + 3)):
            row_off = ny * w
            dy = ny - y
            for nx in range(max(0, x - 2), min(w, x + 3)):
                n = row_off + nx
                if not clean_ref[n]:
                    continue
                dx = nx - x
                d2 = dx * dx + dy * dy
                if d2 == 0:
                    continue
                wt = 1.0 / d2
                nr, ng, nb, _ = pixels[n]
                acc_r += nr * wt
                acc_g += ng * wt
                acc_b += nb * wt
                acc_w += wt

        used_neighbor = False
        if acc_w > 0.0:
            ref = (acc_r / acc_w, acc_g / acc_w, acc_b / acc_w)
            vx, vy, vz = ref[0] - kr, ref[1] - kg, ref[2] - kb
            v2 = vx * vx + vy * vy + vz * vz
            if v2 > 400.0:
                ox, oy, oz = rgb[0] - kr, rgb[1] - kg, rgb[2] - kb
                a_proj = max(0.0, min(1.0, (ox * vx + oy * vy + oz * vz) / v2))
                pred = (kr + a_proj * vx, kg + a_proj * vy, kb + a_proj * vz)
                # Only use neighbor-line projection when pixel genuinely lies on the
                # blend line between key color and local opaque neighbor; otherwise
                # (e.g. bright white whisker on dark fur) use exact key-channel unmix!
                if math.dist(rgb, pred) <= 20.0:
                    alpha = max(0, min(255, round(a_proj * 255.0)))
                    if alpha <= 8:
                        output[idx] = (0, 0, 0, 0)
                    else:
                        output[idx] = (
                            max(0, min(255, round(ref[0]))),
                            max(0, min(255, round(ref[1]))),
                            max(0, min(255, round(ref[2]))),
                            alpha,
                        )
                    used_neighbor = True

        if not used_neighbor:
            unmixed = _unmix_key_color(rgb, effective_key)
            output[idx] = (0, 0, 0, 0) if unmixed[3] <= 8 else unmixed

    out = Image.new("RGBA", (w, h))
    out.putdata(output)
    return out, "chroma"


def _pose_boxes_from_strip(rgba, frame_count, equal_slots=False):
    w, h = rgba.size
    slot = w / float(frame_count)
    alpha = rgba.getchannel("A").point(lambda v: 255 if v > 24 else 0)

    def try_equal():
        boxes = []
        for i in range(frame_count):
            x0 = round(i * slot)
            x1 = round((i + 1) * slot)
            b = alpha.crop((x0, 0, x1, h)).getbbox()
            if b is None:
                return None
            boxes.append((x0 + b[0], b[1], x0 + b[2], b[3]))
        return boxes

    if not equal_slots:
        cols = [alpha.crop((x, 0, x + 1, h)).getbbox() is not None for x in range(w)]
        runs = []
        start = None
        gap = 0
        min_gap = 2
        for x, filled in enumerate(cols + [False] * (min_gap + 1)):
            if filled:
                if start is None:
                    start = x
                gap = 0
                end = x
            elif start is not None:
                gap += 1
                if gap >= min_gap:
                    runs.append((start, end + 1))
                    start = None
        runs = [r for r in runs if r[1] - r[0] >= 6]
        if len(runs) == frame_count:
            boxes = []
            for x0, x1 in runs:
                b = alpha.crop((x0, 0, x1, h)).getbbox()
                boxes.append((x0, b[1], x1, b[3]))
            return boxes, "components"
        # If the input is already exact cell-sized (192*N x 208), accept clean equal slots automatically.
        if (w, h) == (CELL_W * frame_count, CELL_H):
            eq = try_equal()
            if eq is not None:
                return eq, "exact-slots"
        raise Problem(
            f"在生成图里找不到 {frame_count} 个分开的姿势（检测到 {len(runs)} 组）。"
            "请重新生成让相邻姿势留出明显空隙；若确认原图各帧严格等宽居中，可加 --equal-slots。"
        )

    eq = try_equal()
    if eq is None:
        raise Problem(f"按等宽 {frame_count} 格切分时发现空帧。")
    return eq, "equal-slots"


def register_row_to_anchor(rgba, frame_count, row_anchor, *, equal_slots=False):
    """Slice frames and lock them 1:1 to target pet's exact per-row height & foot anchor."""
    boxes, slice_mode = _pose_boxes_from_strip(rgba, frame_count, equal_slots=equal_slots)
    slot = rgba.width / float(frame_count)
    is_gaze = bool(row_anchor.get("is_gaze", False))
    ref_frames = row_anchor["frames"]
    notes = []

    if is_gaze:
        heights = [b[3] - b[1] for b in boxes]
        med_h = sorted(heights)[len(heights) // 2]
        scale = row_anchor["ref_height"] / float(max(1, med_h))
        placements = []
        for idx, (x0, y0, x1, y1) in enumerate(boxes):
            rf = ref_frames[idx]
            fw = max(1, round((x1 - x0) * scale))
            fh = max(1, round((y1 - y0) * scale))
            left = round(rf["center_x"] - fw / 2.0)
            top = round(rf["foot_y"] - fh)
            placements.append((left, top, fw, fh))
    else:
        ref_h = float(row_anchor["ref_height"])
        ref_cx = float(row_anchor["ref_center_x"])
        ref_foot = float(row_anchor["ref_foot_y"])
        f0 = boxes[0]
        h0 = max(1, f0[3] - f0[1])
        scale = ref_h / float(h0)
        ground0 = f0[3]
        first_offset = (f0[0] + f0[2]) / 2.0 - slot / 2.0

        def compute_placements(s):
            out = []
            for idx, (x0, y0, x1, y1) in enumerate(boxes):
                offset = (x0 + x1) / 2.0 - (idx + 0.5) * slot - first_offset
                fw = max(1, round((x1 - x0) * s))
                fh = max(1, round((y1 - y0) * s))
                left = round(ref_cx + offset * s - fw / 2.0)
                top = round(ref_foot - (ground0 - y0) * s)
                out.append((left, top, fw, fh))
            return out

        placements = compute_placements(scale)
        # Preserve aspect ratio; only gently shrink if a frame would clip outside 192x208.
        need = 1.0
        for left, top, fw, fh in placements:
            if left < 2:
                need = min(need, max(0.5, (ref_cx - 2) / max(1.0, ref_cx - left)))
            if left + fw > CELL_W - 2:
                need = min(need, max(0.5, (CELL_W - 2 - ref_cx) / max(1.0, left + fw - ref_cx)))
            if top < 2:
                need = min(need, max(0.5, (ref_foot - 2) / max(1.0, ref_foot - top)))
            if top + fh > CELL_H - 2:
                need = min(need, max(0.5, (CELL_H - 2 - ref_foot) / max(1.0, top + fh - ref_foot)))
        if need < 0.999:
            scale *= need * 0.98
            placements = compute_placements(scale)
            notes.append(f"为避免裁切按原比例微调至 {need * 0.98:.0%}")

    cells = []
    for (x0, y0, x1, y1), (left, top, fw, fh) in zip(boxes, placements):
        pose = rgba.crop((x0, y0, x1, y1)).resize((fw, fh), Image.Resampling.LANCZOS)
        cell = Image.new("RGBA", (CELL_W, CELL_H), (0, 0, 0, 0))
        dx = max(0, left)
        dy = max(0, top)
        sx = max(0, -left)
        sy = max(0, -top)
        cell.alpha_composite(pose, (dx, dy), (sx, sy))
        cells.append(cell)

    out_strip = Image.new("RGBA", (CELL_W * frame_count, CELL_H), (0, 0, 0, 0))
    for idx, cell in enumerate(cells):
        out_strip.paste(cell, (idx * CELL_W, 0))

    b0 = _solid_bbox(cells[0]) or (0, 0, 0, 0)
    metrics = {
        "slice_mode": slice_mode,
        "scale": round(scale, 4),
        "frame0_height": b0[3] - b0[1],
        "target_height": round(row_anchor["ref_height"], 2),
        "frame0_foot_y": b0[3],
        "target_foot_y": round(row_anchor["ref_foot_y"], 2),
        "notes": notes,
    }
    return cells, out_strip, metrics


def _save_webp(image, path):
    p = Path(path)
    p.parent.mkdir(parents=True, exist_ok=True)
    image.save(p, format="WEBP", lossless=True, quality=100, method=6, exact=True)


def _render_row_qa(ref_strip_path, outfit_cells, durations, out_sheet, out_gif, job_name, loop_frames=None):
    bg = (240, 243, 236, 255)
    count = len(outfit_cells)
    with Image.open(ref_strip_path) as ref_im:
        ref_rgba = ref_im.convert("RGBA")

    sheet = Image.new("RGB", (CELL_W * count, CELL_H * 2 + 44), bg[:3])
    draw = ImageDraw.Draw(sheet)
    draw.text((8, 4), f"Original pet: {job_name}", fill=(65, 75, 65))
    draw.text((8, CELL_H + 26), f"New outfit: {job_name}", fill=(65, 75, 65))
    for i in range(count):
        ref_cell = ref_rgba.crop((i * CELL_W, 0, (i + 1) * CELL_W, CELL_H))
        top_canvas = Image.new("RGBA", (CELL_W, CELL_H), bg)
        top_canvas.alpha_composite(ref_cell)
        sheet.paste(top_canvas.convert("RGB"), (i * CELL_W, 22))

        bot_canvas = Image.new("RGBA", (CELL_W, CELL_H), bg)
        bot_canvas.alpha_composite(outfit_cells[i])
        sheet.paste(bot_canvas.convert("RGB"), (i * CELL_W, CELL_H + 44))
    out_sheet.parent.mkdir(parents=True, exist_ok=True)
    sheet.save(out_sheet)

    seq_cells = list(outfit_cells)
    seq_durs = list(durations)
    if loop_frames and len(loop_frames) == 2:
        first, last = int(loop_frames[0]), int(loop_frames[1])
        if 1 < first < last < len(seq_cells):
            # 1-based inclusive [first, last] -> 0-based [first-1 : last], looped 3x like teach.py.
            seq_cells = seq_cells[:last] + seq_cells[first - 1 : last] * 2 + seq_cells[last:]
            seq_durs = seq_durs[:last] + seq_durs[first - 1 : last] * 2 + seq_durs[last:]

    gif_frames = []
    for cell in seq_cells:
        c = Image.new("RGBA", (CELL_W, CELL_H), bg)
        c.alpha_composite(cell)
        gif_frames.append(c.resize((CELL_W * 2, CELL_H * 2), Image.Resampling.LANCZOS).convert("RGB"))
    gif_frames[0].save(
        out_gif,
        save_all=True,
        append_images=gif_frames[1:],
        duration=seq_durs,
        loop=0,
    )


def inspect_sleep_loop(cells, loop_frames):
    """Measure frame-to-frame jitter and loop-seam jump on 1-based inclusive loop_frames."""
    first, last = int(loop_frames[0]), int(loop_frames[1])
    if not (1 < first < last < len(cells)):
        return {"ok": True, "loopFrames": [first, last], "warnings": []}
    hold = cells[first - 1 : last]
    boxes = [_solid_bbox(c) for c in hold]
    valid = [b for b in boxes if b is not None]
    if not valid:
        return {"ok": False, "loopFrames": [first, last], "warnings": ["睡眠循环段为空帧"]}
    x0 = min(b[0] for b in valid)
    y0 = min(b[1] for b in valid)
    x1 = max(b[2] for b in valid)
    y1 = max(b[3] for b in valid)
    size = (max(1, x1 - x0), max(1, y1 - y0))
    bg = (128, 128, 128, 255)

    def mad(a, b):
        ca = Image.new("RGBA", size, bg)
        cb = Image.new("RGBA", size, bg)
        ca.alpha_composite(a.crop((x0, y0, x1, y1)))
        cb.alpha_composite(b.crop((x0, y0, x1, y1)))
        diff = ImageChops.difference(ca.convert("RGB"), cb.convert("RGB"))
        return sum(ImageStat.Stat(diff).mean) / 765.0

    steps = [mad(hold[i], hold[i + 1]) for i in range(len(hold) - 1)]
    mean_step = sum(steps) / float(max(1, len(steps)))
    max_step = max(steps, default=0.0)
    wrap_mad = mad(hold[-1], hold[0])

    warnings = []
    if mean_step > 0.030 or max_step > 0.040:
        warnings.append(
            f"睡眠循环段（第 {first}–{last} 帧）相邻帧抖动偏大（mean={mean_step:.4f}, max={max_step:.4f}），"
            "请检查 qa/sleep.gif 确认头部、五官和衣领是否稳定。"
        )
    if wrap_mad > 0.035:
        warnings.append(
            f"睡眠循环接缝（第 {last} 帧回到第 {first} 帧）跳变偏大（wrap={wrap_mad:.4f}），"
            "循环呼吸时可能闪烁或眨眼，请检查 qa/sleep.gif。"
        )
    return {
        "ok": not warnings,
        "loopFrames": [first, last],
        "meanStepMad": round(mean_step, 4),
        "maxStepMad": round(max_step, 4),
        "wrapMad": round(wrap_mad, 4),
        "warnings": warnings,
    }


def _render_base_vs_outfit_comparison(base_atlas_path, outfit_atlas_path, layout, out_path):
    bg = (240, 243, 236, 255)
    sample_rows = [
        ("idle", 0, 6),
        ("running-right", 1, 8),
        ("waving", 3, 4),
        ("jumping", 4, 5),
    ]
    if layout == "v2":
        sample_rows.append(("gaze-1", 9, 8))

    with Image.open(base_atlas_path) as b_im, Image.open(outfit_atlas_path) as o_im:
        base_rgba = b_im.convert("RGBA")
        outfit_rgba = o_im.convert("RGBA")

    max_cols = max(count for _, _, count in sample_rows)
    band_h = CELL_H * 2 + 34
    canvas = Image.new("RGB", (CELL_W * max_cols, band_h * len(sample_rows)), bg[:3])
    draw = ImageDraw.Draw(canvas)
    for r_pos, (name, row_idx, count) in enumerate(sample_rows):
        y_top = r_pos * band_h
        draw.text((8, y_top + 6), f"{name} (top: base pet / bottom: new outfit)", fill=(55, 65, 55))
        for col in range(count):
            box = (col * CELL_W, row_idx * CELL_H, (col + 1) * CELL_W, (row_idx + 1) * CELL_H)
            c_base = Image.new("RGBA", (CELL_W, CELL_H), bg)
            c_base.alpha_composite(base_rgba.crop(box))
            canvas.paste(c_base.convert("RGB"), (col * CELL_W, y_top + 26))

            c_out = Image.new("RGBA", (CELL_W, CELL_H), bg)
            c_out.alpha_composite(outfit_rgba.crop(box))
            canvas.paste(c_out.convert("RGB"), (col * CELL_W, y_top + 26 + CELL_H + 4))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    canvas.save(out_path)


# ---------- prompt generation ----------


def _find_base_sleep_strip(pet_dir, pet):
    rel = pet.get("sleepStrip")
    if not rel:
        return None
    candidate = (Path(pet_dir) / rel).resolve()
    if not candidate.is_relative_to(Path(pet_dir).resolve()) or not candidate.is_file():
        return None
    with Image.open(candidate) as im:
        if im.size != (CELL_W * SLEEP_FRAMES, CELL_H):
            return None
    return candidate


def _extract_strip_anchor(strip_im, frame_count, *, row_index=None, is_gaze=False):
    frame_records = []
    for col in range(frame_count):
        cell = strip_im.crop((col * CELL_W, 0, (col + 1) * CELL_W, CELL_H))
        box = _solid_bbox(cell)
        if box is None:
            box = (CELL_W // 4, CELL_H // 4, CELL_W * 3 // 4, CELL_H - 10)
        frame_records.append(
            {
                "col": col,
                "bbox": list(box),
                "width": box[2] - box[0],
                "height": box[3] - box[1],
                "center_x": round((box[0] + box[2]) / 2.0, 2),
                "foot_y": box[3],
            }
        )
    heights = [f["height"] for f in frame_records]
    ref_h = sorted(heights)[len(heights) // 2] if is_gaze else frame_records[0]["height"]
    return {
        "row_index": row_index,
        "frame_count": frame_count,
        "is_gaze": is_gaze,
        "ref_height": ref_h,
        "ref_center_x": frame_records[0]["center_x"],
        "ref_foot_y": frame_records[0]["foot_y"],
        "frames": frame_records,
    }


def _resolve_sleep_timing(pet_dir, frame_count=SLEEP_FRAMES):
    """Resolve 1-based inclusive loopFrames and durations for the pet's sleep clip."""
    pet_root = Path(pet_dir)
    sleep_action = None
    lib_path = pet_root / "custom/action-library.json"
    if lib_path.is_file():
        try:
            lib = _read_json(lib_path)
            sleep_action = (lib.get("layer") or {}).get("actions", {}).get("sleep")
        except (OSError, ValueError):
            sleep_action = None
    if sleep_action is None:
        hist_path = pet_root / "custom/history.json"
        if hist_path.is_file():
            try:
                hist = _read_json(hist_path)
                cur = hist.get("current")
                if cur:
                    ver = _read_json(pet_root / f"custom/versions/{cur}.json")
                    sleep_action = (ver.get("actions") or {}).get("sleep")
            except (OSError, ValueError):
                sleep_action = None

    durations = list(SLEEP_DURATIONS)
    loop_frames = list(SLEEP_DEFAULT_LOOP_FRAMES)
    if isinstance(sleep_action, dict):
        d = sleep_action.get("durations")
        if (
            isinstance(d, list)
            and len(d) == frame_count
            and all(isinstance(ms, int) and not isinstance(ms, bool) and ms > 0 for ms in d)
        ):
            durations = list(d)
        lf = sleep_action.get("loopFrames")
        if (
            isinstance(lf, list)
            and len(lf) == 2
            and all(isinstance(v, int) and not isinstance(v, bool) for v in lf)
            and 1 < lf[0] < lf[1] < frame_count
        ):
            loop_frames = [int(lf[0]), int(lf[1])]
    return loop_frames, durations


def _write_sleep_prompt(
    jobs_dir,
    pet,
    outfit_id,
    outfit_label,
    desc,
    chroma,
    *,
    loop_frames=None,
    total_frames=SLEEP_FRAMES,
):
    pet_name = pet["displayName"]
    chroma_hex = chroma["hex"]
    chroma_name = chroma["name"]
    first, last = loop_frames or SLEEP_DEFAULT_LOOP_FRAMES
    settle_end = first - 1
    wake_start = last + 1
    settle_label = f"Frame 1" if settle_end == 1 else f"Frames 1–{settle_end}"
    wake_label = f"Frame {total_frames}" if wake_start == total_frames else f"Frames {wake_start}–{total_frames}"
    sleep_prompt = f"""Author a crisp {total_frames}-frame quiet sleep strip ({total_frames * CELL_W}×{CELL_H}, {CELL_W}×{CELL_H} per cell) for "{pet_name}" wearing outfit "{outfit_label}" ({outfit_id}) — job `sleep` (睡觉).

Dual Reference Images (ATTACH BOTH):
1. `approved/base.png` — Approved outfit look (lock character identity, outfit design, colors, fabric details, and accessories).
2. `refs/rows/sleep.png` — Target pet's finished {total_frames}-frame sleep strip (lock exact posture progression, resting scale, ground/anchor line, and gentle breathing rhythm).

Outfit description:
{desc}

State action: Quiet sleep sequence. The pet settles into a sleeping pose, breathes gently while asleep, then wakes and returns to its starting pose. Use only features already present in the attached approved outfit look.

State requirements (1-based frame numbers, inclusive):
- {settle_label}: Start in the pet's normal resting pose (reuse the approved dressed idle frame for Frame 1 and Frame {total_frames}). Settle into sleep with small, continuous posture transitions matching `refs/rows/sleep.png`. If the pet has visible eyes, let them close as it settles.
- Frames {first}–{last}: Hold that sleeping pose in a seamless breathing loop. Reuse ONE single settled sleeping image across ALL of Frames {first}–{last}, animating ONLY a tiny, gentle local breathing motion (e.g. subtle chest/back or body rise-and-fall). Keep the head, face, closed eyes, collar/outfit details, and grounded/static anchor parts strictly locked (0 px horizontal drift). Keep eyes gently closed through Frame {last}. Frame {last} must flow smoothly back into Frame {first}.
- {wake_label}: Wake gently (eyes may open starting at Frame {wake_start}, matching `refs/rows/sleep.png`) and return smoothly to Frame {total_frames} (the approved dressed idle pose).
- Preserve the pet's existing anatomy, natural proportions, and outfit throughout. Add no new body parts, props, Zzz symbols, or floating effects.

High-resolution authoring, matting & QA rules:
- Do NOT squeeze all {total_frames} frames into one wide raw image (single-image generation shrinks each frame too small and causes blur when upscaled). Generate key settle/sleeping poses separately at high resolution (trimmed character width/height at least ~2× final rendered size), then downsample once into {CELL_W}×{CELL_H} cells and assemble the {total_frames}-cell {total_frames * CELL_W}×{CELL_H} transparent strip (pass `--equal-slots` to `accept`).
- Background color: inspect the actual colors of the character, outfit, and accessories in `approved/base.png`; use one solid, non-clashing `#RRGGBB` chroma key (default `{chroma_name} {chroma_hex}`, or override with `--chroma` if anything clashes) consistently for both generation and matting. No floor, shadows, text, borders, glows, or sparkles.
- Matting: key on the full-resolution raw image BEFORE downsampling using border-connected flood fill + outline despill (never global color deletion); preserve fine whiskers/lines and semi-transparent edges, and manually inspect enclosed gaps (between limbs, inside tail loops, under collars).
- Final QA before delivery: compare the sleeping pose side-by-side with the dressed idle pose at actual desktop pet size; inspect on both light and dark backgrounds for color fringe, holes, or clipped edges; watch 3 consecutive breath loops into wake-up and verify 0 px horizontal drift on grounded/static parts, visible gentle breathing motion, and a seamless Frame {last} → Frame {first} wrap.
"""
    (jobs_dir / "sleep.txt").write_text(sleep_prompt, encoding="utf-8")


def _write_prompts(
    work_dir,
    pet,
    outfit_id,
    outfit_label,
    desc,
    chroma,
    layout,
    *,
    include_sleep=False,
    only_sleep=False,
    sleep_loop_frames=None,
):
    jobs_dir = work_dir / "jobs"
    jobs_dir.mkdir(parents=True, exist_ok=True)
    if only_sleep:
        _write_sleep_prompt(
            jobs_dir, pet, outfit_id, outfit_label, desc, chroma, loop_frames=sleep_loop_frames
        )
        return
    pet_name = pet["displayName"]
    chroma_hex = chroma["hex"]
    chroma_name = chroma["name"]

    base_prompt = f"""Create one clean outfit concept portrait for the existing desktop pet "{pet_name}" ({pet['id']}).

Reference image (REQUIRED):
- Attach `refs/base-idle-0-2x.png` (the pet's canonical standing idle frame).

Outfit to wear ("{outfit_label}" / {outfit_id}):
{desc}

Strict identity & proportion rules:
- Keep the EXACT same character species, face, eyes, ears, markings, tail, art style, and natural head-to-body proportions from `refs/base-idle-0-2x.png`.
- Do NOT stretch, enlarge, or distort the pet to fill the frame; keep natural padding and the same calm standing pose and foot placement.
- Render on a perfectly flat pure {chroma_name} ({chroma_hex}) background.
- Crisp opaque edges only. No floor, shadows, scenery, glows, sparkles, labels, or {chroma_name} hues inside the pet or outfit.
"""
    (jobs_dir / "base.txt").write_text(base_prompt, encoding="utf-8")

    row_list = list(STANDARD_ROWS) + (list(GAZE_ROWS) if layout == "v2" else [])
    for job_id, cn_label, row_idx, durs in row_list:
        count = len(durs)
        is_gaze = job_id.startswith("gaze-")
        extra = (
            "Each of the 8 frames is a distinct clockwise gaze direction matching the exact head/eye angle of the corresponding cell in Reference 2."
            if is_gaze
            else f"Match the exact pose progression, silhouette motion, timing, and facing direction of every frame in Reference 2 ({job_id} / {cn_label})."
        )
        prompt = f"""Create one horizontal animation strip for "{pet_name}" wearing outfit "{outfit_label}" ({outfit_id}) — row `{job_id}` ({cn_label}).

Dual Reference Images (ATTACH BOTH):
1. `approved/base.png` — User-approved outfit look (lock character identity, outfit design, colors, fabric details, and accessories).
2. `refs/rows/{job_id}.png` — Target pet's finished `{job_id}` row strip (lock exact poses, frame-by-frame motion, proportions, and facing direction).

Outfit description:
{desc}

Layout & quality rules:
- Output EXACTLY {count} full-body frames in one left-to-right row on a perfectly flat pure {chroma_name} ({chroma_hex}) background.
- Place one complete pose per evenly spaced invisible slot with clear empty {chroma_name} gaps between neighboring frames (no touching or overlapping poses).
- {extra}
- Preserve the pet's natural proportions and ground line; do NOT inflate or stretch the character to fill the cell height.
- Crisp opaque edges only. No floor, shadows, text, borders, glows, sparkles, or {chroma_name} hues inside the character or outfit.
"""
        (jobs_dir / f"{job_id}.txt").write_text(prompt, encoding="utf-8")

    if include_sleep:
        _write_sleep_prompt(
            jobs_dir, pet, outfit_id, outfit_label, desc, chroma, loop_frames=sleep_loop_frames
        )


# ---------- state helpers ----------


def _state_path(work_dir):
    return Path(work_dir) / "outfit-state.json"


def _load_state(work_dir):
    p = _state_path(work_dir)
    if not p.is_file():
        raise Problem(f"找不到工作状态文件：{p}。请先运行 dress.py init。")
    return _read_json(p)


def _compute_status(state):
    jobs = state["jobs"]
    order = state["jobOrder"]
    approved = [jid for jid in order if jobs[jid]["status"] == "accepted"]
    approved_set = set(approved)
    failed = [jid for jid in order if jobs[jid]["status"] == "failed"]
    pending = [jid for jid in order if jobs[jid]["status"] != "accepted"]
    all_ready = [
        jid
        for jid in order
        if jobs[jid]["status"] != "accepted"
        and set(jobs[jid].get("depends_on", [])) <= approved_set
    ]
    ready = all_ready[:3]
    next_action = (
        "compose"
        if not pending
        else (
            "approve base look with user first"
            if "base" in jobs and "base" not in approved_set
            else f"generate & accept ready rows: {', '.join(ready)}"
        )
    )
    return {
        "petId": state["petId"],
        "petName": state["petName"],
        "mode": state.get("mode", "full"),
        "outfit": state["outfit"],
        "layout": state["layout"],
        "chromaKey": state["chromaKey"]["hex"],
        "approved": approved,
        "pending": pending,
        "failed": failed,
        "ready": ready,
        "totalReady": len(all_ready),
        "remaining": len(pending),
        "total": len(order),
        "composed": bool(state.get("composed")),
        "nextAction": next_action,
    }


# ---------- subcommands ----------


def cmd_pets(args):
    pets = all_installed_pets()
    if args.json:
        payload = []
        for item in pets:
            p = item["pet"]
            wardrobe = p.get("wardrobe") or {}
            payload.append(
                {
                    "id": p["id"],
                    "displayName": p["displayName"],
                    "layout": item["layout"],
                    "size": item["size"],
                    "hasSleepStrip": _find_base_sleep_strip(item["dir"], p) is not None,
                    "outfits": wardrobe.get("outfits", []),
                    "schedule": wardrobe.get("schedule", []),
                }
            )
        print(json.dumps(payload, ensure_ascii=False, indent=2))
        return

    if not pets:
        print(f"随伴里还没有宠物（{data_dir()}）。先用 $make-desktop-pet 制作并导入。")
        return
    for item in pets:
        p = item["pet"]
        wardrobe = p.get("wardrobe") or {}
        outfits = wardrobe.get("outfits", [])
        schedule = wardrobe.get("schedule", [])
        size_str = f"{item['size'][0]}x{item['size'][1]}" if item["size"] else "?"
        sleep_tag = " · 带睡眠动画" if _find_base_sleep_strip(item["dir"], p) is not None else ""
        print(
            f"{p['displayName']}  编号 {p['id']}  规格 {item['layout'].upper()} ({size_str}){sleep_tag}  "
            f"已有 {len(outfits)} 套衣服、{len(schedule)} 条换装规则"
        )
        for o in outfits:
            o_sleep = f" + {o['sleepStrip']}" if o.get("sleepStrip") else ""
            print(f"  衣服 {o['id']}：{o['displayName']} ({o['spritesheetPath']}{o_sleep})")
        for r in schedule:
            off = "（已停用）" if r.get("enabled") is False else ""
            print(f"  规则 {r['outfit']}{off}：{_format_when(r.get('when', {}))}")


def cmd_init(args):
    work_dir = ensure_safe_work_dir(args.dir, SKILL)
    if work_dir.exists() and any(work_dir.iterdir()):
        raise Problem("工作目录非空。要继续已有任务请运行 dress.py status；新任务请换一个空白目录。")

    outfit_id = args.outfit.strip()
    if not SAFE_ID_RE.match(outfit_id) or outfit_id in ("default", "auto"):
        raise Problem("服装编号必须是 1–32 位小写字母/数字/连字符/下划线，且不能为 default 或 auto。")

    only_sleep = bool(args.only_sleep)
    no_sleep = bool(args.no_sleep)
    if only_sleep and (no_sleep or args.preset or args.schedule_json):
        raise Problem("--only-sleep 补丁模式不能与 --no-sleep、--preset 或 --schedule-json 同用。")

    pet_dir, pet, sheet_path, layout, atlas_size = load_installed_pet(args.pet)
    base_sleep_path = _find_base_sleep_strip(pet_dir, pet)

    installed_outfit_atlas = None
    if only_sleep:
        existing_outfits = (pet.get("wardrobe") or {}).get("outfits", [])
        match = next((o for o in existing_outfits if o.get("id") == outfit_id), None)
        if match is None:
            known = ", ".join(o.get("id", "") for o in existing_outfits) or "无"
            raise Problem(
                f"宠物 {pet['id']} 的衣柜里还没有编号为 {outfit_id} 的衣服（已有：{known}）。--only-sleep 只能给已安装的衣服补做睡眠动画。"
            )
        installed_outfit_atlas = (pet_dir / match["spritesheetPath"]).resolve()
        if not installed_outfit_atlas.is_relative_to(pet_dir.resolve()) or not installed_outfit_atlas.is_file():
            raise Problem(f"找不到已安装衣服图集：{match['spritesheetPath']}")
        if base_sleep_path is None:
            raise Problem(f"宠物 {pet['id']} 本身没有基础睡眠横条（sleepStrip），无法使用 --only-sleep。")
        label = (args.label or match["displayName"]).strip()
        desc = (args.desc or f"the exact outfit worn in approved/base.png ({label})").strip()
        schedule_rule = None
        include_sleep = True
    else:
        if not args.label or not args.label.strip():
            raise Problem("新建服装必须提供 --label（1–40 个字符的服装名称）。")
        label = args.label.strip()
        if not (1 <= len(label) <= 40):
            raise Problem("服装名称长度需在 1–40 个字符之间。")
        if not args.desc or len(args.desc.strip()) < 4:
            raise Problem("请用 --desc 描述新衣服的外观细节（至少 4 个字符）。")
        desc = args.desc.strip()

        if args.preset and args.schedule_json:
            raise Problem("--preset 和 --schedule-json 不能同时传入，请二选一。")

        schedule_rule = None
        if args.preset:
            schedule_rule = validate_schedule_rule(
                {"outfit": outfit_id, "when": PRESET_SCHEDULES[args.preset]}, outfit_id
            )
        elif args.schedule_json:
            try:
                parsed = json.loads(args.schedule_json)
            except ValueError as exc:
                raise Problem(f"--schedule-json 不是合法 JSON：{exc}") from exc
            schedule_rule = validate_schedule_rule(parsed, outfit_id)
        include_sleep = (base_sleep_path is not None) and (not no_sleep)

    if args.chroma_key:
        rgb = list(_parse_hex(args.chroma_key))
        chroma = {"hex": args.chroma_key.upper(), "name": args.chroma_key.upper(), "rgb": rgb}
    else:
        chroma = pick_safe_chroma_key(desc)

    work_dir.mkdir(parents=True, exist_ok=True)
    refs_dir = work_dir / "refs"
    rows_dir = refs_dir / "rows"
    rows_dir.mkdir(parents=True, exist_ok=True)
    for sub in ("approved", "registered", "qa", "history", "outfits"):
        (work_dir / sub).mkdir(parents=True, exist_ok=True)

    anchors = {
        "petId": pet["id"],
        "layout": layout,
        "atlasSize": list(atlas_size),
        "cellSize": [CELL_W, CELL_H],
        "rows": {},
    }
    row_list = list(STANDARD_ROWS) + (list(GAZE_ROWS) if layout == "v2" else [])
    with Image.open(sheet_path) as src_im:
        atlas = src_im.convert("RGBA")
        idle0 = atlas.crop((0, 0, CELL_W, CELL_H))
        idle0.save(refs_dir / "base-idle-0.png")
        idle0.resize((CELL_W * 2, CELL_H * 2), Image.Resampling.LANCZOS).save(
            refs_dir / "base-idle-0-2x.png"
        )
        if not only_sleep:
            for job_id, _, row_idx, durs in row_list:
                count = len(durs)
                is_gaze = job_id.startswith("gaze-")
                y0 = row_idx * CELL_H
                strip = atlas.crop((0, y0, CELL_W * count, y0 + CELL_H))
                strip.save(rows_dir / f"{job_id}.png")
                anchors["rows"][job_id] = _extract_strip_anchor(
                    strip, count, row_index=row_idx, is_gaze=is_gaze
                )

    if include_sleep and base_sleep_path is not None:
        with Image.open(base_sleep_path) as sleep_im:
            sleep_rgba = sleep_im.convert("RGBA")
            sleep_rgba.save(rows_dir / "sleep.png")
            anchors["rows"]["sleep"] = _extract_strip_anchor(
                sleep_rgba, SLEEP_FRAMES, row_index=None, is_gaze=False
            )

    if only_sleep and installed_outfit_atlas is not None:
        with Image.open(installed_outfit_atlas) as out_im:
            outfit_idle0 = out_im.convert("RGBA").crop((0, 0, CELL_W, CELL_H))
            outfit_idle0.save(work_dir / "approved/base.png")
            outfit_idle0.resize((CELL_W * 2, CELL_H * 2), Image.Resampling.LANCZOS).save(
                work_dir / "approved/base-2x.png"
            )

    sleep_loop_frames, sleep_durations = (
        _resolve_sleep_timing(pet_dir, SLEEP_FRAMES) if include_sleep else (None, None)
    )
    _write_json(refs_dir / "anchor.json", anchors)
    _write_prompts(
        work_dir,
        pet,
        outfit_id,
        label,
        desc,
        chroma,
        layout,
        include_sleep=include_sleep,
        only_sleep=only_sleep,
        sleep_loop_frames=sleep_loop_frames,
    )

    if only_sleep:
        job_order = ["sleep"]
        jobs = {
            "sleep": {
                "status": "pending",
                "depends_on": [],
                "frames": SLEEP_FRAMES,
                "label": "睡觉",
                "prompt": "jobs/sleep.txt",
                "references": ["approved/base.png", "refs/rows/sleep.png"],
            }
        }
        outfit_meta = {
            "id": outfit_id,
            "displayName": label,
            "description": desc,
            "sleepStrip": f"outfits/{outfit_id}-sleep.png",
        }
    else:
        job_order = ["base"] + [name for name, _, _, _ in row_list]
        jobs = {
            "base": {
                "status": "pending",
                "depends_on": [],
                "prompt": "jobs/base.txt",
                "references": ["refs/base-idle-0-2x.png"],
            }
        }
        for job_id, cn_label, row_idx, durs in row_list:
            jobs[job_id] = {
                "status": "pending",
                "depends_on": ["base"],
                "row": row_idx,
                "frames": len(durs),
                "label": cn_label,
                "prompt": f"jobs/{job_id}.txt",
                "references": ["approved/base.png", f"refs/rows/{job_id}.png"],
            }
        outfit_meta = {
            "id": outfit_id,
            "displayName": label,
            "description": desc,
            "spritesheetPath": f"outfits/{outfit_id}.webp",
        }
        if include_sleep:
            job_order.append("sleep")
            jobs["sleep"] = {
                "status": "pending",
                "depends_on": ["base"],
                "frames": SLEEP_FRAMES,
                "label": "睡觉",
                "prompt": "jobs/sleep.txt",
                "references": ["approved/base.png", "refs/rows/sleep.png"],
            }
            outfit_meta["sleepStrip"] = f"outfits/{outfit_id}-sleep.png"

    state = {
        "version": 1,
        "mode": "only-sleep" if only_sleep else "full",
        "createdAt": _now(),
        "petId": pet["id"],
        "petName": pet["displayName"],
        "baseSpritesheet": str(sheet_path),
        "baseSleepStrip": str(base_sleep_path) if base_sleep_path else None,
        "sleepLoopFrames": sleep_loop_frames,
        "sleepDurations": sleep_durations,
        "layout": layout,
        "atlasSize": list(atlas_size),
        "outfit": outfit_meta,
        "scheduleRule": schedule_rule,
        "chromaKey": chroma,
        "jobOrder": job_order,
        "jobs": jobs,
        "composed": None,
        "history": [],
    }
    _write_json(_state_path(work_dir), state)
    summary = _compute_status(state)
    summary["workDir"] = str(work_dir)
    summary["scheduleRule"] = schedule_rule
    summary["includesSleep"] = include_sleep
    print(json.dumps(summary, ensure_ascii=False, indent=2))


def cmd_status(args):
    work_dir = Path(args.dir).expanduser().resolve()
    state = _load_state(work_dir)
    print(json.dumps(_compute_status(state), ensure_ascii=False, indent=2))


def cmd_accept(args):
    work_dir = Path(args.dir).expanduser().resolve()
    state = _load_state(work_dir)
    jobs = state["jobs"]
    job_id = args.job
    if job_id not in jobs:
        raise Problem(f"未知任务：{job_id}。可选：{', '.join(state['jobOrder'])}")

    entry = jobs[job_id]
    approved_set = {k for k, v in jobs.items() if v["status"] == "accepted"}
    unmet = [dep for dep in entry.get("depends_on", []) if dep not in approved_set]
    if unmet:
        raise Problem(
            f"任务 {job_id} 的前置任务尚未确认：{', '.join(unmet)}。请先完成并让用户确认定妆图 base。"
        )
    if job_id == "base" and args.reviewer != "user":
        raise Problem("定妆图 base 必须先给用户看并确认，请使用 --reviewer user 登记。")

    img_path = Path(args.image).expanduser().resolve()
    if not img_path.is_file():
        raise Problem(f"图片不存在：{img_path}")
    with Image.open(img_path) as check_im:
        check_im.verify()

    sha = _digest(img_path)
    backup_rel = f"history/{_ts_slug()}-{job_id}-{sha[:8]}{img_path.suffix.lower() or '.png'}"
    backup_dst = work_dir / backup_rel
    backup_dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(img_path, backup_dst)

    key_rgb = tuple(state["chromaKey"]["rgb"])
    result_info = {"job": job_id, "sha256": sha, "backup": backup_rel}

    if job_id == "base":
        base_out = work_dir / "approved/base.png"
        base_out.parent.mkdir(parents=True, exist_ok=True)
        with Image.open(img_path) as im:
            im.convert("RGBA").save(base_out)
            cleaned, bg_mode = remove_background(im, key_rgb)
            bg = Image.new("RGBA", cleaned.size, (240, 243, 236, 255))
            bg.alpha_composite(cleaned)
            preview_path = work_dir / "qa/base-preview.png"
            preview_path.parent.mkdir(parents=True, exist_ok=True)
            bg.convert("RGB").save(preview_path)
        entry.update(
            {
                "status": "accepted",
                "sha256": sha,
                "reviewer": args.reviewer,
                "note": args.note,
                "at": _now(),
                "backup": backup_rel,
                "qa": {"preview": "qa/base-preview.png"},
                "backgroundMode": bg_mode,
            }
        )
        result_info["qa"] = entry["qa"]
    else:
        anchors = _read_json(work_dir / "refs/anchor.json")
        row_anchor = anchors["rows"][job_id]
        _, _, durs = ALL_ROW_META[job_id]
        frame_count = len(durs)
        with Image.open(img_path) as raw_im:
            cleaned, bg_mode = remove_background(raw_im, key_rgb)
        cells, reg_strip, metrics = register_row_to_anchor(
            cleaned, frame_count, row_anchor, equal_slots=args.equal_slots
        )
        row_reg_dir = work_dir / "registered" / job_id
        row_reg_dir.mkdir(parents=True, exist_ok=True)
        for idx, cell in enumerate(cells):
            cell.save(row_reg_dir / f"{idx:02d}.png")
        reg_strip.save(work_dir / "registered" / f"{job_id}.png")

        qa_sheet = work_dir / "qa" / f"{job_id}-sheet.png"
        qa_gif = work_dir / "qa" / f"{job_id}.gif"
        row_durs = (
            state.get("sleepDurations") or durs
            if job_id == "sleep"
            else durs
        )
        row_loop = (
            state.get("sleepLoopFrames") or SLEEP_DEFAULT_LOOP_FRAMES
            if job_id == "sleep"
            else None
        )
        _render_row_qa(
            work_dir / "refs/rows" / f"{job_id}.png",
            cells,
            row_durs,
            qa_sheet,
            qa_gif,
            job_id,
            loop_frames=row_loop,
        )
        sleep_loop_qa = inspect_sleep_loop(cells, row_loop) if job_id == "sleep" else None

        entry.update(
            {
                "status": "accepted",
                "sha256": sha,
                "reviewer": args.reviewer,
                "note": args.note,
                "at": _now(),
                "backup": backup_rel,
                "backgroundMode": bg_mode,
                "anchorMetrics": metrics,
                "qa": {
                    "sheet": f"qa/{job_id}-sheet.png",
                    "gif": f"qa/{job_id}.gif",
                },
            }
        )
        if sleep_loop_qa is not None:
            entry["sleepLoopQa"] = sleep_loop_qa
            result_info["sleepLoopQa"] = sleep_loop_qa
        result_info["anchorMetrics"] = metrics
        result_info["qa"] = entry["qa"]

    # Invalidate previously composed atlas whenever any job changes.
    state["composed"] = None
    _write_json(_state_path(work_dir), state)
    result_info["status"] = _compute_status(state)
    print(json.dumps(result_info, ensure_ascii=False, indent=2))


def cmd_repair(args):
    work_dir = Path(args.dir).expanduser().resolve()
    state = _load_state(work_dir)
    jobs = state["jobs"]
    job_id = args.job
    if job_id not in jobs:
        raise Problem(f"未知任务：{job_id}。")

    affected = {job_id}
    while True:
        expanded = affected | {
            k for k, v in jobs.items() if set(v.get("depends_on", [])) & affected
        }
        if expanded == affected:
            break
        affected = expanded

    archive = work_dir / "history" / f"{_ts_slug()}-repair-{job_id}"
    archive.mkdir(parents=True, exist_ok=True)
    for k in sorted(affected):
        if k == "base":
            src = work_dir / "approved/base.png"
            if src.is_file():
                shutil.move(str(src), str(archive / "base.png"))
        else:
            strip = work_dir / "registered" / f"{k}.png"
            if strip.is_file():
                shutil.move(str(strip), str(archive / f"{k}.png"))
            folder = work_dir / "registered" / k
            if folder.is_dir():
                shutil.move(str(folder), str(archive / k))
        jobs[k]["status"] = "pending"
        jobs[k]["repairReason"] = args.reason

    state["composed"] = None
    state["history"].append(
        {
            "at": _now(),
            "action": "repair",
            "job": job_id,
            "affected": sorted(affected),
            "reason": args.reason,
            "archive": str(archive.relative_to(work_dir)),
        }
    )
    _write_json(_state_path(work_dir), state)
    print(
        json.dumps(
            {
                "repaired": job_id,
                "affected": sorted(affected),
                "archive": str(archive.relative_to(work_dir)),
                "status": _compute_status(state),
            },
            ensure_ascii=False,
            indent=2,
        )
    )


def cmd_compose(args):
    work_dir = Path(args.dir).expanduser().resolve()
    state = _load_state(work_dir)
    jobs = state["jobs"]
    missing = [jid for jid in state["jobOrder"] if jobs[jid]["status"] != "accepted"]
    if missing:
        raise Problem(f"还有未确认的任务，暂时不能拼装：{', '.join(missing)}")

    mode = state.get("mode", "full")
    layout = state["layout"]
    atlas_h = V2_HEIGHT if layout == "v2" else V1_HEIGHT
    anchors = _read_json(work_dir / "refs/anchor.json")
    report = {
        "ok": True,
        "mode": mode,
        "layout": layout,
        "at": _now(),
    }

    if mode != "only-sleep":
        atlas = Image.new("RGBA", (ATLAS_W, atlas_h), (0, 0, 0, 0))
        row_list = list(STANDARD_ROWS) + (list(GAZE_ROWS) if layout == "v2" else [])

        for job_id, _, row_idx, durs in row_list:
            count = len(durs)
            for col in range(count):
                frame_path = work_dir / "registered" / job_id / f"{col:02d}.png"
                if not frame_path.is_file():
                    raise Problem(f"缺少已配准帧：{frame_path}")
                with Image.open(frame_path) as im:
                    cell = im.convert("RGBA")
                    if cell.size != (CELL_W, CELL_H):
                        raise Problem(f"帧尺寸错误：{frame_path} 为 {cell.size}")
                    atlas.paste(cell, (col * CELL_W, row_idx * CELL_H))

        # Populate V2 neutral pose cell (row 0, col 6) from outfit idle/00.
        neutral_populated = False
        if layout == "v2":
            idle0 = atlas.crop((0, 0, CELL_W, CELL_H))
            atlas.paste(idle0, (6 * CELL_W, 0))
            neutral_populated = True

        out_rel = state["outfit"]["spritesheetPath"]
        out_path = work_dir / out_rel
        _save_webp(atlas, out_path)

        # Deterministic validation on the saved WebP bytes.
        errors = []
        if out_path.stat().st_size > MAX_IMAGE_BYTES:
            errors.append("服装图集超过 32 MiB。")
        with Image.open(out_path) as verify_im:
            if verify_im.size != (ATLAS_W, atlas_h):
                errors.append(f"尺寸不匹配：期望 {ATLAS_W}x{atlas_h}，实际 {verify_im.size}")
            rgba = verify_im.convert("RGBA")
            alpha = rgba.getchannel("A")
            if alpha.getextrema()[0] != 0:
                errors.append("图集缺少透明背景。")
            expected_counts = {row_idx: len(durs) for _, _, row_idx, durs in row_list}
            for row_idx, count in expected_counts.items():
                for col in range(8):
                    cell_a = alpha.crop((col * CELL_W, row_idx * CELL_H, (col + 1) * CELL_W, (row_idx + 1) * CELL_H))
                    occupied = cell_a.point(lambda v: 255 if v > 8 else 0).getbbox() is not None
                    if col < count:
                        if not occupied:
                            errors.append(f"有效格 ({row_idx}, {col}) 为空。")
                    elif layout == "v2" and row_idx == 0 and col == 6:
                        if not occupied:
                            errors.append("V2 中立格 (0, 6) 未填充。")
                    else:
                        if occupied:
                            errors.append(f"非活跃格 ({row_idx}, {col}) 含有残留像素。")

            idle_ref = anchors["rows"]["idle"]["frames"][0]
            b0 = _solid_bbox(rgba.crop((0, 0, CELL_W, CELL_H)))
            if b0 is None:
                errors.append("idle 第 0 帧为空。")
                anchor_check = {"ok": False}
            else:
                h_actual = b0[3] - b0[1]
                h_target = idle_ref["height"]
                h_diff_ratio = abs(h_actual - h_target) / float(max(1, h_target))
                foot_diff = abs(b0[3] - idle_ref["foot_y"])
                anchor_ok = h_diff_ratio <= 0.08 and foot_diff <= 6
                if not anchor_ok:
                    errors.append(
                        f"锚点漂移过大：身高 {h_actual}px (参考 {h_target}px)，脚底 Y={b0[3]} (参考 {idle_ref['foot_y']})"
                    )
                anchor_check = {
                    "ok": anchor_ok,
                    "actualHeight": h_actual,
                    "targetHeight": h_target,
                    "actualFootY": b0[3],
                    "targetFootY": idle_ref["foot_y"],
                }

        if errors:
            raise Problem("拼装校验失败：" + "；".join(errors))

        compare_path = work_dir / "qa/compare-base-vs-outfit.png"
        _render_base_vs_outfit_comparison(Path(state["baseSpritesheet"]), out_path, layout, compare_path)
        report.update(
            {
                "output": out_rel,
                "sha256": _digest(out_path),
                "bytes": out_path.stat().st_size,
                "size": [ATLAS_W, atlas_h],
                "neutralCellPopulated": neutral_populated,
                "anchorCheck": anchor_check,
                "comparison": "qa/compare-base-vs-outfit.png",
            }
        )

    if "sleep" in state["jobOrder"]:
        sleep_cells = []
        sleep_strip = Image.new("RGBA", (CELL_W * SLEEP_FRAMES, CELL_H), (0, 0, 0, 0))
        for col in range(SLEEP_FRAMES):
            frame_path = work_dir / "registered/sleep" / f"{col:02d}.png"
            if not frame_path.is_file():
                raise Problem(f"缺少已配准睡眠帧：{frame_path}")
            with Image.open(frame_path) as im:
                cell = im.convert("RGBA")
                if cell.size != (CELL_W, CELL_H):
                    raise Problem(f"睡眠帧尺寸错误：{frame_path} 为 {cell.size}")
                sleep_cells.append(cell)
                sleep_strip.paste(cell, (col * CELL_W, 0))

        sleep_rel = state["outfit"]["sleepStrip"]
        sleep_path = work_dir / sleep_rel
        sleep_path.parent.mkdir(parents=True, exist_ok=True)
        sleep_strip.save(sleep_path, format="PNG")

        sleep_errors = []
        if sleep_path.stat().st_size > SLEEP_MAX_BYTES:
            sleep_errors.append("睡眠横条超过 4 MiB。")
        with Image.open(sleep_path) as s_im:
            if s_im.format != "PNG" or s_im.size != (CELL_W * SLEEP_FRAMES, CELL_H):
                sleep_errors.append(
                    f"睡眠横条应为 PNG {CELL_W * SLEEP_FRAMES}x{CELL_H}，实际 {s_im.format} {s_im.size}"
                )
            s_rgba = s_im.convert("RGBA")
            s_alpha = s_rgba.getchannel("A")
            if s_alpha.getextrema()[0] != 0:
                sleep_errors.append("睡眠横条缺少透明背景。")
            for col in range(SLEEP_FRAMES):
                if s_alpha.crop((col * CELL_W, 0, (col + 1) * CELL_W, CELL_H)).getbbox() is None:
                    sleep_errors.append(f"睡眠横条第 {col + 1} 帧为空。")
            sleep_ref = anchors["rows"]["sleep"]["frames"][0]
            sb0 = _solid_bbox(s_rgba.crop((0, 0, CELL_W, CELL_H)))
            if sb0 is None:
                sleep_errors.append("睡眠第 0 帧为空。")
                sleep_anchor_check = {"ok": False}
            else:
                sh_actual = sb0[3] - sb0[1]
                sh_target = sleep_ref["height"]
                sh_diff = abs(sh_actual - sh_target) / float(max(1, sh_target))
                sfoot_diff = abs(sb0[3] - sleep_ref["foot_y"])
                s_ok = sh_diff <= 0.08 and sfoot_diff <= 6
                if not s_ok:
                    sleep_errors.append(
                        f"睡眠锚点漂移过大：身高 {sh_actual}px (参考 {sh_target}px)，脚底 Y={sb0[3]} (参考 {sleep_ref['foot_y']})"
                    )
                sleep_anchor_check = {
                    "ok": s_ok,
                    "actualHeight": sh_actual,
                    "targetHeight": sh_target,
                    "actualFootY": sb0[3],
                    "targetFootY": sleep_ref["foot_y"],
                }

        if sleep_errors:
            raise Problem("睡眠横条校验失败：" + "；".join(sleep_errors))

        sleep_loop = state.get("sleepLoopFrames") or SLEEP_DEFAULT_LOOP_FRAMES
        sleep_durs = state.get("sleepDurations") or SLEEP_DURATIONS
        sleep_loop_qa = inspect_sleep_loop(sleep_cells, sleep_loop)
        _render_row_qa(
            work_dir / "refs/rows/sleep.png",
            sleep_cells,
            sleep_durs,
            work_dir / "qa/compare-sleep.png",
            work_dir / "qa/sleep.gif",
            "sleep",
            loop_frames=sleep_loop,
        )
        report.update(
            {
                "sleepOutput": sleep_rel,
                "sleepSha256": _digest(sleep_path),
                "sleepBytes": sleep_path.stat().st_size,
                "sleepSize": [CELL_W * SLEEP_FRAMES, CELL_H],
                "sleepLoopFrames": sleep_loop,
                "sleepAnchorCheck": sleep_anchor_check,
                "sleepLoopQa": sleep_loop_qa,
                "sleepComparison": "qa/compare-sleep.png",
                "sleepGif": "qa/sleep.gif",
            }
        )

    _write_json(work_dir / "qa/compose-report.json", report)
    state["composed"] = report
    _write_json(_state_path(work_dir), state)
    print(json.dumps(report, ensure_ascii=False, indent=2))


def cmd_deliver(args):
    work_dir = Path(args.dir).expanduser().resolve()
    state = _load_state(work_dir)
    composed = state.get("composed")
    if not composed:
        raise Problem("尚未拼装服装资源，请先运行 dress.py compose。")

    mode = state.get("mode", "full")
    outfit_entry = {
        "id": state["outfit"]["id"],
        "displayName": state["outfit"]["displayName"],
    }
    include = ["outfit.json"]

    if mode != "only-sleep":
        out_rel = state["outfit"]["spritesheetPath"]
        out_path = work_dir / out_rel
        if not out_path.is_file():
            raise Problem(f"找不到服装图集：{out_path}")
        if _digest(out_path) != composed.get("sha256"):
            raise Problem("服装图集文件已变化，请重新运行 dress.py compose 校验后再交付。")
        outfit_entry["spritesheetPath"] = out_rel
        include.append(out_rel)

    if composed.get("sleepOutput"):
        sleep_rel = composed["sleepOutput"]
        sleep_path = work_dir / sleep_rel
        if not sleep_path.is_file():
            raise Problem(f"找不到服装睡眠横条：{sleep_path}")
        if _digest(sleep_path) != composed.get("sleepSha256"):
            raise Problem("服装睡眠横条已变化，请重新运行 dress.py compose 校验后再交付。")
        outfit_entry["sleepStrip"] = sleep_rel
        include.append(sleep_rel)

    manifest = {
        "petId": state["petId"],
        "outfit": outfit_entry,
    }
    if mode != "only-sleep" and state.get("scheduleRule"):
        manifest["scheduleRule"] = state["scheduleRule"]

    _write_json(work_dir / "outfit.json", manifest)

    pkg_prefix = "outfit-sleep" if mode == "only-sleep" else "outfit"
    try:
        receipt = deliver(
            work_dir,
            include,
            f"{pkg_prefix}-{state['petId']}-{state['outfit']['id']}",
            wait=args.wait,
        )
    except Refused as exc:
        raise Problem("随伴拒收了这套服装：" + str(exc)) from exc

    if receipt["status"] == "received":
        if mode == "only-sleep":
            receipt["message"] = f"「{state['outfit']['displayName']}」的同款睡眠动画已更新到 {state['petName']} 的衣柜里。"
        else:
            receipt["message"] = (
                f"「{state['outfit']['displayName']}」已更新到 {state['petName']} 的衣柜里。"
                if receipt.get("updated")
                else f"「{state['outfit']['displayName']}」已送进 {state['petName']} 的衣柜，随伴主窗口会弹出来。"
            )
    else:
        receipt["message"] = "随伴现在没有运行。服装包已放进收件箱，下次打开随伴会自动加入衣柜。"
    print(json.dumps(receipt, ensure_ascii=False, indent=2))


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    p_pets = sub.add_parser("pets", help="列出随伴里已安装的宠物与衣柜状态")
    p_pets.add_argument("--json", action="store_true", help="以 JSON 格式输出")

    p_init = sub.add_parser("init", help="初始化新衣服工作目录、提取原宠参考条与锚点")
    p_init.add_argument("--pet", required=True, help="目标宠物编号（petId）")
    p_init.add_argument("--outfit", required=True, help="服装唯一编号（如 pajamas）")
    p_init.add_argument("--label", help="服装显示名称（如 睡衣；--only-sleep 模式可省略）")
    p_init.add_argument("--desc", help="服装外观描述（用于双参考生图与自动避色；--only-sleep 模式可省略）")
    p_init.add_argument("--dir", type=Path, required=True, help="独立空白工作目录")
    p_init.add_argument(
        "--preset",
        choices=sorted(PRESET_SCHEDULES.keys()),
        help="可选预设自动换装时间表",
    )
    p_init.add_argument("--schedule-json", help="可选自定义时间表 JSON（完整规则或 when 对象）")
    p_init.add_argument("--chroma-key", help="可选手动指定 #RRGGBB 色键背景")
    p_init.add_argument("--no-sleep", action="store_true", help="跳过同款睡眠动画（即使原宠有 sleepStrip）")
    p_init.add_argument("--only-sleep", action="store_true", help="仅为已安装服装补做 16 帧睡眠横条")

    p_status = sub.add_parser("status", help="查看当前换装进度与下一批可执行任务")
    p_status.add_argument("--dir", type=Path, required=True)

    p_accept = sub.add_parser("accept", help="登记已生成的定妆图或动作行，自动抠图去边与锚定配准")
    p_accept.add_argument("--dir", type=Path, required=True)
    p_accept.add_argument("--job", required=True, help="任务名（base / idle / ... / gaze-2 / sleep）")
    p_accept.add_argument("--image", type=Path, required=True, help="生成的图片路径")
    p_accept.add_argument("--reviewer", choices=["user", "agent"], default="agent")
    p_accept.add_argument("--note", default="", help="检查备注")
    p_accept.add_argument("--equal-slots", action="store_true", help="按等宽格子切分横条")

    p_repair = sub.add_parser("repair", help="局部返工指定任务（保留其他已通过动作行）")
    p_repair.add_argument("--dir", type=Path, required=True)
    p_repair.add_argument("--job", required=True)
    p_repair.add_argument("--reason", required=True)

    p_compose = sub.add_parser("compose", help="拼装完整 V1/V2 服装图集并渲染对比验收图")
    p_compose.add_argument("--dir", type=Path, required=True)

    p_deliver = sub.add_parser("deliver", help="生成增量 outfit.json 并原子送进随伴收件箱")
    p_deliver.add_argument("--dir", type=Path, required=True)
    p_deliver.add_argument("--wait", type=float, default=8.0)

    args = parser.parse_args()
    handlers = {
        "pets": cmd_pets,
        "init": cmd_init,
        "status": cmd_status,
        "accept": cmd_accept,
        "repair": cmd_repair,
        "compose": cmd_compose,
        "deliver": cmd_deliver,
    }
    try:
        handlers[args.command](args)
    except (Problem, ValueError) as exc:
        raise SystemExit(str(exc))


if __name__ == "__main__":
    main()
