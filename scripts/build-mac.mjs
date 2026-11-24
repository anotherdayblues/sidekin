// Package a committed Mac app from a private source snapshot: the release by
// default, or the trial (its own name, data and keychain) with --trial.
// Neither app needs to be running; publishing the bundle never launches it.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealSkills } from "./seal-skills.mjs";

const trialMode = process.argv.includes("--trial");
const distributionIdentity = trialMode
  ? undefined
  : process.env.SIDEKIN_MAC_SIGN_IDENTITY;
const kind = trialMode ? "试玩版" : distributionIdentity ? "公开版" : "正式版";
if (process.platform !== "darwin") throw Error(kind + "需要在 macOS 构建");
const root = fileURLToPath(new URL("../", import.meta.url));
const git = (...args) =>
  execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const revision = git("rev-parse", "HEAD"),
  prefix = git("rev-parse", "--show-prefix");
const runs = path.join(root, "runs");
mkdirSync(runs, { recursive: true });
const parent = process.env.QA
  ? realpathSync(process.env.QA)
  : realpathSync(runs);
if (
  parent !== realpathSync(runs) &&
  path.dirname(parent) !== realpathSync(runs)
)
  throw Error("构建目录必须在本工作区的 runs 下");
const scratch = mkdtempSync(
  path.join(parent, trialMode ? "trial-build-" : "mac-build-"),
);
const archive = path.join(scratch, "source.tar"),
  snapshot = path.join(scratch, "source");
mkdirSync(snapshot);
const tmp = path.join(scratch, "tmp");
mkdirSync(tmp);
const env = {
  ...process.env,
  TMPDIR: tmp,
  TEMP: tmp,
  TMP: tmp,
  CARGO_TARGET_DIR: path.join(scratch, "target"),
  CARGO_PROFILE_RELEASE_STRIP: "none",
  COMPANION_TRIAL_CACHE: path.join(scratch, "vite-cache"),
  ...(trialMode ? { VITE_PET_TRIAL: "1" } : {}),
};
const run = (cmd, args, cwd = scratch) =>
  execFileSync(cmd, args, { cwd, env, stdio: "inherit" });
const output = path.join(root, "exports", kind, revision.slice(0, 12));
if (existsSync(output)) throw Error("这个版本已经存在：" + output);
console.log(kind + "构建", revision, "临时目录", scratch);
run(
  "git",
  [
    "archive",
    "--format=tar",
    "-o",
    archive,
    revision,
    ...(prefix ? ["--", prefix] : []),
  ],
  git("rev-parse", "--show-toplevel"),
);
run("/usr/bin/tar", ["-xf", archive, "-C", snapshot]);
const source = path.join(snapshot, prefix),
  desktop = path.join(source, "apps/desktop"),
  native = path.join(desktop, "src-tauri");
for (const sub of ["node_modules", "apps/desktop/node_modules"]) {
  const installed = path.join(root, sub);
  if (existsSync(installed))
    symlinkSync(realpathSync(installed), path.join(source, sub), "dir");
}
const frontend = path.join(scratch, "frontend");
run(path.join(source, "node_modules/.bin/tsc"), ["-p", "apps/desktop"], source);
run(
  path.join(source, "node_modules/.bin/vite"),
  ["build", "--configLoader", "runner", "--outDir", frontend],
  desktop,
);
env.COMPANION_BRAIN_DIST = path.join(scratch, "sidecar");
const target = "macos-" + process.arch;
run(process.execPath, ["scripts/build-brain.mjs", "bun", target], source);
const triple = execFileSync("rustc", ["-vV"], { env, encoding: "utf8" }).match(
  /^host: (.*)$/m,
)?.[1];
if (!triple?.endsWith("-apple-darwin")) throw Error("需要 Mac Rust 工具链");
const binaries = path.join(scratch, "binaries");
mkdirSync(binaries);
run("/usr/bin/ditto", [
  path.join(env.COMPANION_BRAIN_DIST, "bun", target, "companion-brain"),
  path.join(binaries, "companion-brain-" + triple),
]);
const base = JSON.parse(
  readFileSync(path.join(native, "tauri.conf.json"), "utf8"),
);
const trial = JSON.parse(
  readFileSync(path.join(native, "tauri.trial.conf.json"), "utf8"),
);
const profile = trialMode
  ? trial
  : { productName: base.productName, identifier: base.identifier };
