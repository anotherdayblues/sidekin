"""Hand a finished folder to Pet Studio through its inbox.

The protocol is described in the project's docs/收件箱约定.md. Both skills
carry this same file so each can be installed alone; a test keeps the two
copies identical.
"""

import json
import os
import re
import shutil
import sys
import time
from pathlib import Path


class Refused(Exception):
    """Pet Studio looked at the package and said why it cannot take it."""


def data_dir():
    """Suiby's data folder (Tauri app data dir for app.suiby.desktop)."""
    if os.environ.get("PET_STUDIO_DATA"):
        return Path(os.environ["PET_STUDIO_DATA"]).expanduser()
    name = "app.suiby.desktop"
    if sys.platform == "darwin":
        return Path.home() / "Library/Application Support" / name
    if sys.platform == "win32":
        return Path(os.environ["APPDATA"]) / name
    base = os.environ.get("XDG_DATA_HOME") or str(Path.home() / ".local/share")
    return Path(base) / name


def _overlaps(a, b):
    return a == b or a.is_relative_to(b) or b.is_relative_to(a)


def ensure_safe_work_dir(folder, skill_dir):
    """Reject working/export paths inside skills, app installs, data dirs or git repos."""
    target = Path(folder).expanduser().resolve()
    skill = Path(skill_dir).expanduser().resolve()
    if _overlaps(target, skill) or (
        skill.parent.name == "skills" and _overlaps(target, skill.parent)
    ):
        raise ValueError(
            "工作目录不能放在技能目录里，请改到独立的空白目录（例如系统临时目录）。"
        )
    data = data_dir().expanduser().resolve()
    if _overlaps(target, data):
        raise ValueError(
            "工作目录不能放在随伴数据目录（PET_STUDIO_DATA）里，请改到独立的空白目录。"
        )
    if skill.parent.name == "skills":
        install_root = skill.parent.parent
        if (
            (install_root / "companion-brain.exe").is_file()
            or (install_root / "pet-studio.exe").is_file()
            or any(install_root.glob("*.exe"))
        ) and _overlaps(target, install_root):
            raise ValueError(
                "工作目录不能放在随伴安装目录里，请改到独立的空白目录。"
            )
    for ancestor in (target, *target.parents):
        if ancestor.name.lower().endswith(".app"):
            raise ValueError(
                "工作目录不能放在应用包（.app）内部，请改到独立的空白目录。"
            )
        if (ancestor / "apps" / "desktop").is_dir() and (
            ancestor / "skills"
        ).is_dir():
            raise ValueError(
                "工作目录不能放在随伴项目源码目录里，请改到项目外的独立空白目录（例如系统临时目录）。"
            )
    return target


def deliver(source, include, name, wait=8.0):
    """Copy `include` (paths relative to `source`) into the inbox and wait.

    Returns the app's receipt with "status": "received", or
    {"status": "queued"} when the app is not running (it will pick the
    package up when it next opens). Raises Refused with the app's reason.
    """
    source = Path(source)
    inbox = data_dir() / "inbox"
    inbox.mkdir(parents=True, exist_ok=True)
    name = re.sub(r"[^A-Za-z0-9_-]", "-", name).strip("-") or "package"
    name = f"{name}-{int(time.time() * 1000)}"
    temp = inbox / f".tmp-{name}"
    shutil.rmtree(temp, ignore_errors=True)
    temp.mkdir()
    try:
        for rel in include:
            src = source / rel
            if src.is_dir():
                shutil.copytree(src, temp / rel)
            else:
                (temp / rel).parent.mkdir(parents=True, exist_ok=True)
                shutil.copy2(src, temp / rel)
        # Renaming is atomic: the app never sees a half-copied package.
        temp.rename(inbox / name)
    except BaseException:
        shutil.rmtree(temp, ignore_errors=True)
        raise
    done = inbox / f".done-{name}.json"
    failed = inbox / f".failed-{name}" / "error.txt"
    deadline = time.time() + wait
    while time.time() < deadline:
        if done.exists():
            receipt = json.loads(done.read_text())
            done.unlink()
            return {"status": "received", **receipt}
        if failed.exists():
            raise Refused(failed.read_text())
        time.sleep(0.3)
    return {"status": "queued"}
