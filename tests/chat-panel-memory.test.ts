// plan/29: chatting is the side panel's, the main window keeps 记忆.
// The panel shows who it is with, its topics by day with each pet's face
// and 翻译记录 at their foot; 记忆 is one page of three parts.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright";

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

test("侧边聊天：顶上是宠物名字，话题按天分组带宠物头像，没有重复的新话题键，底部进翻译记录", async () => {
  const page = await browser.newPage({ viewport: { width: 420, height: 820 } });
  await page.addInitScript("window.__name = (fn) => fn");
  await page.goto(server.resolvedUrls!.local[0] + "?chat");
  await page.waitForFunction(() => Boolean((window as any).__studio?.chat));
  await page.evaluate(() =>
    (window as any).__studio.chat("talk", "day", "studio", true),
  );
  assert.equal(await page.locator(".chat-name > span").textContent(), "栗子");
  await page.locator(".chat-topic").nth(2).waitFor();
  assert.equal(await page.locator(".chat-new").count(), 0);
  assert.ok((await page.locator(".chat-topics-day").count()) >= 1);
  await page.waitForFunction(
    () => document.querySelectorAll(".topic-face[src]").length === 3,
  );
  // The remove key sits over the row, so every row is as wide as the list.
  const widths = await page
    .locator(".topic-open")
    .evaluateAll((bs) => bs.map((b) => b.getBoundingClientRect().width));
  assert.equal(new Set(widths).size, 1);
  await page.locator(".chat-translations-entry").click();
  await page.locator(".chat-translation").waitFor();
  assert.equal(
    await page.locator(".chat-view").getAttribute("data-topics"),
    "closed",
  );
  await page.close();
});

test("记忆一页：左边 关于你 / 它记住的 / 资料库；它记住的按“你的情况、做事的经验”筛；没有聊天页", async () => {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 820 },
  });
  await page.addInitScript("window.__name = (fn) => fn");
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() => Boolean((window as any).__studio));
  assert.deepEqual(
    await page
      .locator("#blocks [data-block]")
      .evaluateAll((bs) => bs.map((b) => (b as HTMLElement).dataset.block)),
    ["pet", "memory", "reminders", "focus", "settings"],
  );
  await page.evaluate(() => (window as any).__studio.block("memory"));
  await page.locator(".memory-nav button").nth(3).waitFor();
  assert.deepEqual(await page.locator(".memory-nav button").allTextContents(), [
    "关于你",
    "它记住的",
    "资料库",
    "剪贴板记录",
  ]);
  assert.equal(await page.locator(".memory-about textarea").isVisible(), true);
  await page.locator('.memory-nav [data-view="remembered"]').click();
  await page.locator(".memory-entry").nth(2).waitFor();
  await page.locator('.memory-chip[data-filter="notes"]').click();
  await page.waitForFunction(
    () => document.querySelectorAll(".memory-entry").length === 1,
  );
  assert.match(
    (await page.locator(".memory-entry .memory-kind").textContent())!,
    /做事的经验/,
  );
  // Older ways in still land: tips and the host ("library").
  await page.evaluate(() =>
    document
      .querySelector("#app")!
      .dispatchEvent(new CustomEvent("show-block", { detail: "library" })),
  );
  assert.equal(await page.locator(".memory-library").isVisible(), true);
  assert.equal(await page.locator(".memory-remembered").isVisible(), false);
  await page.close();
});
