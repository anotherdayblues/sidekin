// What the bubble does in each situation, checked through the real page
// with the host faked. These pin the behavior before bubble.ts is split, so
// every step of the split must keep them passing.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

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

const notice = {
  id: 7,
  revision: 1,
  reminder: 3,
  pet: "fixture",
  message: "该喝水了",
  due: 1,
  missed: false,
};

type Call = [string, any];
async function bubble(answers: Record<string, (p: any) => unknown> = {}) {
  const page: Page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  // A short reading time, so closing on its own can be watched.
  // As text: the test runner would wrap a function in helpers the page lacks.
  await page.addInitScript({
    content: `new MutationObserver((_, watch) => {
      if (!document.head) return;
      watch.disconnect();
      const style = document.createElement("style");
      style.textContent = ":root{--brain-read-ms:300 !important}";
      document.head.append(style);
    }).observe(document, { childList: true, subtree: true });`,
  });
  const calls: Call[] = [];
  let pending: { ok: (v: unknown) => void; fail: (e: unknown) => void }[] = [];
  const event = await bubbleBridge(page, async (cmd, p) => {
    calls.push([cmd, p]);
    if (answers[cmd]) return answers[cmd](p);
    if (cmd === "get_state")
      return { settings: { theme: "day", skin: "studio" } };
    if (cmd === "companion_settings") return { enabled: true };
    if (cmd === "pending_reminders") return [];
    if (["send_chat", "translate_selection", "ask_vision"].includes(cmd))
      return new Promise((ok, fail) => pending.push({ ok, fail }));
    return null;
  });
  await page.goto(server.resolvedUrls!.local[0] + "?bubble");
  await page.waitForFunction(() => Boolean((window as any).qaEvent));
  while (!calls.some(([c]) => c === "pending_reminders"))
    await new Promise((r) => setTimeout(r, 20));
  const lastToken = () =>
    [...calls]
      .reverse()
      .find(([c]) => /send_chat|translate_selection/.test(c))?.[1]
      .token as string;
  return {
    page,
    calls,
    event,
    called: (cmd: string) => calls.filter(([c]) => c === cmd),
    /** Settles the oldest request still waiting. */
    settle: (value: unknown, failed = false) => {
      const next = pending.shift()!;
      if (failed) next.fail(value);
      else next.ok(value);
    },
    lastToken,
    cardState: (s: string) =>
      page.waitForFunction(
        (s) =>
          document.querySelector(".bubble-card")?.getAttribute("data-state") ===
          s,
        s,
      ),
    text: () => page.locator(".bubble-text").textContent(),
    waitCall: async (cmd: string, count = 1) => {
      const deadline = Date.now() + 5000;
      while (calls.filter(([c]) => c === cmd).length < count) {
        assert.ok(Date.now() < deadline, `${cmd} was not called`);
        await new Promise((r) => setTimeout(r, 20));
      }
    },
    say: async (text: string) => {
      await page.locator("textarea").fill(text);
      await page.locator("[data-send]").click();
    },
  };
}

test("提醒：知道了、稍后提醒各自上报；没钉住就收起，钉住就回到输入框", async () => {
  const resolved: any[] = [];
  const b = await bubble({
    pending_reminders: () => [notice],
    resolve_reminders: (p) => {
      resolved.push(p);
      return [];
    },
  });
  await b.event("bubble-open", { mode: "reminder", at: 2 });
  await b.cardState("reminder");
  assert.equal(
    await b.page.locator("[data-notice] strong").textContent(),
    "提醒",
  );
  assert.equal(await b.page.locator(".notice-text").textContent(), "该喝水了");
  await b.page.locator("[data-ack]").click();
  await b.waitCall("hide_bubble");
  assert.deepEqual(resolved[0], {
    items: [{ id: 7, revision: 1 }],
    snooze: false,
  });

  await b.event("bubble-open", { mode: "reminder", at: 3 });
  await b.cardState("reminder");
  await b.page.locator("[data-pin]").click();
  await b.page.locator("[data-later]").click();
  await b.cardState("input");
  assert.equal(resolved[1].snooze, true);
  assert.equal(b.called("hide_bubble").length, 1, "pinned: stays open");
  await b.page.close();
});