const config = {
  ...profile,
  build: { beforeBuildCommand: "", frontendDist: frontend },
  ...(trialMode && {
    app: {
      windows: base.app.windows.map((w) => ({
        ...w,
        incognito: true,
        title:
          w.label === "studio"
            ? trial.productName + " · 管理"
            : trial.productName,
      })),
    },
  }),
  bundle: { externalBin: [path.join(binaries, "companion-brain")] },
};
run(
  process.execPath,
  [
    path.join(source, "node_modules/@tauri-apps/cli/tauri.js"),
    "build",
    ...(trialMode ? ["--features", "trial"] : []),
    "--bundles",
    "app",
    "--no-sign",
    "--config",
    JSON.stringify(config),
  ],
  desktop,
);
const stage = path.join(scratch, "ready");
mkdirSync(stage);
const name = profile.productName + ".app",
  app = path.join(stage, name);
run("/usr/bin/ditto", [
  path.join(env.CARGO_TARGET_DIR, "release/bundle/macos", name),
  app,
]);
sealSkills(path.join(app, "Contents/Resources/skills"));
// macOS ties Accessibility and other permissions to the signature. An ad-hoc
// signature changes with every build, so a permission granted to one trial
// silently stops applying to the next. Sign with the developer's own
// "Apple Development" identity when there is one, so the grant carries over.
// TRIAL_SIGN_IDENTITY overrides; "-" forces ad-hoc.
const identity =
  process.env.TRIAL_SIGN_IDENTITY ??
  execFileSync(
    "/usr/bin/security",
    ["find-identity", "-v", "-p", "codesigning"],
    {
      encoding: "utf8",
    },
  ).match(/\b([0-9A-F]{40}) "Apple Development: /)?.[1] ??
  "-";
console.log(
  distributionIdentity
    ? "签名：Developer ID Application"
    : identity === "-"
      ? "签名：临时签名（权限每次打包后要重新给）"
      : "签名：Apple Development 证书",
);
if (distributionIdentity) {
  const sign = [
    "--force",
    "--timestamp",
    "--options",
    "runtime",
    "--sign",
    distributionIdentity,
  ];
  run("/usr/bin/codesign", [
    ...sign,
    path.join(app, "Contents/MacOS/companion-brain"),
  ]);
  run("/usr/bin/codesign", [...sign, app]);
} else {
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", identity, app]);
}
run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
const plist = path.join(app, "Contents/Info.plist"),
  id = execFileSync(
    "/usr/bin/plutil",
    ["-extract", "CFBundleIdentifier", "raw", plist],
    { encoding: "utf8" },
  ).trim();
if (
  id !== profile.identifier ||
  !existsSync(path.join(app, "Contents/MacOS/companion-brain"))
)
  throw Error(kind + "包不完整或标识不符");
const notes = trialMode
  ? [
      trial.productName + " · Mac " + process.arch,
      "源码版本 " + revision,
      "",
      "双击「" + name + "」。首次打开会有一只示例栗子，数据只保存在试玩目录。",
      "1. 在管理窗口点动作试播，再在桌面拖动栗子、右击试试菜单。",
      "2. 在「设置 → 外观」选房间或老游戏，再用家具或方向键切换页面。",
      "3. 伙伴大脑默认关闭。想聊、识图或翻译时，在试玩版里单独配置服务和 Key。",
      "   试玩版默认快捷键是 Control + Option + Shift 加 空格（聊天气泡）、C（聊天侧边栏）、S（截图）。翻译：选中文字后很快连按两次 ⌘C。",
      "4. 从菜单栏的随伴试玩版图标选择「退出」即可结束试玩。",
      "",
      "试玩数据：~/Library/Application Support/" + id,
      "普通版和试玩版各用自己的系统钥匙串服务。",
    ]
  : [
      profile.productName + " · Mac " + process.arch,
      "源码版本 " + revision,
      "",
      "双击「" + name + "」。第一次打开会有一只示例栗子站在屏幕右下角。",
      "伙伴大脑默认关闭。想聊天、识图或翻译时，在「设置」里选模型服务并填 Key。",
      "默认快捷键：Control + Option 加 空格（聊天气泡）、C（聊天侧边栏）、S（截图）。",
      "翻译：选中文字后很快连按两次 ⌘C。",
      "",
      "数据：~/Library/Application Support/" + id,
    ];
writeFileSync(
  path.join(stage, trialMode ? "试玩说明.txt" : "说明.txt"),
  notes.join("\n") + "\n",
);
mkdirSync(path.dirname(output), { recursive: true });
renameSync(stage, output);
console.log("已交付：" + path.join(output, name));
