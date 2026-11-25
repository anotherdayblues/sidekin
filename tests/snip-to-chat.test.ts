import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";
import { defaults, type CompanionSettings } from "../apps/shared/companion.ts";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_URL = `data:image/png;base64,${TINY_PNG_B64}`;

async function withDesktopPage(
  query: string,
  handler: (cmd: string, payload: any) => any,
  run: (ctx: {
    page: Page;
    emit: (name: string, payload: unknown) => Promise<unknown>;
    calls: { cmd: string; payload: any }[];
  }) => Promise<void>,
) {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1000, height: 700 } });
    const calls: { cmd: string; payload: any }[] = [];
    const emit = await bubbleBridge(page, async (cmd, payload) => {
      calls.push({ cmd, payload });
      if (cmd === "get_state") {
        return {
          pets: [{ id: "lizi", displayName: "栗子" }],
          drafts: [],
          custom: {},
          settings: {
            activeId: "lizi",
            theme: "day",
            skin: "native",
          },
        };
      }
      if (cmd === "read_pet_thumbnail") return TINY_PNG_URL;
      return handler(cmd, payload);
    });
    await page.goto(server.resolvedUrls!.local[0] + query);
    await run({ page, emit, calls });
  } finally {
    await browser.close();
    await server.close();
  }
}

test("chat sidebar snip button respects multimodal/vision toggles, handles cold & warm pending snip, and sends default prompt", async () => {
  let settings: CompanionSettings = {
    ...defaults,
    enabled: true,
    vision: true,
    service: "openai",
    model: "gpt-5.4-mini",
    chatSnipShortcut: "Control+Shift+A",
  };
  let snipStatus = { state: "ready", shortcut: "Control+Shift+A" };
  let pending: { data: string; preview: string; draftText?: string } | null = {
    data: TINY_PNG_B64,
    preview: TINY_PNG_URL,
    draftText: "这个报错什么意思",
  };

  await withDesktopPage(
    "?chat",
    (cmd) => {
      if (cmd === "companion_settings") return settings;
      if (cmd === "chat_snip_status") return snipStatus;
      if (cmd === "chat_window_state")
        return { pinned: true, translations: false };
      if (cmd === "take_translations_request") return false;
      if (cmd === "take_chat_turn") return null;
      if (cmd === "current_chat_topic") return { id: 1, turns: [] };
      if (cmd === "chat_topics") return [];
      if (cmd === "take_pending_snip_image") {
        const out = pending;
        pending = null;
        return out;
      }
      if (cmd === "start_chat_snip") return null;
      if (cmd === "send_chat") return { text: "收到截图" };
      return null;
    },
    async ({ page, emit, calls }) => {
      // Cold-start pending snip attaches image and restores draft text immediately.
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>(".chat-attached")?.hidden ===
          false,
      );
      assert.equal(
        await page.locator(".chat-composer textarea").inputValue(),
        "这个报错什么意思",
      );
      const snipBtn = page.locator(".chat-tools [data-snip]");
      assert.equal(await snipBtn.isVisible(), true);
      assert.equal(await snipBtn.getAttribute("aria-disabled"), null);
      assert.match(
        (await snipBtn.getAttribute("title")) ?? "",
        /圈屏提问.*A/,
      );

      // Clicking snip button invokes start_chat_snip.
      await snipBtn.click();
      assert.ok(calls.some((c) => c.cmd === "start_chat_snip"));

      // Clear draft text and verify empty submit sends "这是什么？" with attached PNG.
      await page.locator(".chat-composer textarea").fill("");
      await page.locator(".chat-tools [data-send]").click();
      await page.waitForFunction(() =>
        document.body.textContent?.includes("收到截图"),
      );
      const sent = calls.find((c) => c.cmd === "send_chat");
      assert.equal(sent?.payload.text, "这是什么？");
      assert.equal(sent?.payload.image, TINY_PNG_B64);

      // Warm event attaches a new screenshot cleanly.
      pending = { data: TINY_PNG_B64, preview: TINY_PNG_URL };
      await emit("chat-snip-attached", {});
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>(".chat-attached")?.hidden ===
          false,
      );

      // Switching to a text-only model disables the snip button with status hint on click.
      settings = {
        ...settings,
        service: "deepseek",
        model: "deepseek-chat",
        canSee: false,
      };
      snipStatus = { state: "no-vision-model", shortcut: "Control+Shift+A" };
      await emit("companion-settings", settings);
      await page.waitForFunction(
        () =>
          document
            .querySelector(".chat-tools [data-snip]")
            ?.getAttribute("aria-disabled") === "true",
      );
      const prevCount = calls.filter((c) => c.cmd === "start_chat_snip").length;
      await snipBtn.click({ force: true });
      assert.equal(
        calls.filter((c) => c.cmd === "start_chat_snip").length,
        prevCount,
      );
      assert.match(
        (await page.locator(".chat-status").textContent()) ?? "",
        /多模态模型/,
      );

      // Turning off settings.vision hides the button altogether.
      settings = { ...settings, vision: false };
      snipStatus = { state: "vision-off", shortcut: "Control+Shift+A" };
      await emit("companion-settings", settings);
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>(".chat-tools [data-snip]")
            ?.hidden === true,
      );
    },
  );
});