test("提醒：错过的、多条的标题不同；上报失败时说明原因", async () => {
  const b = await bubble({
    pending_reminders: () => [notice],
    resolve_reminders: () => {
      throw "提醒已经变了";
    },
  });
  await b.event("reminders-due", [
    { ...notice, missed: true },
    { ...notice, id: 8 },
  ]);
  assert.equal(
    await b.page.locator("[data-notice] strong").textContent(),
    "错过的提醒",
  );
  await b.event("reminders-due", [notice, { ...notice, id: 8 }]);
  assert.equal(
    await b.page.locator("[data-notice] strong").textContent(),
    "到点的提醒",
  );
  await b.page.locator("[data-ack]").click();
  await b.page.waitForFunction(() =>
    document
      .querySelector("[data-notice] small")
      ?.textContent?.includes("提醒已经变了"),
  );
  await b.page.close();
});

test("授权：说明哪个工具要做什么，按钮把选择交给宿主；网页读取多一个“总是同意”", async () => {
  const b = await bubble();
  const request = {
    id: "r1",
    token: "t",
    service: "名牌服务",
    tool: "读取名牌",
    args: '{"宠物":"栗子"}',
  };
  await b.event("bubble-open", { mode: "authorization", request, at: 2 });
  await b.cardState("authorization");
  assert.equal(
    await b.page.locator("[data-note] b").textContent(),
    "名牌服务 · 读取名牌",
  );
  assert.match(
    (await b.page.locator(".bubble-countdown").textContent())!,
    /120 秒后自动拒绝/,
  );
  assert.deepEqual(
    await b.page.locator("[data-choices] button").allTextContents(),
    ["同意", "拒绝"],
  );
  await b.page.locator("[data-choices] button", { hasText: "拒绝" }).click();
  await b.waitCall("approve_tool");
  assert.deepEqual(b.called("approve_tool")[0][1], {
    id: "r1",
    choice: "deny",
  });
  // Until the host closes the request, nothing else takes over the card.
  await b.event("brain-event", {
    method: "approval.closed",
    params: { id: "r1" },
  });
  await b.cardState("tool");

  await b.event("bubble-open", {
    mode: "authorization",
    request: { ...request, id: "r2", service: "网页读取" },
    at: 3,
  });
  await b.cardState("authorization");
  assert.deepEqual(
    await b.page.locator("[data-choices] button").allTextContents(),
    ["同意", "拒绝", "总是同意"],
  );
  await b.page.keyboard.press("ArrowLeft");
  await b.page.keyboard.press("Enter");
  await b.waitCall("approve_tool", 2);
  assert.deepEqual(b.called("approve_tool")[1][1], {
    id: "r2",
    choice: "always",
  });
  await b.page.close();
});

test("停止：取消这一条，已停止时没出字就说“已停止”", async () => {
  const b = await bubble();
  await b.event("bubble-open", { mode: "input", at: 1 });
  await b.say("讲个故事");
  await b.cardState("thinking");
  assert.ok(await b.page.locator("[data-stop]").isVisible());
  await b.page.locator("[data-stop]").click();
  await b.waitCall("cancel_chat");
  assert.equal(b.called("cancel_chat")[0][1].token, b.lastToken());
  b.settle("stopped", true);
  await b.cardState("answer");
  assert.equal((await b.text())?.trim(), "已停止");
  await b.page.close();
});

