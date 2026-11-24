import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { bubbleBridge } from "../../scripts/qa/window.ts";

test("native file gestures use one session, survive an offscreen cancel, and ignore a released preparation", async () => {
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
      viewport: { width: 544, height: 400 },
    });
    const paths = ["/fixture/a.pdf", "/fixture/b.png"];
    let launched = 0,
      prepared = 0,
      complete: ((s: string) => void) | null = null;
    let preparation: Promise<void> | null = null,
      releasePreparation: (() => void) | null = null;
    await bubbleBridge(page, async (cmd, args) => {
      if (cmd === "lab_load")
        return {
          state: {
            items: [
              {
                id: "stack",
                kind: "stack",
                name: "2 items",
                paths,
                addedAt: 1,
                locked: false,
              },
            ],
            lastRemoved: [],
          },
          positions: {},
          dockSide: "right",
          layoutVersion: 3,
        };
      if (cmd === "lab_existing") {
        prepared++;
        if (preparation) await preparation;
        return args.paths;
      }
      if (cmd === "lab_describe")
        return paths.map((path) => ({
          path,
          isDirectory: false,
          exists: true,
        }));
      if (cmd === "lab_preview") return "/fixture/drag-preview.png";
      if (cmd === "lab_drag") {
        launched++;
        return new Promise<string>((resolve) => (complete = resolve));
      }
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?files");
    await page.waitForFunction(() => Boolean((window as any).labView));
    assert.equal(
      await page
        .locator(".pile-top")
        .evaluate((el: HTMLElement) => el.draggable),
      false,
      "WebKit must not start a second browser drag alongside the native session",
    );
    await page.locator(".pile-top").click();
    assert.equal(
      await page.locator(".file-panel").count(),
      1,
      "a click still expands the stack",
    );
    await page.keyboard.press("Escape");
    const box = (await page.locator(".pile-top").boundingBox())!;
    const x = box.x + box.width / 2,
      y = box.y + 20;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 15, y);
    await page.waitForFunction(() => document.body.dataset.dragging === "true");
    for (let i = 0; i < 50 && !complete; i++) await page.waitForTimeout(10);
    assert.equal(launched, 1);
    await page.mouse.move(580, y);
    await page.mouse.move(x + 20, y);
    await page.mouse.up();
    complete!("Cancel");
    await page.waitForFunction(() => !document.body.dataset.dragging);
    assert.equal(await page.locator(".pile").count(), 1);
    assert.deepEqual(
      await page.evaluate(() => (window as any).labView.items()[0].paths),
      paths,
    );
    assert.equal(
      await page.locator(".file-panel").count(),
      0,
      "finishing a native drag must not turn its final click into an expansion",
    );
    preparation = new Promise<void>(
      (resolve) => (releasePreparation = resolve),
    );
    const before = prepared;
    await page.mouse.move(x, y);
    await page.mouse.down();
    await page.mouse.move(x + 15, y);
    for (let i = 0; i < 50 && prepared === before; i++)
      await page.waitForTimeout(10);
    assert.equal(prepared, before + 1);
    await page.mouse.up();
    releasePreparation!();
    await page.waitForFunction(() => !document.body.dataset.dragging);
    assert.equal(
      launched,
      1,
      "a released gesture must not create a delayed native preview",
    );
    await page.locator(".pile-top").click();
    assert.equal(
      await page.locator(".file-panel").count(),
      1,
      "the retained stack remains interactive",
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