test("pet bubble shows snip button in chat mode only for multimodal models (Option A), preserves draft, and hides in translate mode", async () => {
  let settings: CompanionSettings = {
    ...defaults,
    enabled: true,
    vision: true,
    service: "openai",
    model: "gpt-5.4-mini",
  };
  let snipStatus = { state: "ready", shortcut: "" };
  await withDesktopPage(
    "?bubble",
    (cmd) => {
      if (cmd === "companion_settings") return settings;
      if (cmd === "chat_snip_status") return snipStatus;
      if (cmd === "bubble_intent") return { mode: "input", at: Date.now() };
      if (cmd === "pending_reminders") return [];
      if (cmd === "clip_session") return null;
      if (cmd === "bubble_history_page")
        return { turns: [], hasMore: false, nextBefore: null };
      if (cmd === "start_chat_snip") return null;
      return null;
    },
    async ({ page, emit, calls }) => {
      const snipBtn = page.locator(".bubble-compose [data-snip]");
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>(".bubble-compose [data-snip]")
            ?.hidden === false,
      );
      // Typing draft text keeps the snip button visible and passes draftText to Rust.
      await page.locator(".bubble-compose textarea").fill("帮我解释下这个按钮");
      assert.equal(await snipBtn.isVisible(), true);
      await snipBtn.click();
      const call = calls.find((c) => c.cmd === "start_chat_snip");
      assert.equal(call?.payload.draftText, "帮我解释下这个按钮");

      // Switching to text-only model hides the bubble snip button (Option A).
      settings = {
        ...settings,
        service: "deepseek",
        model: "deepseek-chat",
        canSee: false,
      };
      snipStatus = { state: "no-vision-model", shortcut: "" };
      await emit("companion-settings", settings);
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>(".bubble-compose [data-snip]")
            ?.hidden === true,
      );

      // Re-enable multimodal, then open translate mode: snip stays hidden, paste takes over.
      settings = { ...settings, service: "openai", model: "gpt-5.4-mini" };
      snipStatus = { state: "ready", shortcut: "" };
      await emit("companion-settings", settings);
      await emit("bubble-open", {
        mode: "translate-input",
        at: Date.now(),
      });
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>(".bubble-compose [data-snip]")
            ?.hidden === true,
      );
    },
  );
});

test("snip overlay in chat mode supports crosshair guides, Space-drag reposition, bottom-edge badge flip, and right-click cancel", async () => {
  await withDesktopPage(
    "?snip=9&mode=chat",
    () => null,
    async ({ page, calls }) => {
      await page.waitForSelector(".snip-surface");
      assert.match(
        (await page.locator(".snip-surface > span").textContent()) ?? "",
        /提问的区域/,
      );

      // Pointer movement activates aiming guides.
      await page.mouse.move(120, 140);
      assert.equal(
        await page.locator(".snip-surface").getAttribute("data-aiming"),
        "true",
      );

      // Drag to draw a 200x100 box, then hold Space and move +100,+500 to test reposition & bottom badge flip.
      await page.mouse.move(100, 100);
      await page.mouse.down();
      await page.mouse.move(300, 200);
      assert.equal(
        await page.locator(".snip-surface").getAttribute("data-selecting"),
        "true",
      );
      assert.equal(
        await page.locator(".snip-size").textContent(),
        "200 × 100",
      );

      await page.keyboard.down("Space");
      await page.mouse.move(400, 680);
      await page.keyboard.up("Space");
      // Box stays 200x100 and flips badge inside near the bottom edge (viewport height 700).
      assert.equal(
        await page.locator(".snip-size").textContent(),
        "200 × 100",
      );
      assert.equal(
        await page.locator(".snip-size").getAttribute("data-inside"),
        "true",
      );
      await page.mouse.up();

      const waitCall = async (cmd: string) => {
        const deadline = Date.now() + 3000;
        while (Date.now() < deadline) {
          const hit = calls.find((c) => c.cmd === cmd);
          if (hit) return hit;
          await new Promise((r) => setTimeout(r, 20));
        }
        return undefined;
      };

      const finished = await waitCall("finish_snip");
      assert.ok(finished, "finish_snip should be invoked on release");
      assert.equal(finished.payload.generation, 9);
      assert.ok(
        Math.abs(finished.payload.region.right - finished.payload.region.left - 0.2) < 0.01,
        "Space-drag must preserve box width",
      );

      // Right-click cancels cleanly.
      await page.mouse.click(250, 250, { button: "right" });
      const cancelled = await waitCall("cancel_snip");
      assert.ok(
        cancelled && cancelled.payload.generation === 9,
        "right-click should call cancel_snip",
      );
    },
  );
});