test("出错：网络错误点“再试一次”重发同一句；Key 错误点“去设置”", async () => {
  const b = await bubble();
  await b.event("bubble-open", { mode: "input", at: 1 });
  await b.say("今天天气");
  await b.cardState("thinking");
  b.settle("network", true);
  await b.cardState("error");
  assert.equal(await b.page.locator("[data-action]").textContent(), "再试一次");
  await b.page.locator("[data-action]").click();
  await b.waitCall("send_chat", 2);
  assert.equal(b.called("send_chat")[1][1].text, "今天天气");
  b.settle("auth", true);
  await b.cardState("error");
  assert.equal(await b.page.locator("[data-action]").textContent(), "去设置");
  await b.page.locator("[data-action]").click();
  await b.waitCall("open_companion_page");
  // The host can also report an error by opening the bubble with it.
  await b.event("bubble-open", { mode: "error", reason: "permission", at: 5 });
  await b.cardState("error");
  assert.equal(await b.page.locator("[data-action]").textContent(), "去系统设置");
  await b.page.locator("[data-action]").click();
  await b.waitCall("open_permission_settings");
  assert.equal(b.called("open_permission_settings")[0][1].kind, "accessibility");
  await b.event("bubble-open", { mode: "error", reason: "permissionOff", at: 6 });
  await b.cardState("error");
  assert.equal(await b.page.locator("[data-action]").textContent(), "去权限设置");
  await b.page.locator("[data-action]").click();
  await b.waitCall("open_companion_page", 2);
  assert.equal(b.called("open_companion_page")[1][1].section, "access");
  await b.page.close();
});

test("回答说完会自己收起；鼠标停在上面或钉住时不收", async () => {
  const b = await bubble();
  await b.event("bubble-open", { mode: "input", at: 1 });
  await b.say("你好");
  b.settle({ text: "你好呀" });
  await b.cardState("answer");
  await b.page.locator("textarea").blur();
  await b.waitCall("hide_bubble");

  await b.event("bubble-open", { mode: "input", at: 2 });
  await b.say("再说一句");
  await b.page.locator(".bubble-card").hover();
  b.settle({ text: "好" });
  await b.cardState("answer");
  await b.page.waitForTimeout(700);
  assert.equal(b.called("hide_bubble").length, 1, "hovered: stays");
  await b.page.mouse.move(0, 0);
  await b.waitCall("hide_bubble", 2);

  await b.event("bubble-open", { mode: "input", at: 3 });
  await b.page.locator("[data-pin]").click();
  await b.say("第三句");
  b.settle({ text: "嗯" });
  await b.cardState("answer");
  await b.page.locator("textarea").blur();
  await b.page.waitForTimeout(700);
  assert.equal(b.called("hide_bubble").length, 2, "pinned: stays");
  await b.page.close();
});

test("流式：来字、改写、用工具、连不上、备用模型、用量上限；别的请求的事件不理", async () => {
  const b = await bubble();
  await b.event("bubble-open", { mode: "input", at: 1 });
  await b.say("查一下");
  await b.cardState("thinking");
  const token = b.lastToken();
  const brain = (method: string, params: object) =>
    b.event("brain-event", { method, params: { token, ...params } });
  await b.event("brain-event", {
    method: "chat.delta",
    params: { token: "other", delta: "不该出现" },
  });
  await brain("chat.delta", { delta: "先看看" });
  await b.cardState("streaming");
  await b.page.waitForFunction(() =>
    document.querySelector(".bubble-text")?.textContent?.includes("先看看"),
  );
  await brain("chat.rewind", { text: "改过的" });
  assert.equal((await b.text())?.includes("改过的"), true);
  assert.equal((await b.text())?.includes("不该出现"), false);
  await brain("chat.toolStart", { name: "web_read" });
  await b.cardState("tool");
  assert.equal(
    await b.page.locator("[data-note]").textContent(),
    "正在看网页…",
  );
  await brain("chat.toolsUnavailable", { services: ["天气", "地图"] });
  assert.equal(
    await b.page.locator("[data-note]").textContent(),
    "暂时连不上：天气、地图",
  );
  await brain("model.fallback", { model: "本地模型" });
  assert.equal(await b.page.locator("[data-backup]").textContent(), "备用");
  assert.equal(
    await b.page.locator("[data-backup]").getAttribute("title"),
    "本地模型",
  );
  await brain("usage.limit", {});
  assert.equal(
    await b.page.locator("[data-budget]").textContent(),
    "今天已达上限，后台任务已暂停。",
  );
  b.settle({ text: "改过的。查到了" });
  await b.cardState("answer");
  await b.page.waitForFunction(() =>
    document.querySelector(".bubble-text")?.textContent?.includes("查到了"),
  );
  await b.page.close();
});

