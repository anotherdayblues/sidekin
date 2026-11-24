import assert from "node:assert/strict";
import test from "node:test";
import { chromium } from "playwright";
import { createServer } from "vite";
import { bubbleBridge } from "../scripts/qa/window.ts";

test("the pet tracks the rendered caret across wrapping, mixed glyph widths and scrolling", async () => {
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
      await page.goto(server.resolvedUrls!.local[0] + "?fixture");
      const result = await page.evaluate(async () => {
        const { caretPoint } = await import("/src/caretLook.ts");
        const input = document.createElement("textarea");
        input.style.cssText =
          "position:fixed;left:30px;top:40px;width:120px;height:48px;box-sizing:border-box;padding:4px 8px;border:1px solid;font:16px/24px Arial;resize:none;overflow:auto";
        document.body.append(input);
        input.value = "aaaa";
        input.setSelectionRange(4, 4);
        const first = caretPoint(input);
        input.value = "aaaaaaaaaaaaaaaaaa";
        input.setSelectionRange(18, 18);
        const wrapped = caretPoint(input);
        input.value = "iiii";
        input.setSelectionRange(4, 4);
        const narrow = caretPoint(input);
        input.value = "汉汉汉汉";
        input.setSelectionRange(4, 4);
        const wide = caretPoint(input);
        input.value = "a\nb\nc\nd\ne\nf";
        input.setSelectionRange(input.value.length, input.value.length);
        const scrolled = caretPoint(input);
        input.scrollTop = 24;
        const afterScroll = caretPoint(input);
        input.remove();
        return { first, wrapped, narrow, wide, scrolled, afterScroll };
      });
      assert.ok(
        result.wrapped.y > result.first.y + 15,
        "soft wrapping moves the caret down",
      );
      assert.ok(
        result.wrapped.x < 130,
        "the wrapped caret returns from the right edge",
      );
      assert.ok(
        result.wide.x > result.narrow.x + 15,
        "glyph widths affect the caret position",
      );
      assert.ok(
        result.afterScroll.y < result.scrolled.y - 15,
        "scrolling moves the visible caret",
      );

      const bubble = await browser.newPage();
      const event = await bubbleBridge(bubble, async (cmd) => {
        if (cmd === "get_state")
          return { settings: { theme: "day", skin: "studio" } };
        if (cmd === "companion_settings") return { enabled: true };
        if (cmd === "pending_reminders") return [];
        return null;
      });
      await bubble.goto(server.resolvedUrls!.local[0] + "?bubble");
      await bubble.waitForFunction(() => Boolean((window as any).qaEvent));
      await event("bubble-open", { mode: "input", at: 1 });
      await bubble.locator(".bubble-compose textarea").fill("短句");
      const shortLine = await bubble.evaluate(async () => {
        const { caretPoint } = await import("/src/caretLook.ts");
        const input = document.querySelector<HTMLTextAreaElement>(
          ".bubble-compose textarea",
        )!;
        return caretPoint(input).y - input.getBoundingClientRect().top;
      });
      await bubble
        .locator(".bubble-compose textarea")
        .fill(
          "这是要在真实气泡里自动折行的一段中文文字，用来检查宠物是否能看向第二行的光标",
        );
      const secondLine = await bubble.evaluate(async () => {
        const { caretPoint } = await import("/src/caretLook.ts");
        const input = document.querySelector<HTMLTextAreaElement>(
          ".bubble-compose textarea",
        )!;
        return caretPoint(input).y - input.getBoundingClientRect().top;
      });
      assert.ok(
        secondLine > shortLine + 15,
        "the actual bubble tracks a wrapped second line",
      );
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
});
