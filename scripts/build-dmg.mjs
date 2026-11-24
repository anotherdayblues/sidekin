import { execFileSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
} from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = fileURLToPath(new URL("../", import.meta.url));
const WIDTH = 640;
const HEIGHT = 400;
const TITLEBAR_HEIGHT = 28;
const ICON_SIZE = 108;
const TEXT_SIZE = 13;
const APP_POS = [164, 196];
const APPS_POS = [476, 196];

const run = (command, args, opts = {}) =>
  execFileSync(command, args, { cwd: root, stdio: "inherit", ...opts });

const read = (command, args, opts = {}) =>
  execFileSync(command, args, { cwd: root, encoding: "utf8", ...opts }).trim();

function buildBackgroundHtml(liziDataUri) {
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      overflow: hidden;
      font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", sans-serif;
      -webkit-font-smoothing: antialiased;
    }
    .canvas {
      position: relative;
      width: ${WIDTH}px;
      height: ${HEIGHT}px;
      overflow: hidden;
      background:
        radial-gradient(62% 52% at 86% 96%, rgba(255, 206, 186, 0.54), transparent),
        radial-gradient(50% 44% at 18% 8%, rgba(255, 255, 255, 0.78), transparent),
        linear-gradient(180deg, #bfd6f8 0%, #dce8fb 48%, #f4f7fc 100%);
    }
    .canvas::before {
      content: "";
      position: absolute;
      inset: 0;
      background: radial-gradient(rgba(20, 33, 61, 0.095) 1px, transparent 1.2px) 0 0 / 16px 16px;
      mask: radial-gradient(92% 80% at 50% 52%, rgba(0, 0, 0, 0.55), transparent 85%);
      -webkit-mask: radial-gradient(92% 80% at 50% 52%, rgba(0, 0, 0, 0.55), transparent 85%);
    }
    .beam {
      position: absolute;
      top: -60px;
      left: 110px;
      width: 240px;
      height: 520px;
      transform: rotate(24deg);
      background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.45) 45%, rgba(156, 200, 255, 0.25) 75%, transparent);
      filter: blur(22px);
    }
    .top-bar {
      position: absolute;
      top: 20px;
      left: 24px;
      right: 24px;
      display: flex;
      align-items: center;
      justify-content: space-between;
      z-index: 3;
    }
    .clock-pill {
      display: inline-flex;
      align-items: center;
      gap: 8px;
      padding: 4px 10px 4px 5px;
      border-radius: 10px;
      background: rgba(255, 255, 255, 0.76);
      box-shadow: inset 0 0 0 1px rgba(20, 33, 61, 0.08), 0 4px 12px rgba(20, 33, 61, 0.06);
      font-size: 12px;
      color: #4b5669;
    }
    .clock-pill b {
      padding: 2px 7px;
      border-radius: 6px;
      background: #ffffff;
      box-shadow: inset 0 0 0 1px rgba(20, 33, 61, 0.14);
      font-family: ui-monospace, "SF Mono", Menlo, monospace;
      font-size: 11px;
      color: #0c1424;
    }
    .brand-mark {
      font-family: "Songti SC", "Noto Serif SC", Georgia, serif;
      font-size: 15px;
      font-weight: 600;
      color: #0c1424;
      opacity: 0.78;
      letter-spacing: -0.01em;
    }

    .pad {
      position: absolute;
      top: 210px;
      width: 162px;
      height: 166px;
      border-radius: 30px;
      transform: translate(-50%, -50%);
      z-index: 2;
    }
    .pad-left {
      left: ${APP_POS[0]}px;
      background: rgba(255, 255, 255, 0.44);
      box-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.85), 0 12px 30px -14px rgba(30, 50, 110, 0.16);
      border: 1px solid rgba(255, 255, 255, 0.72);
    }
    .pad-right {
      left: ${APPS_POS[0]}px;
      background: rgba(255, 255, 255, 0.56);
      border: 1.5px dashed rgba(58, 109, 240, 0.42);
      box-shadow: 0 14px 32px -16px rgba(58, 109, 240, 0.22);
    }
    .pad-tag {
      position: absolute;
      top: -10px;
      left: 50%;
      transform: translateX(-50%);
      white-space: nowrap;
      padding: 2px 9px;
      border-radius: 999px;
      background: #ffffff;
      border: 1px solid rgba(58, 109, 240, 0.24);
      font-size: 10px;
      font-weight: 600;
      color: #3a6df0;
      box-shadow: 0 2px 6px rgba(58, 109, 240, 0.12);
    }

    .bubble {
      position: absolute;
      top: 72px;
      left: 320px;
      transform: translateX(-50%);
      padding: 7px 14px;
      border-radius: 14px;
      background: #fffcf5;
      border: 1px solid rgba(20, 33, 61, 0.09);
      box-shadow: 0 8px 20px -8px rgba(20, 33, 61, 0.16);
      font-size: 12.5px;
      font-weight: 500;
      color: #0c1424;
      white-space: nowrap;
      z-index: 5;
    }
    .bubble::after {
      content: "";
      position: absolute;
      left: 50%;
      bottom: -5px;
      width: 9px;
      height: 9px;
      background: #fffcf5;
      border-right: 1px solid rgba(20, 33, 61, 0.09);
      border-bottom: 1px solid rgba(20, 33, 61, 0.09);
      transform: translateX(-50%) rotate(45deg);
    }

    .trail-svg {
      position: absolute;
      left: 245px;
      top: 170px;
      width: 150px;
      height: 76px;
      z-index: 3;
      overflow: visible;
    }

    .bottom-strip {
      position: absolute;
      left: 24px;
      right: 24px;
      bottom: 18px;
      display: flex;
      align-items: flex-end;
      justify-content: space-between;
      z-index: 3;
    }
    .bottom-note {
      font-size: 12.5px;
      color: #4b5669;
      display: flex;
      align-items: center;
      gap: 8px;
      padding-bottom: 6px;
    }
    .bottom-note .dot {
      width: 6px;
      height: 6px;
      border-radius: 50%;
      background: #3a6df0;
      opacity: 0.7;
    }
    .lizi-standing {
      width: 66px;
      height: 70px;
      background: url("${liziDataUri}") no-repeat 0% 50% / 1600% 100%;
      margin-bottom: -8px;
      filter: drop-shadow(0 6px 8px rgba(20, 33, 61, 0.14));
    }
  </style>