test("选字：读取中不显示停止；空选提示；复制交出译文；关掉翻译就收起", async () => {
  const b = await bubble({ translate_selection: () => ({ text: "请坐。" }) });
  await b.event("bubble-open", { mode: "selecting", at: 10 });
  await b.cardState("thinking");
  assert.equal(await b.page.locator("[data-stop]").isVisible(), false);
  await b.waitCall("companion_timing");
  assert.equal(b.called("companion_timing")[0][1].kind, "translate-visible");

  await b.event("bubble-open", {
    mode: "translate",
    source: "Take a seat.",
    generation: 1,
    at: 11,
  });
  await b.cardState("answer");
  assert.equal(
    await b.page.locator(".bubble-source div").textContent(),
    "Take a seat.",
  );
  await b.page.locator("[data-copy]").click();
  await b.waitCall("copy_translation");
  assert.equal(b.called("copy_translation")[0][1].text, "请坐。");
  await b.page.waitForFunction(
    () => document.querySelector("[data-copy]")?.textContent === "已复制",
  );
  await b.page.locator("[data-expand]").click();
  await b.waitCall("open_translations");

  await b.event("bubble-open", { mode: "empty-selection", at: 12 });
  await b.cardState("answer");
  assert.equal((await b.text())?.trim(), "先选中一段文字哦");
  assert.equal(await b.page.locator("[data-copy]").isVisible(), false);

  await b.event("bubble-open", {
    mode: "translate",
    source: "Hello.",
    generation: 2,
    at: 13,
  });
  await b.cardState("answer");
  await b.event("companion-settings", {
    enabled: true,
    translation: false,
    reminders: true,
  });
  await b.waitCall("hide_bubble");
  await b.page.close();
});

test("聊天里点展开打开聊天窗口；打开对话面板时气泡让位", async () => {
  const b = await bubble();
  await b.event("bubble-open", { mode: "input", at: 1 });
  await b.page.locator("[data-expand]").click();
  await b.waitCall("open_chat_window");
  await b.event("bubble-panel-open", null);
  await b.page.waitForFunction(
    () =>
      (document.querySelector(".bubble-shell")!.parentElement as HTMLElement)
        .hidden,
  );
  await b.cardState("input");
  await b.page.close();
});

test("剪贴板复用气泡，鼠标和回车直接粘贴，输入法选字和聊天草稿完整保留", async () => {
  const items = ["机场问卷", "机场网址"].map((preview, i) => ({
    id: i + 1,
    preview,
    source: "Fixture",
    at: Date.now(),
    pinned: false,
    link: false,
  }));
  const b = await bubble({
    clip_preferences: () => ({ enabled: true, excluded: "" }),
    clip_search: ({ query }) => items.filter((i) => i.preview.includes(query)),
    clip_paste: () => null,
  });
  await b.event("bubble-open", { mode: "input", at: 11 });
  const draft = b.page.locator(".bubble-compose textarea");
  await draft.fill("未发送的草稿");
  await b.event("clip-open", { id: 7 });
  const panel = b.page.locator(".clipboard-panel");
  const search = panel.locator("input");
  await panel.getByRole("option").first().waitFor();
  await search.dispatchEvent("compositionstart");
  await search.press("Enter");
  assert.equal(b.called("clip_paste").length, 0);
  await search.dispatchEvent("compositionend");
  await search.fill("网址");
  await panel.getByRole("option", { name: /机场网址/ }).waitFor();
  await search.press("Enter");
  await b.waitCall("clip_paste");
  assert.deepEqual(b.called("clip_paste")[0][1], { id: 2, session: 7 });
  await b.event("clip-closed", { id: 7 });
  assert.equal(await draft.inputValue(), "未发送的草稿");
  await b.event("clip-open", { id: 8 });
  await panel.getByRole("option", { name: /机场问卷/ }).click();
  await b.waitCall("clip_paste", 2);
  assert.deepEqual(b.called("clip_paste")[1][1], { id: 1, session: 8 });
  await b.page.close();
});

