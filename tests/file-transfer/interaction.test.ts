import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

test("opening keeps the pile fixed; row clicks toggle and selected removals preserve other files", async () => {
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
    await page.addInitScript({
      content: `globalThis.__name=f=>f;window.labInvoke=async(cmd,args)=>{if(cmd==='lab_load')return {state:{items:[],lastRemoved:[]},positions:{},layoutVersion:2};if(cmd==='lab_save')window.labSaved=args.view;if(cmd==='lab_regions'){window.labRegions=args.regions;window.labPanelOpen=args.open;}};`,
    });
    await page.goto(server.resolvedUrls!.local[0] + "?files");
    await page.waitForFunction(() => Boolean((window as any).labView));
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("lab-drop", {
          detail: {
            paths: ["/fixture/a.pdf", "/fixture/b.png", "/fixture/c.txt"],
            x: 470,
            y: 320,
          },
        }),
      ),
    );
    await page.waitForFunction(
      () => (window as any).labView.items().length === 1,
    );
    const before = await page.locator(".pile-top").boundingBox();
    await page.locator(".pile-top").click();
    assert.deepEqual(
      await page.locator(".pile-top").boundingBox(),
      before,
      "expanding must not move the file stack",
    );
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector(".file-panel")!).visibility ===
        "visible",
    );
    // The host reads the pointer quickly while the panel is open, so a short
    // click elsewhere still closes it (tracker.rs).
    assert.equal(await page.evaluate(() => (window as any).labPanelOpen), true);
    // Move the attachment while the mouse is still held. Native hit regions must
    // follow immediately, even though the expanded panel waits until release.
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("lab-pointer", { detail: { left: true } }),
      );
      window.dispatchEvent(
        new CustomEvent("lab-layout", {
          detail: {
            origin: { x: 120, y: 110 },
            work: { x: 0, y: 0, width: 544, height: 400 },
          },
        }),
      );
    });
    const moved = await page.locator(".pile-top").boundingBox();
    assert.equal(
      await page.evaluate(() => (window as any).labRegions[0].x),
      moved!.x,
      "click regions must track the visible icon during a gesture",
    );
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("lab-pointer", { detail: { left: false } }),
      );
      window.dispatchEvent(
        new CustomEvent("lab-layout", {
          detail: {
            origin: { x: 0, y: 0 },
            work: { x: 0, y: 0, width: 544, height: 400 },
          },
        }),
      );
    });
    await page.waitForTimeout(40);
    const panelBefore = await page.locator(".file-panel").boundingBox();
    await page.evaluate(() => {
      window.dispatchEvent(
        new CustomEvent("lab-pointer", { detail: { left: true } }),
      );
      window.dispatchEvent(
        new CustomEvent("lab-layout", {
          detail: {
            origin: { x: 0, y: 0 },
            work: { x: 200, y: 80, width: 344, height: 320 },
          },
        }),
      );
    });
    assert.deepEqual(
      await page.locator(".file-panel").boundingBox(),
      panelBefore,
      "an active gesture keeps the list still",
    );
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("lab-pointer", { detail: { left: false } }),
      ),
    );
    await page.waitForFunction(
      () =>
        document.querySelector(".file-panel")!.getBoundingClientRect().x >= 200,
    );
    assert.deepEqual(
      await page.locator(".pile-top").boundingBox(),
      before,
      "screen-edge reflow moves only the list",
    );
    await page.locator(".file").nth(0).click();
    await page.locator(".file").nth(1).click();
    assert.equal(
      await page.locator(".file.selected").count(),
      2,
      "whole-row clicks accumulate checks",
    );
    await page.evaluate(() =>
      document
        .querySelectorAll(".file")[1]
        .dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, cancelable: true }),
        ),
    );
    await page.waitForFunction(() => (window as any).labLastDrag?.length === 2);
    await page.evaluate(() =>
      document
        .querySelectorAll(".file")[1]
        .dispatchEvent(new MouseEvent("click", { bubbles: true })),
    );
    assert.equal(
      await page.locator(".file.selected").count(),
      2,
      "the click ending a native drag must not toggle the row",
    );
    await page.locator(".file").nth(0).click();
    assert.equal(
      await page.locator(".file.selected").count(),
      1,
      "clicking a checked row unchecks it",
    );
    await page.getByRole("button", { name: "移除 a.pdf", exact: true }).click();
    await page.waitForFunction(
      () => (window as any).labView.items()[0].paths.length === 2,
    );
    assert.deepEqual(
      await page.evaluate(() => (window as any).labView.items()[0].paths),
      ["/fixture/b.png", "/fixture/c.txt"],
    );
    await page.getByRole("button", { name: "移除", exact: true }).click();
    await page.waitForFunction(
      () => (window as any).labView.items()[0].paths.length === 1,
    );
    assert.equal(
      await page.evaluate(() => (window as any).labView.items()[0].name),
      "c.txt",
    );
    await page.locator(".file").click();
    await page.keyboard.press("Delete");
    await page.waitForFunction(
      () => (window as any).labView.items().length === 0,
    );
    assert.equal(await page.locator(".pile").count(), 0);
    // No panel left: the host may read the pointer slowly again.
    await page.waitForFunction(() => (window as any).labPanelOpen === false);
  } finally {
    await browser.close();
    await server.close();
  }
});