</head>
<body>
  <div class="canvas">
    <div class="beam"></div>

    <div class="top-bar">
      <div class="clock-pill"><b>08:30</b><span>新伙伴报到</span></div>
      <div class="brand-mark">随伴 · Sidekin</div>
    </div>

    <div class="pad pad-left"></div>
    <div class="pad pad-right">
      <span class="pad-tag">拖到这里入住</span>
    </div>

    <div class="bubble">拖进去，我就住进你的桌面啦</div>

    <svg class="trail-svg" viewBox="0 0 180 76" fill="none">
      <path d="M 14 44 Q 90 12 158 40" stroke="#3a6df0" stroke-opacity="0.34" stroke-width="2" stroke-dasharray="5 6" stroke-linecap="round"/>
      <path d="M 150 32 L 162 41 L 148 46" stroke="#3a6df0" stroke-opacity="0.72" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/>
      <g fill="#f08c42" fill-opacity="0.58" transform="translate(48, 30) rotate(-14) scale(0.72)">
        <ellipse cx="0" cy="4" rx="5.2" ry="4.2"/>
        <circle cx="-5.5" cy="-2" r="2.1"/><circle cx="0" cy="-4.2" r="2.2"/><circle cx="5.5" cy="-2" r="2.1"/>
      </g>
      <g fill="#f08c42" fill-opacity="0.72" transform="translate(88, 22) rotate(2) scale(0.78)">
        <ellipse cx="0" cy="4" rx="5.2" ry="4.2"/>
        <circle cx="-5.5" cy="-2" r="2.1"/><circle cx="0" cy="-4.2" r="2.2"/><circle cx="5.5" cy="-2" r="2.1"/>
      </g>
      <g fill="#f08c42" fill-opacity="0.86" transform="translate(128, 29) rotate(16) scale(0.84)">
        <ellipse cx="0" cy="4" rx="5.2" ry="4.2"/>
        <circle cx="-5.5" cy="-2" r="2.1"/><circle cx="0" cy="-4.2" r="2.2"/><circle cx="5.5" cy="-2" r="2.1"/>
      </g>
    </svg>

    <div class="bottom-strip">
      <div class="bottom-note">
        <span class="dot"></span>
        拖入 Applications 后即可在启动台打开 · 住在屏幕角落，随手就用
      </div>
      <div class="lizi-standing"></div>
    </div>
  </div>
