// 翻译记录: one translation can be deleted, or all of them, each after a
// yes in place; 取消 leaves everything as it was.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";

const SHOTS = process.env.TR_SHOTS;

test("翻译记录：删一条、取消、全部清除", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({
      viewport: { width: 420, height: 720 },
      deviceScaleFactor: SHOTS ? 2 : 1,
    });
    await page.addInitScript("window.__name = (fn) => fn");
    await page.goto(server.resolvedUrls!.local[0] + "?chat");
    await page.waitForFunction(() =>
      Boolean((window as any).__studio?.translations),
    );
    const now = Date.now();
    await page.evaluate(
      (now) =>
        (window as any).__studio.translations(
          [
            { id: 3, source: "Thanks", result: "谢谢", at: now },
            { id: 2, source: "Good night", result: "晚安", at: now - 60_000 },
            { id: 1, source: "Hello", result: "你好", at: now - 120_000 },
          ],
          true,
        ),
      now,
    );
    const items = page.locator(".tr-item");
    await items.nth(2).waitFor();
    const clear = page.locator("[data-tr-clear]");
    assert.equal(await clear.isVisible(), true);

    // Hover reveals the trash icon; clicking asks in place; 取消 brings the icons back.
    const second = items.nth(1);
    await second.hover();
    assert.ok(
      (await second.locator(".tr-delete svg").count()) === 1,
      "delete action uses a trash glyph icon",
    );
    await second.locator(".tr-delete").click();
    await second.getByText("删掉这条翻译？").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/tr-ask-one.png` });
    await second.getByRole("button", { name: "取消" }).click();
    await second.locator(".tr-copy").waitFor();
    assert.equal(await items.count(), 3);

    // 确认删除: that one is gone, the others stay.
    await second.hover();
    await second.locator(".tr-delete").click();
    await second.getByRole("button", { name: "确认删除" }).click();
    await page.waitForFunction(
      () => document.querySelectorAll(".tr-item").length === 2,
    );
    assert.deepEqual(
      (await page.locator(".tr-text").allTextContents()).map((x) => x.trim()),
      ["谢谢", "你好"],
    );

    // 全部清除 asks on top, then leaves the empty note and no clear key.
    await clear.click();
    await page.getByText("清除全部翻译记录？").waitFor();
    if (SHOTS) await page.screenshot({ path: `${SHOTS}/tr-ask-all.png` });
    await page
      .locator(".tr-ask.is-all")
      .getByRole("button", { name: "确认删除" })
      .click();
    await page.locator(".tr-scroll .chat-empty").waitFor();
    assert.equal(await items.count(), 0);
    assert.equal(await clear.isVisible(), false);
  } finally {
    await browser.close();
    await server.close();
  }
});
