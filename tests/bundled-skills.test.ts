import assert from "node:assert/strict";
import test from "node:test";
import { cpSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { INTEGRITY_FILE, sealSkills, unsealSkills } from "../scripts/seal-skills.mjs";
test("整个技能目录按原结构进入所有安装包", () => {
  const native = path.resolve("apps/desktop/src-tauri");
  const config = JSON.parse(
    readFileSync(path.join(native, "tauri.conf.json"), "utf8"),
  );
  const folders = Object.entries(config.bundle.resources ?? {});
  assert.ok(
    folders.some(
      ([src, dest]) =>
        path.resolve(native, src) === path.resolve("skills") &&
        dest === "skills/",
    ),
  );
});
import { skillPrompt } from "../apps/desktop/src/skillPrompt.ts";
test("复制内容保留当前系统的完整路径、空格、安全红线和版本", () => {
  for (const [base, sep] of [
    ["D:\\Programs With Spaces\\随伴", "\\"],
    ["/Applications/随伴.app/Contents/Resources", "/"],
  ]) {
    for (const id of ["app.suiby.desktop", "app.suiby.desktop.trial"]) {
      const dataRoot = base + sep + id,
        inbox = dataRoot + sep + "inbox",
        manifest = [base, "skills", "future-tool", "SKILL.md"].join(sep);
      const text = skillPrompt({ manifest, dataRoot, inbox }, "我的需求：");
      for (const value of [manifest, dataRoot, inbox])
        assert.ok(text.includes("「" + value + "」"));
      assert.ok(text.includes("只读"));
      assert.ok(text.endsWith("我的需求："));
    }
  }
});

test("打包封签生成完整性清单、锁定只读且不影响只读运行脚本", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "suiban-seal-"));
  const sealed = path.join(tmp, "skills");
  try {
    cpSync(path.resolve("skills"), sealed, { recursive: true });
    const { count, manifestPath } = sealSkills(sealed);
    assert.ok(count >= 3);
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    assert.equal(manifest.version, 1);
    assert.ok(manifest.files["make-desktop-pet/SKILL.md"]);
    assert.ok(manifest.files["teach-desktop-pet/SKILL.md"]);
    assert.ok(manifest.files["find-pet-tool/SKILL.md"]);
    if (process.platform !== "win32") {
      assert.equal(
        statSync(path.join(sealed, "make-desktop-pet/SKILL.md")).mode & 0o222,
        0,
      );
      assert.equal(statSync(path.join(sealed, INTEGRITY_FILE)).mode & 0o222, 0);
      // Directories stay writable so normal rm -rf / app upgrades do not stall.
      assert.notEqual(statSync(sealed).mode & 0o200, 0);
      assert.notEqual(
        statSync(path.join(sealed, "teach-desktop-pet/scripts")).mode & 0o200,
        0,
      );
    }
    // Python scripts inside the sealed read-only skills folder still execute normally.
    const help = execFileSync(
      "python3",
      [path.join(sealed, "find-pet-tool/scripts/tool_card.py"), "--help"],
      { encoding: "utf8" },
    );
    assert.ok(help.includes("send"));
    // Removing a sealed folder directly without unsealing works cleanly.
    rmSync(sealed, { recursive: true, force: true });
  } finally {
    unsealSkills(sealed);
    rmSync(tmp, { recursive: true, force: true });
  }
});
