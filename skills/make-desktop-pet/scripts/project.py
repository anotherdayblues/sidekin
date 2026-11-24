#!/usr/bin/env python3
"""Track grounded visual jobs, preserving accepted work across repairs."""

import argparse
import hashlib
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path

from deliver import ensure_safe_work_dir
from PIL import Image
from work_row import apply as apply_work_row

SKILL = Path(__file__).resolve().parents[1]
WALK_GAIT_LINE = (
    "Gait style: Use a calm, natural everyday walking gait "
    "(steady, gentle steps with feet near the ground and relaxed posture) "
    "rather than a fast sprint, gallop, or wide-leap run."
)
PROCESS_WORDS = re.compile(
    r"动作|帧|方向|注视|步态|图集|衔接|验收|生成|制作|"
    r"\b(?:frames?|rows?|atlas|animations?|directions?|sprite ?sheet)\b",
    re.IGNORECASE,
)


def read(path):
    return json.loads(path.read_text())


def save(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + "\n")


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def apply_walk_gait(run):
    for parent in ("rows", "row-retries"):
        for state in ("running-right", "running-left"):
            path = run / "prompts" / parent / f"{state}.md"
            if path.is_file():
                text = path.read_text()
                if WALK_GAIT_LINE not in text:
                    path.write_text(text.rstrip() + "\n\n" + WALK_GAIT_LINE + "\n")


def status(run):
    manifest = read(run / "imagegen-jobs.json")
    jobs = manifest["jobs"]
    states = read(run / "project-state.json")
    accepted = {
        key for key, value in states["jobs"].items() if value["status"] == "accepted"
    }
    return (
        manifest,
        states,
        accepted,
        [
            j["id"]
            for j in jobs
            if j["id"] not in accepted and set(j.get("depends_on", [])) <= accepted
        ],
    )


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ["prepare", "status", "accept", "repair"]:
        p = sub.add_parser(name)
        p.add_argument("--run", type=Path, required=True)
        if name == "prepare":
            p.add_argument("--name", required=True)
            p.add_argument(
                "--id",
                help="Stable ASCII identifier; inferred from run folder when omitted.",
            )
            p.add_argument(
                "--notes",
                required=True,
                help="Appearance only: species, build, face, markings, palette, material, props.",
            )
            p.add_argument("--description", default="")
            p.add_argument("--style", default="auto")
            p.add_argument("--style-notes", default="")
            p.add_argument("--reference", action="append", default=[])
            p.add_argument("--work-row", choices=["original", "laptop"], default="laptop", help="安静学习实验；original 切回原版")
        if name in ["accept", "repair"]:
            p.add_argument("--job", required=True)
        if name == "accept":
            p.add_argument("--reviewer", choices=["user", "codex"], required=True)
            p.add_argument("--note", required=True)
        if name == "repair":
            p.add_argument("--reason", required=True)
            p.add_argument("--work-row", choices=["original", "laptop"])
    args = parser.parse_args()
    run = args.run.expanduser().resolve()
    if args.command == "prepare":
        try:
            run = ensure_safe_work_dir(run, SKILL)
        except ValueError as exc:
            raise SystemExit(str(exc))
        process = PROCESS_WORDS.findall(args.notes)
        if process:
            # These words describe the job, not the character, and would be
            # repeated inside every image prompt.
            raise SystemExit(
                "--notes 只写长相（体型、脸、花纹、颜色、材质、道具）。"
                f"去掉制作要求：{'、'.join(sorted(set(process)))}"
            )
        if run.exists() and any(run.iterdir()):
            raise SystemExit(
                "Use status to resume the existing run; prepare requires an empty directory."
            )
        pet_id = (
            args.id
            or re.sub(r"[^A-Za-z0-9_-]", "-", run.name).strip("-")
            or ("pet-" + hashlib.sha256(args.name.encode()).hexdigest()[:10])
        )
        cmd = [
            sys.executable,
            str(SKILL / "vendor/hatch-pet/scripts/prepare_pet_run.py"),
            "--pet-name",
            args.name,
            "--pet-id",
            pet_id,
            "--pet-notes",
            args.notes,
            "--style-preset",
            args.style,
            "--output-dir",
            str(run),
        ]
        if args.description:
            cmd += ["--description", args.description]
        if args.style_notes:
            cmd += ["--style-notes", args.style_notes]
        for ref in args.reference:
            cmd += ["--reference", str(Path(ref).expanduser().resolve())]
        subprocess.run(cmd, check=True)
        apply_work_row(run, args.work_row)
        apply_walk_gait(run)
        base_prompt = run / "prompts/base-pet.md"
        base_prompt.write_text(
            base_prompt.read_text().rstrip()
            + "\n\nPose: Use a natural neutral standing or upright resting pose with limbs/feet and key markings clearly visible so later walk, jump, and gaze rows stay proportional; do not copy a sitting, curled, lying-down, or occluded pose from a reference photo.\n"
        )
        jobs = read(run / "imagegen-jobs.json")["jobs"]
        save(
            run / "project-state.json",
            {
                "version": 1,
                "jobs": {j["id"]: {"status": "pending"} for j in jobs},
                "history": [],
            },
        )
    manifest, state, accepted, ready = status(run)
    if args.command in ["accept", "repair"]:
        jobs = {j["id"]: j for j in manifest["jobs"]}
        if args.job not in jobs:
            raise SystemExit("Unknown job: " + args.job)
        if args.command == "repair" and args.work_row and args.job != "running":
            raise SystemExit("--work-row 只用于重做 running 专心工作动作")
        now = datetime.now(timezone.utc).isoformat()
        if args.command == "accept":
            if args.job not in ready:
                raise SystemExit(
                    "This job has unmet dependencies or was already accepted."
                )
            if args.job == "base" and args.reviewer != "user":
                raise SystemExit(
                    "Show the base to the user and record their confirmation first."
                )
            out = run / jobs[args.job]["output_path"]
            with Image.open(out) as img:
                img.verify()
            if args.job == "base":
                shutil.copy2(out, run / "references/canonical-base.png")
            state["jobs"][args.job] = {
                "status": "accepted",
                "sha256": digest(out),
                "reviewer": args.reviewer,
                "note": args.note,
                "at": now,
            }
            jobs[args.job]["status"] = "complete"
        else:
            affected = {args.job}
            while True:
                expanded = affected | {
                    key
                    for key, job in jobs.items()
                    if set(job.get("depends_on", [])) & affected
                }
                if expanded == affected:
                    break
                affected = expanded
            archive = (
                run / "history" / datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")
            )
            archive.mkdir(parents=True)
            for key in affected:
                out = run / jobs[key]["output_path"]
                if out.is_file():
                    shutil.copy2(out, archive / (key + out.suffix))
                state["jobs"][key] = {"status": "pending", "reason": args.reason}
                jobs[key]["status"] = "pending"
            state["history"].append(
                {
                    "at": now,
                    "job": args.job,
                    "affected": sorted(affected),
                    "reason": args.reason,
                    "archive": str(archive.relative_to(run)),
                }
            )
        if args.command == "repair" and args.work_row:
            apply_work_row(run, args.work_row)
        if args.command == "repair" and args.job in ("running-right", "running-left"):
            apply_walk_gait(run)
        save(run / "project-state.json", state)
        save(run / "imagegen-jobs.json", manifest)
        manifest, state, accepted, ready = status(run)
    print(
        json.dumps(
            {
                "accepted": sorted(accepted),
                "ready": ready,
                "remaining": len(manifest["jobs"]) - len(accepted),
            },
            ensure_ascii=False,
        )
    )


if __name__ == "__main__":
    main()
