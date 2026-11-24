import { readdirSync, readFileSync } from "node:fs";
// Build one standalone sidecar. Both runtimes consume the same bundled ESM.
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const [
  runtime,
  target = process.platform === "win32"
    ? "windows-x64"
    : "macos-" + process.arch,
] = process.argv.slice(2);
const windows = target === "windows-x64";
if (
  !["sea", "bun"].includes(runtime) ||
  !["macos-arm64", "macos-x64", "windows-x64"].includes(target)
) {
  throw new Error(
    "用法：node scripts/build-brain.mjs sea|bun [macos-arm64|macos-x64|windows-x64]",
  );
}
const dir = path.join(
  process.env.COMPANION_BRAIN_DIST ?? path.join(root, "apps/brain/dist"),
  runtime,
  target,
);
await mkdir(dir, { recursive: true });
const main = path.join(dir, "brain.mjs");
const output = path.join(
  dir,
  windows ? "companion-brain.exe" : "companion-brain",
);
await build({
  entryPoints: [path.join(root, "apps/brain/src/main.ts")],
  outfile: main,
  define: {
    __COMPANION_TEXTS__: JSON.stringify(
      Object.fromEntries(
        readdirSync(path.join(root, "apps/brain/prompts")).map((n) => [
          n.slice(0, -3),
          readFileSync(path.join(root, "apps/brain/prompts", n), "utf8"),
        ]),
      ),
    ),
  },
  bundle: true,
  format: "esm",
  platform: "node",
  target: "es2022",
  minify: true,
  banner: {
    js: 'import { createRequire as makeRequire } from "node:module"; const require = makeRequire(import.meta.url);',
  },
});
const run = (command, args) =>
  execFileSync(command, args, { stdio: "inherit" });
if (runtime === "bun") {
  const targetFlag = windows
    ? "bun-windows-x64-baseline"
    : target.replace("macos", "bun-darwin");
  run(require.resolve("bun/bin/bun.exe"), [
    "build",
    main,
    "--compile",
    "--target=" + targetFlag,
    "--no-compile-autoload-dotenv",
    "--no-compile-autoload-bunfig",
    "--outfile",
    output,
  ]);
} else {
  let executable = process.execPath;
  if (windows && process.platform !== "win32") {
    // Use exactly the host Node version. Cross-target SEA cannot use a startup snapshot/code cache.
    const origin = "https://nodejs.org/dist/" + process.version + "/";
    const get = async (url) => {
      const response = await fetch(origin + url);
      if (!response.ok)
        throw new Error("下载 Node " + url + " 失败：" + response.status);
      return response;
    };
    const checksums = await (await get("SHASUMS256.txt")).text();
    const hash = checksums
      .split("\n")
      .find((line) => /\swin-x64\/node\.exe$/.test(line))
      ?.split(/\s+/)[0];
    const bytes = Buffer.from(
      await (await get("win-x64/node.exe")).arrayBuffer(),
    );
    if (createHash("sha256").update(bytes).digest("hex") !== hash)
      throw new Error("Node SHA-256 不匹配");
    executable = path.join(dir, "node.exe");
    await writeFile(executable, bytes);
  } else if (
    target !==
    { darwin: "macos-", win32: "windows-" }[process.platform] + process.arch
  ) {
    throw new Error("此 SEA 目标需要对应的 Node 可执行文件");
  }
  const config = path.join(dir, "sea.json");
  await writeFile(
    config,
    JSON.stringify({
      main,
      executable,
      mainFormat: "module",
      output,
      useSnapshot: false,
      useCodeCache: false,
      execArgvExtension: "none",
      disableExperimentalSEAWarning: true,
    }),
  );
  run(process.execPath, ["--build-sea", config]);
}
if (!windows) run("/usr/bin/codesign", ["--force", "--sign", "-", output]);
console.log(output);
