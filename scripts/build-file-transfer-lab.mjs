import { execFileSync } from "node:child_process";
import { mkdirSync, cpSync, copyFileSync, existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { sealSkills } from "./seal-skills.mjs";
const root = fileURLToPath(new URL("../", import.meta.url));
const lab = process.env.FILE_TRANSFER_OUTPUT_DIR
    ? path.resolve(process.env.FILE_TRANSFER_OUTPUT_DIR)
    : path.join(root, "releases"),
  desktop = path.join(root, "apps/desktop"),
  native = path.join(desktop, "src-tauri");
mkdirSync(lab, { recursive: true });
const win = process.platform === "win32",
  target = win ? "windows-x64" : "macos-" + process.arch;
// Rust's installer puts cargo in ~/.cargo/bin and adds it to PATH only for
// login shells; a terminal started another way (an editor, an AI agent)
// may not have it. Use that folder when cargo is not on PATH.
const home = process.env.HOME ?? process.env.USERPROFILE ?? "",
  cargoBin = path.join(home, ".cargo", "bin"),
  pathKey =
    Object.keys(process.env).find((k) => k.toUpperCase() === "PATH") ?? "PATH",
  onPath = (bin) =>
    (process.env[pathKey] ?? "")
      .split(path.delimiter)
      .some((dir) => dir && existsSync(path.join(dir, bin)));
const cargo = win ? "cargo.exe" : "cargo";
let searchPath = process.env[pathKey] ?? "";
if (!onPath(cargo)) {
  if (!existsSync(path.join(cargoBin, cargo))) {
    process.stderr.write(
      "找不到 cargo（Rust 的构建工具）：PATH 里没有，" +
        cargoBin +
        " 里也没有。\n" +
        "先装 Rust（https://rustup.rs），或把 cargo 所在的文件夹加进 PATH，再打包。\n",
    );
    process.exit(1);
  }
  searchPath = cargoBin + path.delimiter + searchPath;
}
const env = {
  ...process.env,
  [pathKey]: searchPath,
  CARGO_TARGET_DIR:
    process.env.CARGO_TARGET_DIR ??
    path.join(root, "runs", win ? "target-lab-windows" : "target-lab-mac"),
  CARGO_PROFILE_RELEASE_STRIP: "none",
};
const run = (bin, args, cwd = root) =>
  execFileSync(bin, args, { cwd, env, stdio: "inherit" });
if (win) {
  // .cmd launchers need a shell on Windows. npm already provides its JS entry.
  run(process.execPath, [
    process.env.npm_execpath,
    "run",
    "build",
    "-w",
    "@pet-studio/desktop",
  ]);
} else {
  run("npm", ["run", "build", "-w", "@pet-studio/desktop"]);
}
run(process.execPath, ["scripts/build-brain.mjs", "bun", target]);
mkdirSync(path.join(native, "binaries"), { recursive: true });
const triple = win
  ? "x86_64-pc-windows-msvc"
  : process.arch === "arm64"
    ? "aarch64-apple-darwin"
    : "x86_64-apple-darwin";
const brain = path.join(
  root,
  "apps/brain/dist/bun",
  target,
  "companion-brain" + (win ? ".exe" : ""),
);
copyFileSync(
  brain,
  path.join(
    native,
    "binaries",
    "companion-brain-" + triple + (win ? ".exe" : ""),
  ),
);
function outputPath(name) {
  const direct = path.join(lab, name);
  if (!existsSync(direct)) return direct;
  const ext = path.extname(name),
    base = ext ? name.slice(0, -ext.length) : name;
  const stamp = new Date().toISOString().replace(/[-:.TZ]/g, "");
  let candidate = path.join(lab, base + "-" + stamp + ext),
    n = 1;
  while (existsSync(candidate))
    candidate = path.join(lab, base + "-" + stamp + "-" + n++ + ext);
  return candidate;
}
if (win) {
  run("cargo", ["build", "--release", "--locked", "--target", triple], native);
  const out = outputPath("Windows");
  mkdirSync(out, { recursive: true });
  copyFileSync(
    path.join(env.CARGO_TARGET_DIR, triple, "release/pet-studio.exe"),
    path.join(out, "Suiby.exe"),
  );
  copyFileSync(brain, path.join(out, "companion-brain.exe"));
  cpSync(path.join(root, "skills"), path.join(out, "skills"), {
    recursive: true,
  });
  sealSkills(path.join(out, "skills"));
  process.stdout.write("新程序目录：" + out + "\n");
} else {
  run(
    process.execPath,
    [
      path.join(root, "node_modules/@tauri-apps/cli/tauri.js"),
      "build",
      "--bundles",
      "app",
      "--no-sign",
    ],
    desktop,
  );
  const out = outputPath("Suiby.app");
  run("/usr/bin/ditto", [
    path.join(
      env.CARGO_TARGET_DIR,
      "release/bundle/macos/Suiby.app",
    ),
    out,
  ]);
  sealSkills(path.join(out, "Contents/Resources/skills"));
  // Archive the unstripped Mach-O by build UUID before signing the shipping copy.
  const executable = path.join(out, "Contents/MacOS/pet-studio");
  const uuid = execFileSync("/usr/bin/dwarfdump", ["--uuid", executable], {
    encoding: "utf8",
  }).match(/^UUID: ([0-9A-F-]+)/i)?.[1];
  if (!uuid) throw new Error("无法确认主程序的构建编号");
  const symbols = path.join(root, "releases", "symbols", uuid);
  mkdirSync(symbols, { recursive: true });
  copyFileSync(executable, path.join(symbols, "pet-studio"));
  run("/usr/bin/strip", ["-x", executable]);
  const identity =
    execFileSync(
      "/usr/bin/security",
      ["find-identity", "-v", "-p", "codesigning"],
      { encoding: "utf8" },
    ).match(/\b([0-9A-F]{40}) "Apple Development: /)?.[1] ?? "-";
  run("/usr/bin/codesign", ["--force", "--deep", "--sign", identity, out]);
  run("/usr/bin/codesign", ["--verify", "--deep", "--strict", out]);
  process.stdout.write("新应用：" + out + "\n");
}
