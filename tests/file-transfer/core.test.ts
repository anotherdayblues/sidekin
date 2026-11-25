import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { ShelfStore } from "../../apps/desktop/src/fileTransfer/vendor/droper/shelfStore.ts";
import { shouldRemoveAfterDragOut } from "../../apps/desktop/src/fileTransfer/vendor/droper/dragOut.ts";

test("Droper grouping preserves distinct paths with the same filename", () => {
  const store = new ShelfStore({
    persistence: { load: () => null, save: () => {} },
    exists: () => true,
  });
  const added = store.addPaths(["/one/report.pdf", "/two/report.pdf"]);
  const stack = store.mergeToStack(added.map((i) => i.id))!;
  assert.deepEqual(stack.paths, ["/one/report.pdf", "/two/report.pdf"]);
  assert.equal(store.addPaths(["/one/report.pdf"]).length, 0);
  assert.equal(store.splitStack(stack.id).length, 2);
  assert.equal(
    shouldRemoveAfterDragOut({
      operation: "none",
      endedOnShelf: false,
      removeAfterDragOut: true,
    }),
    false,
  );
});

test("real file-stack UI groups drops, expands and keeps files after a cancelled drag", async () => {
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
      content: `globalThis.__name=f=>f; window.labInvoke=async(cmd,args)=>{if(cmd==="lab_load")return {state:{items:[],lastRemoved:[]},positions:{}};if(cmd==="lab_save")window.labSaved=args.view;};`,
    });
    await page.goto(server.resolvedUrls!.local[0] + "?files");
    await page.waitForFunction(() => Boolean((window as any).labView));
    const preview = await page.evaluate(async () => {
      const { dragPreview } = await import("/src/fileTransfer/dragPreview.ts");
      const bytes = new Uint8Array(
        await dragPreview(["/fixture/a.pdf", "/fixture/b.png"]),
      );
      const dimensions = new DataView(bytes.buffer);
      return [dimensions.getUint32(16), dimensions.getUint32(20)];
    });
    assert.deepEqual(
      preview,
      [48, 56],
      "OS drag preview must not use the 512px app icon",
    );
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("lab-drop", {
          detail: {
            paths: ["/fixture/a.pdf", "/fixture/b.png"],
            x: 420,
            y: 75,
          },
        }),
      ),
    );
    await page.waitForFunction(
      () => (window as any).labView.items().length === 1,
    );
    assert.equal(await page.locator(".count").textContent(), "2");
    const covers = await page
      .locator(".sheet .pile-icon")
      .evaluateAll((els) => els.map((e) => (e as HTMLImageElement).alt));
    assert.equal(covers.length, 2, "a mixed stack shows one sheet per kind");
    assert.notEqual(covers[0], covers[1]);
    await page.evaluate(() =>
      document
        .querySelector(".pile-top")!
        .dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, cancelable: true }),
        ),
    );
    await page.waitForFunction(() => (window as any).labLastDrag?.length === 2);
    assert.deepEqual(await page.evaluate(() => (window as any).labLastDrag), [
      "/fixture/a.pdf",
      "/fixture/b.png",
    ]);
    await page.evaluate(() => {
      (window as any).labLastDrag = null;
      (window as any).labDragResult = "Dropped";
    });
    await page.evaluate(() =>
      document
        .querySelector(".pile-top")!
        .dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, cancelable: true }),
        ),
    );
    await page.waitForFunction(
      () => document.querySelector(".notice")?.textContent === "已交给目标应用",
    );
    assert.deepEqual(
      await page.evaluate(() => (window as any).labView.items()[0].paths),
      ["/fixture/a.pdf", "/fixture/b.png"],
      "a delivered stack stays staged for the next target",
    );
    await page.evaluate(() => {
      (window as any).labLastDrag = null;
      (window as any).labDragResult = undefined;
    });
    await page.locator(".pile-top").click();
    assert.equal(await page.locator(".file").count(), 2);
    await page.evaluate(() =>
      document
        .querySelector(".file")!
        .dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, cancelable: true }),
        ),
    );
    await page.waitForFunction(() => Boolean((window as any).labLastDrag));
    assert.deepEqual(await page.evaluate(() => (window as any).labLastDrag), [
      "/fixture/a.pdf",
    ]);
    assert.equal(
      await page.evaluate(
        () => (window as any).labView.items()[0].paths.length,
      ),
      2,
    );
    // On macOS, Finder-style lists hide both row and header checkboxes so
    // .all-check never overflows the 0px checkbox column; Windows shows them.
    await page.evaluate(() => {
      document.documentElement.dataset.platform = "mac";
    });
    assert.deepEqual(
      await page.evaluate(() => {
        const all = getComputedStyle(document.querySelector(".all-check")!);
        const row = getComputedStyle(document.querySelector(".file-check")!);
        const pile = getComputedStyle(document.querySelector(".pile")!);
        return {
          allOpacity: all.opacity,
          rowOpacity: row.opacity,
          pileFilter: pile.filter,
        };
      }),
      { allOpacity: "0", rowOpacity: "0", pileFilter: "none" },
      "macOS hides checkboxes without overlap and keeps .pile free of ancestor filter",
    );
    await page.evaluate(() => {
      document.documentElement.dataset.platform = "win";
    });
    await page.locator(".file-check").nth(0).check();
    await page.locator(".file-check").nth(1).check();
    assert.equal(
      await page.locator(".file.selected").count(),
      2,
      "checkboxes accumulate a selection",
    );
    // All chosen: the box over the list shows it.
    assert.equal(await page.locator(".all-check").isChecked(), true);
    assert.equal(await page.locator(".file.selected").count(), 2);
    await page.evaluate(() =>
      document
        .querySelectorAll(".file")[1]
        .dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, cancelable: true }),
        ),
    );
    await page.waitForFunction(() => (window as any).labLastDrag?.length === 2);
    // The box over the list chooses none again.
    await page.locator(".all-check").uncheck();
    assert.equal(await page.locator(".file.selected").count(), 0);
    await page.locator(".file").nth(1).click();
    assert.equal(await page.locator(".file.selected").count(), 1);
    await page.evaluate(() =>
      document
        .querySelectorAll(".file")[1]
        .dispatchEvent(
          new DragEvent("dragstart", { bubbles: true, cancelable: true }),
        ),
    );
    await page.waitForFunction(() => (window as any).labLastDrag?.length === 1);
    assert.deepEqual(await page.evaluate(() => (window as any).labLastDrag), [
      "/fixture/b.png",
    ]);
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("lab-drop", {
          detail: { paths: ["/fixture/c.zip"], x: 425, y: 80 },
        }),
      ),
    );
    await page.waitForFunction(
      () => (window as any).labView.items()[0].paths.length === 3,
    );
    assert.equal(await page.locator(".pile").count(), 1);
    await page.locator(".remove").evaluate((el: HTMLElement) => el.click());
    await page.waitForFunction(
      () => (window as any).labView.items().length === 0,
    );
    assert.equal(await page.locator(".pile").count(), 0);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("1-file panel has no spurious scrollbar; regions track badge & notice; blocked drops and discards hook cleanly", async () => {
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
      content: `globalThis.__name=f=>f; window.discarded=[]; window.labRegions=[]; window.permCalls=[]; window.labInvoke=async(cmd,args)=>{if(cmd==="lab_load")return {state:{items:[],lastRemoved:[]},positions:{}};if(cmd==="lab_regions")window.labRegions=args.regions;if(cmd==="lab_discard_staged")window.discarded.push(args.paths);if(cmd==="open_permission_settings"||cmd==="open_companion_page")window.permCalls.push([cmd,args]);};`,
    });
    await page.goto(server.resolvedUrls!.local[0] + "?files");
    await page.waitForFunction(() => Boolean((window as any).labView));
    // Drop 1 readable + 1 blocked file: keeps the readable one and shows persistent .perm-card.
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("lab-drop", {
          detail: {
            paths: ["/fixture/solo.pdf"],
            blocked: 1,
            blockedReason: "appDataDenied",
            x: 420,
            y: 75,
          },
        }),
      ),
    );
    await page.waitForFunction(
      () => (window as any).labView.items().length === 1,
    );
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElement>(".perm-card")?.hidden === false,
    );
    // Regions must cover .pile-top, .count badge, and the active .perm-card.
    await page.waitForFunction(() => (window as any).labRegions.length >= 3);
    // Clicking the card's action button opens OS appData settings and dismisses the card.
    await page.locator(".perm-card-action").click();
    await page.waitForFunction(
      () => (window as any).permCalls.length === 1,
    );
    assert.deepEqual(
      await page.evaluate(() => (window as any).permCalls[0]),
      ["open_permission_settings", { kind: "appData" }],
    );
    // When appData switch is turned off in Suiby, blocked drop routes to Suiby's permissions section.
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("lab-drop", {
          detail: {
            paths: [],
            blocked: 1,
            blockedReason: "appDataOff",
            x: 420,
            y: 75,
          },
        }),
      ),
    );
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLElement>(".perm-card")?.hidden === false,
    );
    await page.locator(".perm-card-action").click();
    await page.waitForFunction(
      () => (window as any).permCalls.length === 2,
    );
    assert.deepEqual(
      await page.evaluate(() => (window as any).permCalls[1]),
      ["open_companion_page", { history: false, section: "access" }],
    );
    // Expand the 1-file panel: border-box height must fit without a spurious vertical scrollbar.
    await page.locator(".pile-top").click();
    await page.waitForFunction(
      () =>
        getComputedStyle(document.querySelector(".file-panel")!).visibility ===
        "visible",
    );
    const overflow = await page.locator(".file-panel").evaluate((el) => ({
      scrollHeight: el.scrollHeight,
      clientHeight: el.clientHeight,
    }));
    assert.ok(
      overflow.scrollHeight <= overflow.clientHeight,
      `1-file panel should not overflow (${overflow.scrollHeight} > ${overflow.clientHeight})`,
    );
    // Removing the pile must call lab_discard_staged with the removed path.
    await page.locator(".remove").evaluate((el: HTMLElement) => el.click());
    await page.waitForFunction(
      () => (window as any).discarded.length === 1,
    );
    assert.deepEqual(
      await page.evaluate(() => (window as any).discarded[0]),
      ["/fixture/solo.pdf"],
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
