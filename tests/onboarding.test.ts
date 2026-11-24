// 上手引导 (plan/17): the pet's tips in the bubble, checked through the real
// page with the host faked, and the lists the host, the studio, the demos
// and the language tables must agree on.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

const read = (path: string) => readFileSync(path, "utf8");
/** The quoted items of the array assigned to `name`. */
const list = (source: string, name: string) => {
  const from = source.indexOf("= [", source.indexOf(name));
  return [
    ...source.slice(from, source.indexOf("]", from)).matchAll(/"([\w-]+)"/g),
  ].map((m) => m[1]);
};

test("功能清单：宿主、界面、演示和两张语言表一致", () => {
  const host = list(
    read("apps/desktop/src-tauri/src/tips.rs"),
    "pub const FEATURES",
  );
  const tips = read("apps/desktop/src/tips.ts");
  assert.deepEqual(list(tips, "export const FEATURES"), host);
  const withDemo = list(tips, "export const DEMO_FEATURES");
  const demos = readdirSync("apps/desktop/src/demos")
    .map(
      (f) =>
        read(`apps/desktop/src/demos/${f}`).match(/^\s+id: "([\w-]+)",$/m)?.[1],
    )
    .filter(Boolean);
  assert.deepEqual([...demos].sort(), [...withDemo].sort());
  for (const id of withDemo) assert.ok(host.includes(id), id);
  // Every feature is in exactly one group of the skill book (plan/32).
  const grouped = [
    ...tips
      .slice(tips.indexOf("export const GROUPS"))
      .split("];\n")[0]
      .matchAll(/"([\w-]+)"/g),
  ]
    .map((m) => m[1])
    .filter((id) => host.includes(id));
  assert.deepEqual([...grouped].sort(), [...host].sort());
  for (const lang of ["zh", "en"]) {
    const table = JSON.parse(read(`apps/shared/locales/${lang}.json`));
    for (const id of [...host, "hello", "double-click"])
      assert.ok(table[`tip.${id}`], `${lang} tip.${id}`);
    for (const id of host)
      for (const part of ["name", "how"])
        assert.ok(
          table[`skills.${id}.${part}`],
          `${lang} skills.${id}.${part}`,
        );
  }
});

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

