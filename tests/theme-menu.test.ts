// The appearance key opens a menu of every choice with the current one
// ticked; picking one saves it, picking the current one changes nothing.
// It no longer steps 白天 → 晚上 → 跟随系统 one click at a time.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";

test("外观键：点开是三个选项的菜单，当前的打勾，选了就保存", async () => {
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
      viewport: { width: 1180, height: 760 },
    });
    await page.addInitScript("window.__name = (fn) => fn");
    await page.goto(server.resolvedUrls!.local[0]);
    await page.waitForFunction(() => Boolean((window as any).__studio));
    const saved = () =>
      page.evaluate(
        () =>
          JSON.parse(localStorage.getItem("pet-studio-preview") ?? "{}")
            .settings?.theme,
      );
    const before = await saved();

    const key = page.locator("#theme-key");
    assert.equal(await key.getAttribute("aria-haspopup"), "menu");
    await key.click();
    const items = page.locator(".theme-menu [role=menuitemradio]");
    assert.deepEqual(await items.allTextContents(), [
      "白天",
      "晚上",
      "跟随系统",
    ]);
    const checked = await items.evaluateAll(
      (bs) =>
        bs.filter((b) => b.getAttribute("aria-checked") === "true").length,
    );
    assert.equal(checked, 1);
    // Opening the menu saves nothing.
    assert.equal(await saved(), before);

    // A choice is saved, and the menu closes.
    await page.locator(".theme-menu [data-theme=night]").click();
    await page.waitForFunction(
      () =>
        JSON.parse(localStorage.getItem("pet-studio-preview") ?? "{}").settings
          ?.theme === "night",
    );
    assert.equal(await page.locator("#pop").isVisible(), false);

    // Next time it is the ticked one.
    await key.click();
    assert.equal(
      await page
        .locator(".theme-menu [data-theme=night]")
        .getAttribute("aria-checked"),
      "true",
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
