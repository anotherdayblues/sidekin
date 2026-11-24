#!/usr/bin/env python3
"""Install this project's Skills without overwriting any existing skill."""

import os
from pathlib import Path

root = Path(__file__).resolve().parents[1] / "skills"
codex = Path(os.environ.get("CODEX_HOME", str(Path.home() / ".codex")))
for source in sorted(p.parent for p in root.glob("*/SKILL.md")):
    name = source.name
    target = codex / "skills" / name
    target.parent.mkdir(parents=True, exist_ok=True)
    if target.is_symlink() and target.resolve() == source:
        print(f"Already installed: {target}")
    elif target.exists() or target.is_symlink():
        raise SystemExit(
            f"Existing skill preserved: {target}. Choose another skill name or inspect it first."
        )
    else:
        target.symlink_to(source, target_is_directory=True)
        print(f"Installed: {target} -> {source}")
