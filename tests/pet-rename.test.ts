// plan/29: a pet's name changes by a double-click on it (a pencil shows on
// hover) or from the list's right-click menu.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";

let server: ViteDevServer, browser: Browser;
test.before(async () => {
  server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  browser = await chromium.launch({ channel: "chrome" });
});
test.after(async () => {
  await browser?.close();
  await server?.close();
});

async function studio(): Promise<Page> {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 820 },
  });
  await page.addInitScript("window.__name = (fn) => fn");
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() => Boolean((window as any).__studio?.load));
  await page.evaluate(() => (window as any).__studio.load("learned"));
  await page.waitForFunction(
    () => document.querySelector("#name")?.textContent === "栗子",
  );
  return page;
}

test("双击名字改名：悬停有铅笔，回车保存，Esc 还原，最多 12 个字", async () => {
  const page = await studio();
  const name = page.locator("#name");
  assert.equal(await name.getAttribute("title"), "双击改名");
  await name.hover();
  const pencil = await name.evaluate(
    (h) => getComputedStyle(h, "::after").opacity,
  );
  await page.waitForTimeout(200);
  assert.equal(
    await name.evaluate((h) => getComputedStyle(h, "::after").opacity),
    "1",
    `pencil was ${pencil}`,
  );

  await name.dblclick();
  assert.equal(await name.getAttribute("contenteditable"), "plaintext-only");
  await page.keyboard.type("大橘子");
  await page.keyboard.press("Escape");
  assert.equal(await name.textContent(), "栗子");

  await name.dblclick();
  await page.keyboard.type("一二三四五六七八九十十一十二");
  assert.equal([...((await name.textContent()) ?? "")].length, 12);
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("小栗");
  await page.keyboard.press("Enter");
  await page.waitForFunction(async () =>
    [...document.querySelectorAll(".pet-tile-name")].some(
      (n) => n.textContent === "小栗",
    ),
  );
  assert.equal(await name.textContent(), "小栗");
  assert.equal(await name.getAttribute("contenteditable"), "false");
  await page.close();
});

test("宠物列表右键：重命名排在第一项，选中那只并开始改名", async () => {
  const page = await studio();
  await page.locator(".pet-tile").nth(1).click({ button: "right" });
  const items = await page.locator("#pop .pop-item").allTextContents();
  assert.equal(items[0], "重命名");
  assert.ok(items.includes("删除宠物") || items.length >= 2);
  await page.locator("#pop .pop-item").first().click();
  await page.waitForFunction(
    () => (document.querySelector("#name") as HTMLElement).isContentEditable,
  );
  assert.equal(await page.locator("#name").textContent(), "团子");
  await page.keyboard.type("圆圆");
  await page.keyboard.press("Enter");
  await page.waitForFunction(() =>
    [...document.querySelectorAll(".pet-tile-name")].some(
      (n) => n.textContent === "圆圆",
    ),
  );
  await page.close();
});
