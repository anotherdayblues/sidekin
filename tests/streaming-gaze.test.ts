import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

// Deliver real pet-window events, using only fixture settings and a synthetic caret.
test("流式回复不会在两次光标采样之间把目光切回正面", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  try {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      await bubbleBridge(page, async (cmd) => {
        if (cmd === "get_state")
          return {
            pets: [],
            custom: {},
            drafts: [],
            settings: { behaviors: {}, visible: false },
          };
        if (cmd === "companion_settings") return { enabled: true };
        if (cmd.includes("menu")) return [1, "menu"];
        if (cmd === "list_reminders") return [];
        return null;
      });
      await page.goto(server.resolvedUrls!.local[0] + "?fixture");
      const result = await page.evaluate(async () => {
        const { SpritePlayer } = await import("/src/player.ts");
        const { mountPet } = await import("/src/pet.ts");
        const writes: unknown[] = [];
        const original = SpritePlayer.prototype.setGaze;
        SpritePlayer.prototype.setGaze = function (point: unknown) {
          writes.push(point);
          return original.call(this, point);
        };
        await mountPet(document.querySelector("#app"));
        const event = (window as any).qaEvent;
        event("bubble-look", { x: 180, y: 280, typing: true });
        const chunk = () =>
          event("brain-event", {
            method: "chat.delta",
            params: { delta: "字" },
          });
        chunk();
        writes.length = 0;
        for (let i = 0; i < 20; i++) chunk();
        return writes.filter((point) => point === null).length;
      });
      assert.equal(result, 0);
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
});

test("返回气泡会清掉上次的内容，迟到的回复不会盖住输入框", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  try {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const page = await browser.newPage();
      let finish!: (v: unknown) => void;
      let token = "";
      const event = await bubbleBridge(page, async (cmd, p) => {
        if (cmd === "get_state")
          return { settings: { theme: "day", skin: "studio" } };
        if (cmd === "companion_settings") return { enabled: true };
        if (cmd === "send_chat") {
          token = p.token;
          return new Promise((r) => (finish = r));
        }
        if (cmd === "pending_reminders") return [];
        if (cmd.includes("position")) return { x: 100, y: 100 };
        if (cmd.includes("scale_factor")) return 1;
        return null;
      });
      await page.goto(server.resolvedUrls!.local[0] + "?bubble");
      await page.waitForFunction(() => Boolean((window as any).qaEvent));
      await event("bubble-open", { mode: "input", at: 1 });
      await page.locator("textarea").fill("测试问题");
      await page.locator("[data-send]").click();
      await page.waitForFunction(
        () =>
          document.querySelector(".bubble-card")?.getAttribute("data-state") ===
          "thinking",
      );
      await event("brain-event", {
        method: "chat.delta",
        params: { token, delta: "旧回答" },
      });
      await page.waitForFunction(() =>
        document.querySelector(".bubble-text")?.textContent?.includes("旧回答"),
      );
      await event("bubble-open", { mode: "return-input", at: 2 });
      finish({ text: "旧回答的结尾" });
      await event("brain-event", {
        method: "chat.delta",
        params: { token, delta: "迟到的字" },
      });
      assert.equal(await page.locator(".bubble-text").textContent(), "");
      assert.equal(
        await page.locator(".bubble-card").getAttribute("data-state"),
        "input",
      );
      assert.ok(await page.locator("textarea").isVisible());
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
});
