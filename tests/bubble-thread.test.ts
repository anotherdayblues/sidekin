import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

// The bubble reads like a short chat: the last two finished turns of this
// topic, then what you just said, then the pet's reply.
test("气泡像小聊天窗：显示最近两轮、你刚说的话，追问时上一轮并入记录", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = process.env.BUBBLE_TEST_WEBKIT
    ? await webkit.launch()
    : await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    let answer = "";
    let releaseOlder!: () => void;
    const calls: string[] = [];
    const event = await bubbleBridge(page, async (cmd, args) => {
      calls.push(cmd);
      if (cmd === "get_state")
        return { settings: { theme: "day", skin: "studio" } };
      if (cmd === "companion_settings") return { enabled: true };
      if (cmd === "pending_reminders") return [];
      if (cmd === "bubble_history_page" && args.before) {
        assert.equal(args.before, 2);
        await new Promise<void>((resolve) => {
          releaseOlder = resolve;
        });
        return {
          topic: 1,
          before: null,
          turns: [{ question: "第一问", answer: "第一答".repeat(160) }],
        };
      }
      if (cmd === "bubble_history_page")
        return {
          topic: 1,
          before: 2,
          turns: [
            { question: "第二问", answer: "第二答", at: 2 },
            { question: "第三问", answer: "第三答", at: 3 },
          ],
        };
      if (cmd === "send_chat") return { text: answer };
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?bubble");
    // The bubble asks for a pending intent once its listeners are in place.
    while (!calls.includes("pending_reminders"))
      await new Promise((r) => setTimeout(r, 50));
    await event("bubble-open", { mode: "input", at: 1 });
    const thread = () =>
      page
        .locator(".bubble-thread .bubble-msg")
        .evaluateAll((els) =>
          els.map((e) => `${(e as HTMLElement).dataset.who}:${e.textContent}`),
        );
    await page.waitForFunction(
      () => document.querySelectorAll(".bubble-thread .bubble-msg").length > 0,
    );
    assert.deepEqual(await thread(), [
      "mine:第二问",
      "theirs:第二答",
      "mine:第三问",
      "theirs:第三答",
    ]);

    assert.equal(calls.filter((c) => c === "bubble_history_page").length, 1);
    const viewport = page.locator(".bubble-messages");
    await viewport.hover();
    await page.mouse.wheel(0, -1000);
    await viewport.evaluate((el) => {
      el.scrollTop = 0;
    });
    await page.waitForFunction(() => document.querySelector(".bubble-thread button") !== null);
    for (let i = 0; !releaseOlder && i < 100; i++) await page.waitForTimeout(10);
    assert.ok(releaseOlder, "scrolling up should request an older page");
    const oldAnchor = page.locator(".bubble-msg").filter({ hasText: "第二问" });
    const offset = () =>
      oldAnchor.evaluate(
        (el) =>
          el.getBoundingClientRect().top -
          el.closest(".bubble-messages")!.getBoundingClientRect().top,
      );
    const beforeInsert = await offset();
    releaseOlder();
    await page.waitForFunction(
      () => document.querySelector(".bubble-msg")?.textContent === "第一问",
    );
    assert.ok(
      Math.abs((await offset()) - beforeInsert) <= 2,
      "reading position moved",
    );
    assert.equal(calls.filter((c) => c === "bubble_history_page").length, 2);
    answer = "带伞吧";
    await page.locator("textarea").fill("明天要带伞吗？");
    await page.locator("[data-send]").click();
    await page.waitForFunction(
      () =>
        document.querySelector(".bubble-card")?.getAttribute("data-state") ===
        "answer",
    );
    assert.equal(
      await page.locator(".bubble-mine").textContent(),
      "明天要带伞吗？",
    );
    assert.ok(await page.locator(".bubble-mine").isVisible());

    answer = "三点到六点";
    await page.locator("textarea").fill("几点下？");
    await page.locator("[data-send]").click();
    await page.waitForFunction(
      () =>
        document.querySelector(".bubble-card")?.getAttribute("data-state") ===
        "answer",
    );
    assert.deepEqual(await thread(), [
      "mine:第一问",
      "theirs:" + "第一答".repeat(160),
      "mine:第二问",
      "theirs:第二答",
      "mine:第三问",
      "theirs:第三答",
      "mine:明天要带伞吗？",
      "theirs:带伞吧",
    ]);
    assert.equal(await page.locator(".bubble-mine").textContent(), "几点下？");
    assert.equal(
      (await page.locator(".bubble-text").textContent())?.trim(),
      "三点到六点",
    );
    const scroll = page.locator(".bubble-messages");
    await page
      .locator(".bubble-msg")
      .first()
      .evaluate((el) => {
        el.textContent = "长消息的一行。\n".repeat(80) + "最后一句";
      });
    assert.ok(await scroll.evaluate((el) => el.scrollHeight > el.clientHeight));
    await scroll.evaluate((el) => {
      el.scrollTop = 0;
    });
    await scroll.hover();
    await page.mouse.wheel(0, 5000);
    await page.waitForFunction(
      () => document.querySelector(".bubble-messages")!.scrollTop > 0,
    );
    assert.ok(
      await page
        .locator(".bubble-msg")
        .first()
        .evaluate((el) => el.clientHeight >= el.scrollHeight - 1),
    );
  } finally {
    await browser.close();
    await server.close();
  }
});
