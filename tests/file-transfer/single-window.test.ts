import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { chromium } from "playwright";
import { createServer } from "vite";
import { bubbleBridge } from "../../scripts/qa/window.ts";

test("the original pet and file stack share one surface, retaining pet size when the list opens", async () => {
  const server = await createServer({
    root: process.cwd() + "/apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({
      viewport: { width: 560, height: 400 },
    });
    const sprite =
      "data:image/webp;base64," +
      readFileSync("examples/lizi/spritesheet.webp").toString("base64");
    const geometry = {
      origin: { x: 0, y: 0 },
      work: { x: -300, y: -100, width: 1280, height: 690 },
      pet: {
        width: 160,
        height: (160 * 208) / 192,
        body: { x: 0.2, y: 0.35, width: 0.6, height: 0.6 },
      },
    };
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
            size: 160,
            behaviors: {},
          },
        };
      if (cmd === "read_sprite") return sprite;
      if (cmd === "companion_settings") return { enabled: false };
      if (cmd === "lab_geometry") return geometry;
      if (cmd === "lab_load")
        return {
          state: { items: [], lastRemoved: [] },
          positions: {},
          layoutVersion: 4,
        };
      if (cmd === "lab_describe")
        return args.paths.map((path: string) => ({
          path,
          isDirectory: false,
          exists: true,
        }));
      if (cmd.includes("menu")) return [1, "menu"];
      if (cmd.includes("scale_factor")) return 1;
      if (cmd.includes("position")) return { x: 300, y: 200 };
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?pet");
    await page.waitForFunction(() => Boolean((window as any).labView));
    assert.equal(
      await page.locator(".pile").count(),
      0,
      "empty means the pet alone",
    );
    assert.equal((await page.locator("canvas").boundingBox())!.width, 160);
    await emit("lab-drop", {
      paths: ["/fixture/a.pdf", "/fixture/b.png"],
      x: 120,
      y: 70,
    });
    await page.waitForFunction(
      () => (window as any).labView.items().length === 1,
    );
    assert.equal(await page.locator("canvas").count(), 1);
    assert.equal(await page.locator(".pile").count(), 1);
    const pile = await page.locator(".pile-top").boundingBox();
    await page.locator(".pile-top").click();
    assert.equal(await page.locator(".file-panel").count(), 1);
    assert.deepEqual(await page.locator(".pile-top").boundingBox(), pile);
    assert.equal(
      (await page.locator("canvas").boundingBox())!.width,
      160,
      "an expanded list must not stretch the original pet canvas",
    );
    await page.keyboard.press("Escape");
    await emit("lab-layout", { ...geometry, origin: { x: -32, y: -60 } });
    const moved = await page.locator(".pile-top").boundingBox();
    assert.equal(Math.round(moved!.x - pile!.x), -32);
    assert.equal(Math.round(moved!.y - pile!.y), -60);
    assert.equal(
      (await page.locator("canvas").boundingBox())!.y,
      -60,
      "pet and pile use the exact same scene origin",
    );
    await page.locator(".remove").evaluate((el: HTMLElement) => el.click());
    await page.waitForFunction(
      () => (window as any).labView.items().length === 0,
    );
    assert.equal(await page.locator(".pile").count(), 0);
    await emit("lab-layout", geometry);
    await emit("lab-drop", {
      paths: Array.from({ length: 24 }, (_, i) => `/fixture/long-${i}.pdf`),
      x: 120,
      y: 70,
    });
    await page.waitForFunction(
      () => (window as any).labView.items().length === 1,
    );
    await page.locator(".pile-top").click();
    // PANEL.height in pileLayout.ts, plus the panel's border.
    assert.ok((await page.locator(".file-panel").boundingBox())!.height <= 302);
    assert.ok(
      await page
        .locator(".file-panel")
        .evaluate((el: HTMLElement) => el.scrollHeight > el.clientHeight),
      "long lists scroll inside the bounded panel",
    );
    await page.keyboard.press("Control+a");
    assert.equal(await page.locator(".file.selected").count(), 24);
    await page.keyboard.press("Backspace");
    await page.waitForFunction(
      () => (window as any).labView.items().length === 0,
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
