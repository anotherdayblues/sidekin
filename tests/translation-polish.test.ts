// plan/41: the 翻译 page can be typed in and searched, and a click puts a
// record's original back in the box; the bubble shows 对方语言 and 语气,
// which language the result went into, and 替换为译文 only for a selection.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";

test("翻译页和翻译气泡", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const origin = server.resolvedUrls!.local[0];
    const page = await browser.newPage({
      viewport: { width: 420, height: 720 },
    });
    await page.addInitScript("window.__name = (fn) => fn");
    await page.goto(origin + "?chat");
    await page.waitForFunction(() =>
      Boolean((window as any).__studio?.translations),
    );
    const now = Date.now();
    await page.evaluate(
      (now) =>
        (window as any).__studio.translations([
          {
            id: 2,
            source: "周末吃拉面吧",
            result: "週末ラーメン食べよう",
            at: now,
            into: "日文",
          },
          { id: 1, source: "Hello", result: "你好", at: now - 60_000 },
        ]),
      now,
    );
    const items = page.locator(".tr-item");
    await items.nth(1).waitFor();
    assert.match(
      await items.nth(0).locator(".tr-when").innerText(),
      /译成日文/,
    );
    assert.doesNotMatch(
      await items.nth(1).locator(".tr-when").innerText(),
      /译成/,
    );
    // Search keeps what matches, original or translation.
    await page.fill(".tr-search", "ラーメン");
    assert.equal(await items.count(), 1);
    await page.fill(".tr-search", "没有这句");
    assert.equal(await items.count(), 0);
    assert.equal(
      await page.locator(".tr-scroll .chat-empty").innerText(),
      "没有找到",
    );
    await page.fill(".tr-search", "");
    assert.equal(await items.count(), 2);
    // A click on the record, not its buttons, puts its original in the box.
    await items.nth(1).locator(".tr-when").click();
    assert.equal(await page.inputValue(".tr-compose textarea"), "Hello");
    await items.nth(0).locator(".tr-copy").click();
    assert.equal(await page.inputValue(".tr-compose textarea"), "Hello");
    // The bar: your language, then theirs, then 语气.
    assert.equal(
      await page.locator(".chat-translation .tb-mine").innerText(),
      "中文",
    );
    assert.equal(
      await page.inputValue(".chat-translation .tb-partner"),
      "英文",
    );
    await page.close();

    const bubble = await browser.newPage({
      viewport: { width: 420, height: 420 },
    });
    await bubble.addInitScript("window.__name = (fn) => fn");
    await bubble.goto(origin + "?bubble");
    await bubble.waitForFunction(() =>
      Boolean((window as any).__studio?.bubble),
    );
    await bubble.evaluate(() => (window as any).__studio.bubble("translation"));
    const visible = (q: string) => bubble.locator(q).isVisible();
    assert.ok(await visible(".bubble-card .translate-bar"));
    assert.ok(await visible("[data-selection-tabs]"));
    assert.equal(await bubble.locator("[data-into]").innerText(), "译成中文");
    assert.ok(await visible("[data-replace]"));
    assert.equal(await bubble.locator("[data-copy]").innerText(), "复制译文");
    assert.ok(
      await visible(".bubble-compose"),
      "the next sentence is typed right there",
    );
    // Typing: no selection tabs, no 替换为译文, the translation placeholder.
    await bubble.evaluate(() =>
      (window as any).__studio.bubble("translation-typing"),
    );
    assert.ok(await visible(".bubble-card .translate-bar"));
    assert.ok(!(await visible("[data-selection-tabs]")));
    assert.ok(!(await visible("[data-replace]")));
    assert.equal(
      await bubble
        .locator(".bubble-compose textarea")
        .getAttribute("placeholder"),
      "打字翻译，回车发出",
    );
    // Chat has no bar.
    await bubble.evaluate(() => (window as any).__studio.bubble("answer"));
    assert.ok(!(await visible(".bubble-card .translate-bar")));
  } finally {
    await browser.close();
    await server.close();
  }
});
