// Build without credentials, signing services, or launching the application.
// Also supports main, which predates the optional companion brain.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, copyFileSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const desktop = path.join(root, "apps/desktop");
const native = path.join(desktop, "src-tauri");
const win = process.platform === "win32";
if (!win && process.platform !== "darwin")
  throw Error("Only Windows and macOS are configured");
const run = (command, args, cwd = root) =>
  execFileSync(command, args, { cwd, stdio: "inherit" });
const config = { build: { beforeBuildCommand: "" }, bundle: {} };
const trial = process.argv.includes("--trial");
if (trial)
  Object.assign(
    config,
    JSON.parse(
      readFileSync(path.join(native, "tauri.trial.conf.json"), "utf8"),
    ),
  );
if (win) config.bundle.icon = ["icons/icon.ico"];
if (!win) config.bundle.macOS = { signingIdentity: "-" };
if (existsSync(path.join(root, "apps/brain/package.json"))) {
  const triple = execFileSync("rustc", ["-vV"], { encoding: "utf8" }).match(
    /^host: (.*)$/m,
  )[1];
  const target = win ? "windows-x64" : "macos-" + process.arch;
  run(process.execPath, ["scripts/build-brain.mjs", "bun", target]);
  const binaries = path.join(native, "binaries");
  mkdirSync(binaries, { recursive: true });
  const suffix = win ? ".exe" : "";
  copyFileSync(
    path.join(root, "apps/brain/dist/bun", target, "companion-brain" + suffix),
    path.join(binaries, "companion-brain-" + triple + suffix),
  );
  config.bundle.externalBin = ["binaries/companion-brain"];
}
run(
  process.execPath,
  [
    path.join(root, "node_modules/@tauri-apps/cli/tauri.js"),
    "build",
    ...(trial ? ["--features", "trial"] : []),
    "--bundles",
    win ? "nsis" : "app",
    "--config",
    JSON.stringify(config),
  ],
  desktop,
);
if (!win) {
  const { productName } = JSON.parse(
    readFileSync(path.join(native, "tauri.conf.json"), "utf8"),
  );
  const out = path.join(root, "runs/ci");
  mkdirSync(out, { recursive: true });
  run("tar", [
    "-czf",
    path.join(out, "macos-app.tar.gz"),
    "-C",
    path.join(native, "target/release/bundle/macos"),
    productName + ".app",
  ]);
}
