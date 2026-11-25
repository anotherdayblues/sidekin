#!/usr/bin/env python3
"""Collect the standalone app, installable Skill, and approved pet package."""

import hashlib
import json
import shutil
import subprocess
import zipfile
from pathlib import Path

root = Path(__file__).resolve().parents[1]
output = root / "dist"
output.mkdir(exist_ok=True)
app = root / "apps/desktop/src-tauri/target/release/bundle/macos/Suiby.app"
if not app.is_dir():
    raise SystemExit("Build the macOS application first: npm run build:desktop")
shutil.copytree(app, output / app.name, dirs_exist_ok=True, symlinks=True)
subprocess.run(
    ["/usr/bin/codesign", "--force", "--deep", "--sign", "-", str(output / app.name)],
    check=True,
)
subprocess.run(
    ["/usr/bin/codesign", "--verify", "--deep", "--strict", str(output / app.name)],
    check=True,
)

files = []
for skill in sorted(p.parent for p in (root / "skills").glob("*/SKILL.md")):
    name = skill.name
    files.append(output / f"{name}-v1.0.0.zip")
    with zipfile.ZipFile(
        output / f"{name}-v1.0.0.zip", "w", zipfile.ZIP_DEFLATED
    ) as archive:
        for path in sorted(skill.rglob("*")):
            if (
                path.is_file()
                and "__pycache__" not in path.parts
                and path.suffix != ".pyc"
            ):
                archive.write(path, str(Path(skill.name) / path.relative_to(skill)))
with zipfile.ZipFile(output / "lizi-v0.1.0.zip", "w", zipfile.ZIP_DEFLATED) as archive:
    for name in ["pet.json", "spritesheet.webp"]:
        archive.write(root / "examples/lizi" / name, name)
files.append(output / "lizi-v0.1.0.zip")
manifest = {
    path.name: {
        "bytes": path.stat().st_size,
        "sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
    }
    for path in files
}
(output / "checksums.json").write_text(json.dumps(manifest, indent=2) + "\n")
print(
    json.dumps(
        {"app": str(output / app.name), "packages": manifest},
        ensure_ascii=False,
        indent=2,
    )
)