test("剪贴板在无焦点输入框触发 clip-insert 时自动降级调用 clip_copy", async () => {
  const b = await bubble({
    clip_preferences: () => ({ enabled: true, excluded: "" }),
    clip_search: () => [
      {
        id: 42,
        preview: "需要兜底复制的内容",
        source: "Notes",
        at: Date.now(),
        pinned: false,
        link: false,
      },
    ],
    clip_copy: () => true,
  });
  await b.event("clip-open", { id: 12 });
  await b.page.locator(".clipboard-panel [role=option]").first().waitFor();
  await b.event("clip-insert", {
    session: 12,
    id: 42,
    text: "需要兜底复制的内容",
  });
  await b.waitCall("clip_copy");
  assert.deepEqual(b.called("clip_copy")[0][1], { session: 12, id: 42 });
  await b.page.close();
});

for (const [platform, modifier, shortcut] of [
  ["mac", "Meta", "⌘+↵"],
  ["win", "Control", "Ctrl+↵"],
] as const) {
  test(`剪贴板仅复制 · ${platform} · 快捷键、底部提示和每一行菜单`, async () => {
    const items = [1, 2].map((id) => ({
      id,
      preview: "fixture " + id,
      source: "Test",
      at: Date.now(),
      pinned: false,
      link: false,
    }));
    const b = await bubble({
      clip_preferences: () => ({ enabled: true, excluded: "" }),
      clip_search: () => items,
      clip_copy: () => true,
    });
    await b.page.evaluate((os) => {
      document.documentElement.dataset.platform = os;
    }, platform);
    await b.event("clip-open", { id: 9 });
    const panel = b.page.locator(".clipboard-panel");
    const input = panel.locator("input");
    await panel.getByRole("option").first().waitFor();
    assert.equal(
      await panel.locator("footer [data-copy-only] kbd").textContent(),
      shortcut,
    );
    await input.press("ArrowDown");
    await input.dispatchEvent("compositionstart");
    await input.press(modifier + "+Enter");
    await input.dispatchEvent("compositionend");
    assert.equal(b.called("clip_copy").length, 0);
    await input.press(modifier + "+Enter");
    await b.waitCall("clip_copy");
    assert.deepEqual(b.called("clip_copy")[0][1], { id: 2, session: 9 });
    await b.event("clip-closed", { id: 9 });
    await b.event("clip-open", { id: 10 });
    const toggles = panel.locator(".clip-entry [data-more]");
    await toggles.nth(1).click();
    await toggles.nth(0).click();
    const option = panel.locator(".clip-actions [data-copy-only]");
    assert.equal(await option.locator("kbd").textContent(), shortcut);
    await option.click();
    await b.waitCall("clip_copy", 2);
    assert.deepEqual(b.called("clip_copy")[1][1], { id: 1, session: 10 });
    assert.equal(b.called("clip_paste").length, 0);
    await b.page.close();
  });
}