async function bubble() {
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  // A short reading time, so a tip leaving on its own can be watched.
  await page.addInitScript({
    content: `new MutationObserver((_, watch) => {
      if (!document.head) return;
      watch.disconnect();
      const style = document.createElement("style");
      style.textContent = ":root{--brain-read-ms:300 !important}";
      document.head.append(style);
    }).observe(document, { childList: true, subtree: true });`,
  });
  const calls: [string, any][] = [];
  const event = await bubbleBridge(page, async (cmd, p) => {
    calls.push([cmd, p]);
    if (cmd === "get_state")
      return { settings: { theme: "day", skin: "studio" } };
    if (cmd === "companion_settings")
      return {
        enabled: true,
        chatShortcut: "Alt+Space",
        visionShortcut: "Shift+Super+2",
        panelShortcut: "Alt+Shift+Space",
      };
    if (cmd === "pending_reminders") return [];
    return null;
  });
  await page.goto(server.resolvedUrls!.local[0] + "?bubble");
  await page.waitForFunction(() => Boolean((window as any).qaEvent));
  while (!calls.some(([c]) => c === "pending_reminders"))
    await new Promise((r) => setTimeout(r, 20));
  const called = (cmd: string) => calls.filter(([c]) => c === cmd);
  const waitCall = async (cmd: string) => {
    const deadline = Date.now() + 5000;
    while (!called(cmd).length) {
      assert.ok(Date.now() < deadline, `${cmd} was not called`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { page, event, called, waitCall };
}

test("提示：只为提示打开时占整个气泡，“看看怎么用”打开主窗口并收起", async () => {
  const b = await bubble();
  await b.event("bubble-open", { mode: "tip", tip: "copy-translate", at: 1 });
  await b.page.waitForSelector(
    ".bubble-card[data-state='tip'] [data-tip]:not([hidden])",
  );
  assert.match(
    (await b.page.locator("[data-tip-text]").textContent())!,
    /连按两次/,
  );
  assert.ok(await b.page.locator("[data-tip-show]").isVisible());
  assert.ok(!(await b.page.locator("[data-tip-setup]").isVisible()));
  await b.page.locator("[data-tip-show]").click();
  await b.waitCall("open_studio");
  await b.waitCall("hide_bubble");
  await b.page.close();
});

test("提示：常规提示没人理就在读完后自己收起；双击提示请用户去接模型", async () => {
  const b = await bubble();
  await b.event("bubble-open", { mode: "tip", tip: "double-click", at: 1 });
  await b.page.waitForSelector("[data-tip]:not([hidden])");
  assert.ok(await b.page.locator("[data-tip-setup]").isVisible());
  assert.ok(!(await b.page.locator("[data-tip-show]").isVisible()));
  await b.page.mouse.move(0, 0);
  await b.waitCall("hide_bubble");
  await b.page.close();
});

test("初见自我介绍气泡：常驻不自动消失、隐藏不用教我了，点「开始设置我」打开主窗口进入三步引导", async () => {
  const b = await bubble();
  await b.event("bubble-open", { mode: "tip", tip: "hello", at: 1 });
  await b.page.waitForSelector("[data-tip][data-tip-id='hello']:not([hidden])");
  assert.equal(await b.page.locator("[data-tip-setup]").textContent(), "开始设置我");
  assert.equal(await b.page.locator("[data-tip-ok]").textContent(), "先自己逛逛");
  assert.ok(await b.page.locator("[data-tip-off]").isHidden());
  // Even past the short 300ms reading window, welcome bubble stays visible.
  await b.page.mouse.move(0, 0);
  await new Promise((r) => setTimeout(r, 600));
  assert.equal(b.called("hide_bubble").length, 0);
  await b.page.locator("[data-tip-setup]").click();
  await b.waitCall("open_studio");
  await b.waitCall("hide_bubble");
  await b.page.close();
});

test("提示：跟在回答下面时不改气泡状态；“不用教我了”关掉提示，气泡留着", async () => {
  const b = await bubble();
  await b.event("bubble-open", { mode: "input", at: 1 });
  await b.event("bubble-tip", "chat-shortcut");
  await b.page.waitForSelector("[data-tip]:not([hidden])");
  assert.match(
    (await b.page.locator("[data-tip-text]").textContent())!,
    /Alt\+空格|⌥空格/,
  );
  assert.equal(
    await b.page.locator(".bubble-card").getAttribute("data-state"),
    "input",
  );
  await b.page.locator("[data-tip-off]").click();
  await b.waitCall("tips_off");
  assert.deepEqual(b.called("tips_off")[0][1], { off: true });
  assert.ok(await b.page.locator("[data-tip]").isHidden());
  assert.equal(b.called("hide_bubble").length, 0);
  await b.page.close();
});

test("打招呼：宠物先开口，输入框等用户回话", async () => {
  const b = await bubble();
  await b.event("bubble-open", {
    mode: "greeting",
    text: "嗨，我是栗子！",
    at: 1,
  });
  await b.page.waitForSelector(".bubble-card[data-state='answer']");
  assert.equal(
    (await b.page.locator(".bubble-text").textContent())?.trim(),
    "嗨，我是栗子！",
  );
  assert.ok(await b.page.locator("textarea").isVisible());
  assert.ok(
    await b.page.evaluate(() => document.activeElement?.tagName === "TEXTAREA"),
  );
  await b.page.close();
});

test("它会的事：左栏底部的 ? 打开，看过一张就算学会；全部学会后小点消失、? 还在，设置里也能打开", async () => {
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() => Boolean((window as any).__skillBook));
  // The ? at the foot of the left column (plan/33), with a dot while a
  // card is unread.
  const entry = page.locator("#skills-key");
  await page.waitForFunction(() =>
    document.querySelector("#skills-key")?.hasAttribute("data-new"),
  );
  assert.ok(await entry.isVisible());
  await entry.click();
  // Grouped under tabs (plan/32): every card of every tab, one by one.
  const tabs = await page
    .locator(".skill-tabs [data-group]")
    .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.group!));
  assert.equal(tabs.length, 5);
  let read = 0;
  for (const tab of tabs) {
    await page.locator(`.skill-tabs [data-group="${tab}"]`).click();
    const ids = await page
      .locator("[data-skill]")
      .evaluateAll((els) => els.map((e) => (e as HTMLElement).dataset.skill!));
    for (const id of ids) {
      await page.locator(`[data-skill="${id}"]`).click();
      await page.locator(".skill-book [data-back]").click();
      read += 1;
      await page.waitForFunction(
        (n) =>
          document
            .querySelector(".skill-book header small")
            ?.textContent?.startsWith(`已学会 ${n} `),
        read,
      );
      // Back on the same tab.
      assert.equal(
        await page
          .locator('.skill-tabs [aria-selected="true"]')
          .getAttribute("data-group"),
        tab,
      );
    }
    assert.equal(
      await page.locator(`.skill-tabs [data-group="${tab}"][data-new]`).count(),
      0,
    );
  }
  assert.equal(read, 17);
  await page.locator(".skill-book [data-close]").click();
  // Everything read: the dot goes, the ? stays.
  await page.waitForFunction(
    () => !document.querySelector("#skills-key")!.hasAttribute("data-new"),
  );
  assert.ok(await entry.isVisible());
  // 设置 · 上手引导 still opens it.
  await page.evaluate(() => (window as any).__studio.block("settings"));
  await page.locator("[data-guide-skills]").click();
  assert.ok(await page.locator(".skill-book[open]").isVisible());
  await page.close();
});

test("三步引导第 3 步：展示探索全部功能收尾卡并高亮左下角 ?，点按钮打开它会的事", async () => {
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() => Boolean((window as any).__skillBook));
  await page.evaluate(() => (window as any).__studio.block("settings"));
  // Open three-step guide from settings entry and step to step 3.
  await page.locator("[data-guide-steps]").click();
  await page.locator('.onboard [data-onboard="next"]').click();
  assert.equal(
    await page.locator("#skills-key").getAttribute("data-guide-highlight"),
    null,
  );
  await page.locator('.onboard [data-onboard="next"]').click();
  // Step 3 shows explore card pointing to ? and highlights #skills-key.
  const explore = page.locator(".onboard [data-onboard-explore]");
  assert.ok(await explore.isVisible());
  assert.match((await explore.textContent())!, /\?/);
  assert.ok(
    await page.evaluate(() =>
      document.querySelector("#skills-key")!.hasAttribute("data-guide-highlight"),
    ),
  );
  // Clicking the explore CTA opens the skill book dialog.
  await explore.locator("[data-skill-book]").click();
  assert.ok(await page.locator(".skill-book[open]").isVisible());
  await page.locator(".skill-book [data-close]").click();
  // Leaving step 3 clears the highlight on #skills-key.
  await page.locator('.onboard [data-onboard="prev"]').click();
  assert.equal(
    await page.locator("#skills-key").getAttribute("data-guide-highlight"),
    null,
  );
  await page.close();
});
