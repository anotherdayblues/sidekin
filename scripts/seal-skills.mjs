// Seal bundled skills inside a packaged app: generate SHA-256 integrity manifest
// and mark bundled skill files (and directories on POSIX) read-only.
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";

export const INTEGRITY_FILE = ".integrity.json";
const IGNORED_DIRS = new Set(["__pycache__"]);

function isIgnoredFile(name) {
  return (
    name === INTEGRITY_FILE || name === ".DS_Store" || name.endsWith(".pyc")
  );
}

function walk(dir, onEntry) {
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name),
  )) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      walk(full, onEntry);
      onEntry(full, true);
    } else if (entry.isFile()) {
      if (isIgnoredFile(entry.name)) continue;
      onEntry(full, false);
    }
  }
}

export function unsealSkills(skillsDir) {
  if (!existsSync(skillsDir)) return;
  const dirs = [skillsDir];
  const files = [];
  const collect = (dir) => {
    try {
      const mode = lstatSync(dir).mode;
      if (process.platform !== "win32") chmodSync(dir, mode | 0o200);
    } catch {
      // Ignore if already writable or inaccessible.
    }
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        dirs.push(full);
        collect(full);
      } else if (entry.isFile()) {
        files.push(full);
      }
    }
  };
  collect(skillsDir);
  for (const file of files) {
    const mode = lstatSync(file).mode;
    chmodSync(file, mode | 0o200);
  }
  if (process.platform !== "win32") {
    for (const dir of dirs) {
      const mode = lstatSync(dir).mode;
      chmodSync(dir, mode | 0o200);
    }
  }
}

export function sealSkills(skillsDir) {
  if (!existsSync(skillsDir)) {
    throw new Error("找不到随包技能目录：" + skillsDir);
  }
  unsealSkills(skillsDir);
  const files = {};
  const filePaths = [];
  walk(skillsDir, (full, isDir) => {
    if (!isDir) {
      const rel = path.relative(skillsDir, full).split(path.sep).join("/");
      const hash = createHash("sha256")
        .update(readFileSync(full))
        .digest("hex");
      files[rel] = hash;
      filePaths.push(full);
    }
  });
  const manifestPath = path.join(skillsDir, INTEGRITY_FILE);
  writeFileSync(
    manifestPath,
    JSON.stringify({ version: 1, files }, null, 2) + "\n",
    "utf8",
  );
  filePaths.push(manifestPath);
  // On POSIX, lock files read-only while keeping directories writable so normal
  // `rm -rf` / app upgrades never fail on directory permissions. On Windows,
  // skip the DOS read-only file attribute to avoid unzip/overwrite upgrade errors;
  // integrity + embedded factory auto-restore still protect the files at runtime.
  if (process.platform !== "win32") {
    for (const file of filePaths) {
      const mode = lstatSync(file).mode;
      chmodSync(file, mode & ~0o222);
    }
  }
  return { count: Object.keys(files).length, manifestPath };
}
