import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { createServer } from "vite";
import { bubbleBridge } from "../../scripts/qa/window.ts";

test("the real original pet controller remains responsive at 80px and 280px", async () => {
  const server = await createServer({
    root: process.cwd() + "/apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 80, height: 87 } });
    const sprite =
      "data:image/webp;base64," +
      readFileSync("examples/lizi/spritesheet.webp").toString("base64");
    let shape: any = null;
    const emit = await bubbleBridge(page, async (cmd, args) => {
      if (cmd === "get_state")
        return {
          pets: [
            { id: "fixture", spriteVersionNumber: 2, fingerprint: "fixture" },
          ],
          custom: {},
          drafts: [],
          settings: {
            activeId: "fixture",
            visible: true,
            paused: false,
            size: 80,
            behaviors: {},
          },
        };
      if (cmd === "read_sprite") return sprite;
      if (cmd === "companion_settings") return { enabled: false };
      if (cmd === "lab_pet_shape") {
        shape = args.bounds;
        return null;
      }
      if (cmd.includes("menu")) return [1, "menu"];
      if (cmd.includes("scale_factor")) return 1;
      if (cmd.includes("position")) return { x: 100, y: 100 };
      return null;
    });
    await page.addInitScript({
      content:
        "document.addEventListener('pet-shape',()=>window.qaShapeSeen=true);",
    });
    await page.goto(server.resolvedUrls!.local[0] + "?pet");
    await page.waitForFunction(() => Boolean((window as any).qaShapeSeen));
    assert.equal((await page.locator("canvas").boundingBox())!.width, 80);
    await page.setViewportSize({ width: 560, height: 400 });
    assert.equal(
      (await page.locator("canvas").boundingBox())!.width,
      80,
      "expanding the shared viewport keeps the original pet size",
    );
    await emit("lab-layout", {
      origin: { x: 0, y: 0 },
      work: { x: 0, y: 0, width: 1280, height: 690 },
      pet: {
        width: 280,
        height: (280 * 208) / 192,
        body: { x: 0, y: 0, width: 1, height: 1 },
      },
    });
    assert.equal((await page.locator("canvas").boundingBox())!.width, 280);
    assert.ok(
      shape && shape.width > 0 && shape.width <= 1,
      "original SpritePlayer provides the live silhouette",
    );
  } finally {
    await browser.close();
    await server.close();
  }
});

test("directory metadata overrides extensions and the real file-type assets load", async () => {
  const server = await createServer({
    root: process.cwd() + "/apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    const result = await page.evaluate(async () => {
      const { fileType } = await import("/src/fileTransfer/fileTypes.ts");
      const types = [
        fileType("folder.pdf", {
          path: "folder.pdf",
          isDirectory: true,
          exists: true,
        }),
        fileType("REPORT.PDF"),
        fileType("budget.xlsx"),
        fileType("script.rs"),
        fileType("photo.png"),
      ];
      const sizes = [];
      for (const type of types) {
        const img = new Image();
        img.src = type.icon;
        await img.decode();
        sizes.push(img.naturalWidth);
      }
      return {
        kinds: types.map((t) => t.kind),
        icons: types.map((t) => t.icon),
        sizes,
      };
    });
    assert.deepEqual(result.kinds, ["folder", "pdf", "sheet", "code", "image"]);
    assert.equal(new Set(result.icons).size, 5);
    assert.ok(result.sizes.every((n) => n > 0));
  } finally {
    await browser.close();
    await server.close();
  }
});
