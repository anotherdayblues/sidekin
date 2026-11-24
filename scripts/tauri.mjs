import { execFileSync, spawn } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  readdirSync,
} from "node:fs";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import path from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
const toolchains = path.join(homedir(), ".rustup", "toolchains");
const candidates = [
  path.join(homedir(), ".cargo", "bin"),
  ...(existsSync(toolchains)
    ? readdirSync(toolchains)
        .sort()
        .reverse()
        .map((x) => path.join(toolchains, x, "bin"))
    : []),
];
const rust = candidates.find(
  (p) => existsSync(path.join(p, "cargo")) && existsSync(path.join(p, "rustc")),
);
const cli = path.join(root, "node_modules", "@tauri-apps", "cli", "tauri.js");
const args = process.argv.slice(2);
const acceptance = args.some(
  (arg, i) =>
    (args[i - 1] === "--features" || arg.startsWith("--features=")) &&
    arg
      .replace(/^--features=/, "")
      .split(",")
      .includes("acceptance"),
);
let qa;
if (acceptance || process.env.COMPANION_QA_GUARDED === "1") {
  qa = realpathSync(process.env.QA ?? ".");
  if (
    process.env.COMPANION_QA_GUARDED !== "1" ||
    path.dirname(qa) !== realpathSync(path.join(root, "runs")) ||
    !path.basename(qa).startsWith("companion-456.")
  )
    throw Error("验收构建需要专用 runs 目录和剪贴板守护程序");
}
const brainDist = qa
  ? path.join(qa, "brain-dist")
  : path.join(root, "apps/brain/dist");
if (
  ["build", "dev"].includes(args[0]) &&
  ["darwin", "win32"].includes(process.platform)
) {
  const targets = {
    "aarch64-apple-darwin": "macos-arm64",
    "x86_64-apple-darwin": "macos-x64",
    "x86_64-pc-windows-msvc": "windows-x64",
  };
  const host = execFileSync(path.join(rust ?? "", "rustc"), ["-vV"], {
    encoding: "utf8",
  }).match(/^host: (.*)$/m)?.[1];
  const index = args.indexOf("--target");
  const triple = index === -1 ? host : args[index + 1];
  const target = targets[triple];
  if (!target) throw new Error("大脑尚未验证此目标：" + triple);
  const packer = process.env.COMPANION_PACKER ?? "bun";
  execFileSync(process.execPath, ["scripts/build-brain.mjs", packer, target], {
    cwd: root,
    stdio: "inherit",
    env: { ...process.env, COMPANION_BRAIN_DIST: brainDist },
  });
  const suffix = target === "windows-x64" ? ".exe" : "";
  const binaries = qa
    ? path.join(qa, "binaries")
    : path.join(root, "apps/desktop/src-tauri/binaries");
  mkdirSync(binaries, { recursive: true });
  copyFileSync(
    path.join(brainDist, packer, target, "companion-brain" + suffix),
    path.join(binaries, "companion-brain-" + triple + suffix),
  );
  // Keep ordinary cargo test independent of generated binaries on a fresh checkout.
  args.push(
    "--config",
    JSON.stringify({
      bundle: {
        externalBin: [
          qa
            ? path.join(binaries, "companion-brain")
            : "binaries/companion-brain",
        ],
      },
    }),
  );
}
if (qa) {
  const config = JSON.parse(
    readFileSync(
      path.join(root, "apps/desktop/src-tauri/tauri.conf.json"),
      "utf8",
    ),
  );
  args.push(
    "--config",
    JSON.stringify({
      ...(acceptance
        ? {
            identifier: "studio.pet.companion.qa456",
            productName: "Companion Acceptance",
          }
        : {}),
      build: {
        frontendDist: path.join(qa, "frontend"),
        beforeBuildCommand: {
          script: 'npm run build -- --outDir "$COMPANION_QA_UI"',
          cwd: path.join(root, "apps/desktop"),
        },
      },
      ...(acceptance
        ? {
            app: {
              windows: config.app.windows.map((w) => ({
                ...w,
                incognito: true,
              })),
            },
          }
        : {}),
    }),
  );
}
const child = spawn(process.execPath, [cli, ...args], {
  cwd: path.join(root, "apps", "desktop"),
  stdio: "inherit",
  env: {
    ...process.env,
    ...(qa
      ? {
          CARGO_TARGET_DIR: path.join(qa, "target"),
          ...(process.platform === "darwin"
            ? { CARGO_PROFILE_RELEASE_STRIP: "none" }
            : {}),
          COMPANION_QA_UI: path.join(qa, "frontend"),
        }
      : {}),
    PATH: [rust, process.env.PATH].filter(Boolean).join(path.delimiter),
  },
});
child.on("exit", (code) => process.exit(code ?? 1));
child.on("error", (e) => {
  console.error(e.message);
  process.exitCode = 1;
});
