// 宠物图只留一份 (plan/22 M2): players in one window share a decoded sheet,
// keep only its opacity for hit tests, and let it go when none use it. The
// hit test must answer exactly as it did with the full RGBA copy.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";

test("同一窗口的播放器共用一张图，点击判断和整份像素时一致，不用了就放掉", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.addInitScript({ content: "globalThis.__name=(f)=>f" });
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    const r = await page.evaluate(async () => {
      const { SpritePlayer, heldSheets } = await import("/src/player.ts");
      const { exampleSprite } = await import("/src/bridge.ts");
      const canvas = () => document.createElement("canvas");
      const a = new SpritePlayer(canvas()),
        b = new SpritePlayer(canvas());
      await Promise.all([a.load(exampleSprite), b.load(exampleSprite)]);
      const shared = heldSheets();
      // The old way: every pixel's RGBA, alpha read at +3.
      const img = new Image();
      img.src = exampleSprite;
      await img.decode();
      const c = canvas();
      c.width = img.width;
      c.height = img.height;
      const ctx = c.getContext("2d")!;
      ctx.drawImage(img, 0, 0);
      const rgba = ctx.getImageData(0, 0, img.width, img.height).data;
      let checked = 0,
        differ = 0,
        on = 0;
      for (const [row, frame] of [
        [0, 0],
        [1, 2],
        [4, 3],
      ]) {
        (a as any).pose = () => ({ row, frame });
        for (let y = 0; y < 208; y += 3)
          for (let x = 0; x < 192; x += 3) {
            const old =
              rgba[((row * 208 + y) * img.width + frame * 192 + x) * 4 + 3] >
              35;
            const now = a.hit((x + 0.5) / 192, (y + 0.5) / 208);
            checked++;
            if (old) on++;
            if (old !== now) differ++;
          }
      }
      a.destroy();
      const afterOne = heldSheets();
      b.destroy();
      return { shared, afterOne, after: heldSheets(), checked, differ, on };
    });
    assert.equal(r.shared, 1, "two players, one decoded sheet");
    assert.ok(r.on > 100, "the sample covers the pet");
    assert.equal(r.differ, 0, `${r.differ} of ${r.checked} hits changed`);
    assert.equal(r.afterOne, 1, "still used by the other player");
    assert.equal(r.after, 0, "let go once nobody uses it");
  } finally {
    await browser.close();
    await server.close();
  }
});
