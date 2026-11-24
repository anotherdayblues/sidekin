import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";
import { readingMs, typingRate } from "../apps/desktop/src/bubbleTiming.ts";

// Opens the real bubble with fixture settings. send_chat stays pending until
// the test settles it, so a reply can stream, finish or fail on cue.
async function withBubble(
  run: (b: {
    page: Page;
    event: (name: string, payload: unknown) => Promise<unknown>;
    calls: string[];
    actions: string[];
    copied: string[];
    sent: string[];
    token: () => string;
    settle: (value: unknown, failed?: boolean) => void;
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
    const page = await browser.newPage();
    const calls: string[] = [];
    let token = "";
    const actions: string[] = [];
    const copied: string[] = [];
    const sent: string[] = [];
    let settle: (value: unknown, failed?: boolean) => void = () => {};
    const event = await bubbleBridge(page, async (cmd, p) => {
      calls.push(cmd);
      if (cmd === "get_state")
        return { settings: { theme: "day", skin: "studio" } };
      if (cmd === "companion_settings") return { enabled: true };
      if (cmd === "copy_translation") {
        copied.push(String(p.text ?? ""));
        return null;
      }
      if (cmd === "translate_selection") {
        actions.push(String(p.action ?? "translate"));
        return { text: `结果:${p.action ?? "translate"}` };
      }
      if (cmd === "send_chat") {
        token = p.token;
        sent.push(String(p.text ?? ""));
        return new Promise((ok, fail) => {
          settle = (value, failed) => (failed ? fail(value) : ok(value));
        });
      }
      if (cmd === "pending_reminders") return [];
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?bubble");
    await page.waitForFunction(() => Boolean((window as any).qaEvent));
    while (!calls.includes("pending_reminders"))
      await new Promise((r) => setTimeout(r, 20));
    await event("bubble-open", { mode: "input", at: 1 });
    await run({
      page,
      event,
      calls,
      actions,
      copied,
      sent,
      token: () => token,
      settle: (v, f) => settle(v, f),
    });
  } finally {
    await browser.close();
    await server.close();
  }
}

test("输入法候选还在时按 Esc 只取消输入，不关掉气泡", async () => {
  await withBubble(async ({ page, calls }) => {
    await page.locator("textarea").focus();
    await page.evaluate(() =>
      document.querySelector("textarea")!.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          isComposing: true,
          bubbles: true,
        }),
      ),
    );
    await page.waitForTimeout(400);
    assert.ok(!calls.includes("hide_bubble"), "composition Esc closed it");
    await page.keyboard.press("Escape");
    await page.waitForTimeout(400);
    assert.ok(calls.includes("hide_bubble"), "a plain Esc still closes it");
  });
});

test("回复说到一半断网，已经出来的字留着，错误接在后面", async () => {
  await withBubble(async ({ page, event, token, settle }) => {
    await page.locator("textarea").fill("讲个故事");
    await page.locator("[data-send]").click();
    await page.waitForFunction(
      () =>
        document.querySelector(".bubble-card")?.getAttribute("data-state") ===
        "thinking",
    );
    await event("brain-event", {
      method: "chat.delta",
      params: { token: token(), delta: "从前有座山" },
    });
    await page.waitForFunction(() =>
      document
        .querySelector(".bubble-text")
        ?.textContent?.includes("从前有座山"),
    );
    settle("network", true);
    await page.waitForFunction(
      () =>
        document.querySelector(".bubble-card")?.getAttribute("data-state") ===
        "error",
    );
    const shown = await page.locator(".bubble-text").textContent();
    assert.ok(shown?.includes("从前有座山"), "the partial reply was wiped");
    assert.ok(shown!.length > "从前有座山".length, "no error explanation");
  });
});

test("越长的回答留得越久，有上限", () => {
  const base = 8000;
  assert.equal(readingMs(base, "好的"), base);
  const long = readingMs(base, "字".repeat(200));
  assert.ok(long > base + 10000, "200 characters need more than 8 seconds");
  assert.ok(readingMs(base, "字".repeat(5000)) <= 60000, "capped");
});

test("模型说完后，剩下的字很快打完，不再一字一字慢慢放", () => {
  const cfg = { cps: 30, maxCps: 60, backlog: 24 };
  assert.equal(typingRate(cfg, 10, false), 30);
  assert.equal(typingRate(cfg, 100, false), 60);
  // 600 characters left after the reply is complete: about a second, not 10.
  assert.ok(typingRate(cfg, 600, true) >= 400);
  assert.equal(typingRate(cfg, 5, true), 30);
});

test("选字气泡可一键切换翻译、解释、润色、总结", async () => {
  await withBubble(async ({ page, event, actions }) => {
    await event("bubble-open", {
      mode: "translate",
      source: "Take a seat.",
      generation: 1,
      at: 2,
    });
    await page.waitForFunction(
      () =>
        !document
          .querySelector("[data-selection-tabs]")
          ?.hasAttribute("hidden"),
    );
    const copyShown = async () => {
      await page.waitForFunction(
        () =>
          document.querySelector(".bubble-card")?.getAttribute("data-state") ===
          "answer",
      );
      return page.locator("[data-copy]").isVisible();
    };
    assert.equal(await copyShown(), true, "translate");
    await page.locator('[data-selection-action="explain"]').click();
    assert.equal(await copyShown(), false, "explain");
    await page.locator('[data-selection-action="polish"]').click();
    assert.equal(await copyShown(), true, "polish");
    await page.locator('[data-selection-action="summarize"]').click();
    assert.equal(await copyShown(), false, "summarize");
    assert.deepEqual(actions, ["translate", "explain", "polish", "summarize"]);
  });
});

test("截图首问进入聊天，回答后可以直接追问", async () => {
  await withBubble(async ({page,event,sent,settle}) => {
    await event("bubble-open", { mode:"snip-ask", generation:3, at:5, question:"这是什么？" });
    await page.waitForFunction(() => document.querySelector(".bubble-card")?.getAttribute("data-state") === "thinking");
    assert.deepEqual(sent, ["这是什么？"]);
    settle({text:"这是权限提示。", topicId:42, turnId:7});
    await page.locator('textarea:visible').fill("下一步点哪里？");
    await page.locator("[data-send]").click();
    assert.deepEqual(sent, ["这是什么？","下一步点哪里？"]);
    settle({text:"点设置。", topicId:42, turnId:8});
  });
});

test("再点宠物时气泡快速淡出，淡出中再点可以收回操作", async () => {
  await withBubble(async ({ page, calls, event }) => {
    const shell = page.locator(".bubble-shell");
    await event("bubble-pet-click", null);
    assert.equal(await shell.getAttribute("data-closing"), "");
    await event("bubble-pet-click", null);
    await page.waitForTimeout(200);
    assert.equal(await shell.getAttribute("data-closing"), null);
    assert.ok(!calls.includes("hide_bubble"));
    await event("bubble-pet-click", null);
    await page.waitForTimeout(200);
    assert.equal(calls.filter((cmd) => cmd === "hide_bubble").length, 1);
    await event("bubble-open", { mode: "input", at: 2 });
    assert.equal(await shell.getAttribute("data-closing"), null);
  });
});