</body>
</html>`;
}

/**
 * 渲染 1x + 2x 背景并用 macOS tiffutil 合成 HiDPI 多分辨率 TIFF，
 * 确保 Finder 按精确 640×400 逻辑点排版且在 Retina 屏下保持高清。
 */
export async function renderDmgBackground(outTiffPath, workDir) {
  const liziPath = path.join(root, "apps/website/public/pets/lizi-sleep.webp");
  const liziDataUri = `data:image/webp;base64,${readFileSync(liziPath).toString("base64")}`;
  const html = buildBackgroundHtml(liziDataUri);
  const bg1x = path.join(workDir, "bg-1x.png");
  const bg2x = path.join(workDir, "bg-2x.png");

  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const [scale, file] of [
      [1, bg1x],
      [2, bg2x],
    ]) {
      const ctx = await browser.newContext({
        viewport: { width: WIDTH, height: HEIGHT },
        deviceScaleFactor: scale,
      });
      const page = await ctx.newPage();
      await page.setContent(html, { waitUntil: "load" });
      await page.screenshot({ path: file });
      await ctx.close();
    }
  } finally {
    await browser.close();
  }

  run("tiffutil", ["-cathidpicheck", bg1x, bg2x, "-out", outTiffPath]);
}

function parseAttachInfo(output) {
  let device = "";
  let mountPoint = "";
  for (const line of output.split(/\r?\n/)) {
    const match = line.match(/^(\/dev\/\S+)\s+.*\s+(\/Volumes\/.+)$/);
    if (match) {
      device = match[1];
      mountPoint = match[2].trim();
    }
  }
  if (!device || !mountPoint) {
    throw new Error(`无法解析 hdiutil attach 输出：\n${output}`);
  }
  return { device, mountPoint };
}

function applyFinderLayout(mountPoint, appName) {
  const volumeName = path.basename(mountPoint);
  const left = 160;
  const top = 140;
  const right = left + WIDTH;
  const bottom = top + HEIGHT + TITLEBAR_HEIGHT;

  const script = `
    tell application "Finder"
      tell disk "${volumeName}"
        open
        set current view of container window to icon view
        set toolbar visible of container window to false
        set statusbar visible of container window to false
        set the bounds of container window to {${left}, ${top}, ${right}, ${bottom}}
        set viewOptions to the icon view options of container window
        set arrangement of viewOptions to not arranged
        set icon size of viewOptions to ${ICON_SIZE}
        set text size of viewOptions to ${TEXT_SIZE}
        set background picture of viewOptions to file ".background:bg.tiff"
        set position of item "${appName}" of container window to {${APP_POS[0]}, ${APP_POS[1]}}
        set position of item "Applications" of container window to {${APPS_POS[0]}, ${APPS_POS[1]}}
        close
        open
        update without registering applications
        delay 1.5
        close
      end tell
    end tell
  `;

  run("osascript", ["-e", script]);
}

/**
 * 构建带有「晨光带它回家」Retina 背景、自定义卷标图标和精确 Finder 坐标的 macOS DMG。
 */
export async function createPrettyDmg({
  appPath,
  outPath,
  volumeName = "Sidekin",
}) {
  if (!existsSync(appPath)) {
    throw new Error(`找不到应用包：${appPath}`);
  }

  const outDir = path.dirname(outPath);
  mkdirSync(outDir, { recursive: true });
  const workDir = mkdtempSync(path.join(outDir, "dmg-work-"));
  const staging = path.join(workDir, "staging");
  const bgDir = path.join(staging, ".background");
  const rwDmg = path.join(workDir, "temp-rw.dmg");
  const appName = path.basename(appPath);

  let attachedDevice = "";
  try {
    mkdirSync(bgDir, { recursive: true });
    run("ditto", [appPath, path.join(staging, appName)]);
    symlinkSync("/Applications", path.join(staging, "Applications"));

    const bgTiff = path.join(bgDir, "bg.tiff");
    await renderDmgBackground(bgTiff, workDir);

    const volumeIconSrc = path.join(
      root,
      "apps/desktop/src-tauri/icons/icon.icns",
    );
    const hasVolumeIcon = existsSync(volumeIconSrc);

    // 根据 staging 体积自动留出 48MB 余量，确保写入 .DS_Store 不爆盘
    const sizeKb = Number(read("du", ["-sk", staging]).split(/\s+/)[0]) || 102400;
    const sizeMb = Math.ceil(sizeKb / 1024) + 48;

    run("hdiutil", [
      "create",
      "-srcfolder",
      staging,
      "-volname",
      volumeName,
      "-fs",
      "HFS+",
      "-fsargs",
      "-c c=64,a=16,e=16",
      "-format",
      "UDRW",
      "-size",
      `${sizeMb}m`,
      rwDmg,
    ]);

    const attachOut = read("hdiutil", [
      "attach",
      "-readwrite",
      "-noverify",
      "-noautoopen",
      rwDmg,
    ]);
    const { device, mountPoint } = parseAttachInfo(attachOut);
    attachedDevice = device;

    run("chflags", ["hidden", path.join(mountPoint, ".background")]);
    if (hasVolumeIcon) {
      const volIconDst = path.join(mountPoint, ".VolumeIcon.icns");
      copyFileSync(volumeIconSrc, volIconDst);
      run("chflags", ["hidden", volIconDst]);
      try {
        run("SetFile", ["-a", "C", mountPoint]);
      } catch {
        // SetFile 仅在 Xcode Command Line Tools 存在时生效，失败不影响 DMG 正常使用
      }
    }

    applyFinderLayout(mountPoint, appName);

    run("sync", []);
    // 给 Finder 一点落盘 .DS_Store 的时间再安全卸载
    await new Promise((resolve) => setTimeout(resolve, 1000));

    try {
      run("hdiutil", ["detach", attachedDevice]);
    } catch {
      run("hdiutil", ["detach", "-force", attachedDevice]);
    }
    attachedDevice = "";

    run("hdiutil", [
      "convert",
      rwDmg,
      "-format",
      "UDZO",
      "-imagekey",
      "zlib-level=9",
      "-ov",
      "-o",
      outPath,
    ]);
  } finally {
    if (attachedDevice) {
      try {
        run("hdiutil", ["detach", "-force", attachedDevice]);
      } catch {
        // ignore cleanup errors
      }
    }
    rmSync(workDir, { recursive: true, force: true });
  }
}

// 支持独立命令行测试：node scripts/build-dmg.mjs <Sidekin.app> <output.dmg>
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [appPath, outPath] = process.argv.slice(2);
  if (!appPath || !outPath) {
    console.error("用法：node scripts/build-dmg.mjs <Sidekin.app> <output.dmg>");
    process.exit(1);
  }
  await createPrettyDmg({
    appPath: path.resolve(appPath),
    outPath: path.resolve(outPath),
  });
  console.log("DMG ready:", path.resolve(outPath));
}