test("剪贴板记录设置：保持开关尺寸，不被搜索框样式拉长，支持独立开关图片与 OCR", async () => {
  let savedPatch: Record<string, unknown> | null = null;
  const b = await bubble({
    clip_preferences: () => ({
      enabled: true,
      excluded: "",
      retentionDays: 7,
      saveImages: true,
      ocrImages: true,
    }),
    clip_usage: () => ({
      count: 3,
      bytes: 1_500_000,
      limitCount: 100,
      limitBytes: 104_857_600,
    }),
    clip_configure: ({ prefs }) => {
      savedPatch = prefs;
      return {
        enabled: true,
        excluded: "",
        retentionDays: 7,
        saveImages: false,
        ocrImages: true,
        ...prefs,
      };
    },
    clip_search: () => [],
  });
  await b.page.setViewportSize({ width: 448, height: 340 });
  await b.event("clip-open", { id: 12 });
  const panel = b.page.locator(".clipboard-panel");
  await panel.locator("[data-settings]").click();
  const toggles = panel.locator(".clip-settings input.slide-switch");
  assert.equal(await toggles.count(), 3);
  for (let i = 0; i < 3; i++) {
    const box = await toggles.nth(i).boundingBox();
    assert.ok(box, `switch ${i} has layout box`);
    assert.ok(box.width >= 38 && box.width <= 52, `switch ${i} width ${box.width}`);
    assert.ok(
      box.height >= 18 && box.height <= 30,
      `switch ${i} height ${box.height}`,
    );
  }
  const saveImg = panel.locator("[data-save-images-toggle]");
  const ocrImg = panel.locator("[data-ocr-images-toggle]");
  await saveImg.click();
  assert.equal(await ocrImg.isDisabled(), true);
  await panel.getByRole("button", { name: "保存设置" }).click();
  assert.deepEqual(savedPatch, { saveImages: false });
  await b.page.close();
});

test("剪贴板图片条目：缩略图展示、类型筛选、查看大图与复制识别文字", async () => {
  const tinyThumb =
    "data:image/webp;base64,UklGRh4AAABXRUJQVlA4TBEAAAAvAAAAAAfQ//73v/+BiOh/AAA=";
  const tinyPng =
    "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
  const allItems = [
    {
      id: 1,
      kind: "text",
      preview: "会议纪要",
      source: "Notes",
      at: Date.now() - 2000,
      pinned: false,
      link: false,
    },
    {
      id: 2,
      kind: "image",
      preview: "订单号 20261121 支付成功",
      ocrPreview: "订单号 20261121 支付成功",
      source: "com.apple.screencapture",
      at: Date.now() - 1000,
      pinned: false,
      link: false,
      width: 1920,
      height: 1080,
      bytes: 245760,
      thumb: tinyThumb,
    },
  ];
  let copiedOcr = "";
  const b = await bubble({
    clip_preferences: () => ({
      enabled: true,
      excluded: "",
      retentionDays: 7,
      saveImages: true,
      ocrImages: true,
    }),
    clip_search: ({ kind }) =>
      kind ? allItems.filter((i) => i.kind === kind) : allItems,
    clip_detail: () => ({
      id: 2,
      kind: "image",
      imageDataUrl: tinyPng,
      width: 1920,
      height: 1080,
      bytes: 245760,
      ocr: "订单号 20261121 支付成功",
    }),
    clip_copy_text: ({ text }) => {
      copiedOcr = text;
    },
  });
  await b.page.setViewportSize({ width: 448, height: 340 });
  await b.event("clip-open", { id: 13 });
  const panel = b.page.locator(".clipboard-panel");
  await panel.locator(".clip-thumb img").waitFor();
  assert.equal(await panel.locator("[role=option]").count(), 2);

  // Switch filter to Images only
  await panel.locator('.clip-filters [data-kind="image"]').click();
  assert.equal(await panel.locator("[role=option]").count(), 1);
  assert.ok(
    (await panel.locator(".clip-row-image small").textContent())?.includes(
      "1920×1080",
    ),
  );

  // Open detail preview and copy OCR text
  await panel.locator("[data-more]").click();
  await panel.getByRole("button", { name: "查看大图" }).click();
  await panel.locator(".clip-detail-img").waitFor();
  await panel.getByRole("button", { name: "复制识别文字" }).click();
  assert.equal(copiedOcr, "订单号 20261121 支付成功");
  await panel.getByRole("button", { name: "返回" }).click();
  assert.equal(await panel.locator(".clip-detail img").count(), 0);
  await b.page.close();
});
