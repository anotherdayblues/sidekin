// 番茄钟 in the bubble (plan/19): a finished tomato asks what comes next,
// and each answer goes to the host's timer. Checked through the real page
// with the host faked.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright";
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

const settings = {
  focusMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  longEvery: 4,
  chime: true,
  ambient: "off",
  volume: 40,
};
async function bubble(round: number) {
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const calls: [string, any][] = [];
  const event = await bubbleBridge(page, async (cmd, p) => {
    calls.push([cmd, p]);
    if (cmd === "get_state")
      return { settings: { theme: "day", skin: "studio" } };
    if (cmd === "companion_settings") return { enabled: true };
    if (cmd === "pending_reminders") return [];
    if (cmd === "focus_state")
      return {
        phase: "done",
        round,
        settings,
        today: round,
        streak: 1,
        week: [],
        endsAt: 0,
        length: 0,
        pausedLeft: null,
        longBreak: false,
        now: 0,
      };
    return null;
  });
  await page.goto(server.resolvedUrls!.local[0] + "?bubble");
  await page.waitForFunction(() => Boolean((window as any).qaEvent));
  while (!calls.some(([c]) => c === "pending_reminders"))
    await new Promise((r) => setTimeout(r, 20));
  const waitCall = async (cmd: string) => {
    const deadline = Date.now() + 5000;
    while (!calls.some(([c]) => c === cmd)) {
      assert.ok(Date.now() < deadline, `${cmd} was not called`);
      await new Promise((r) => setTimeout(r, 20));
    }
  };
  return { page, event, calls, waitCall };
}

test("完成一个：问下一步，“开始休息”交给宿主并收起气泡", async () => {
  const b = await bubble(1);
  await b.event("bubble-open", { mode: "focus", focus: "done", at: 1 });
  await b.page.waitForSelector(
    ".bubble-card[data-state='focus'] [data-focus]:not([hidden])",
  );
  assert.match(
    (await b.page.locator("[data-focus-text]").textContent())!,
    /5 分钟/,
  );
  assert.equal(await b.page.locator("[data-focus-act]").count(), 3);
  // Waiting confirmation stays up on Esc / pet click until user picks a choice.
  assert.equal(
    await b.page.locator(".bubble-card[data-focus-waiting]").count(),
    1,
  );
  await b.page.keyboard.press("Escape");
  await b.event("bubble-pet-click", null);
  assert.equal(
    b.calls.some(([c]) => c === "hide_bubble"),
    false,
    "待确认气泡不会因按 Esc 或点宠物被默默收起",
  );
  await b.page.locator("[data-focus-act='rest']").click();
  await b.waitCall("focus_rest");
  await b.waitCall("hide_bubble");
  await b.page.close();
});

test("连着完成第 4 个：建议长休息；休息完问继续还是结束", async () => {
  const b = await bubble(4);
  await b.event("bubble-open", { mode: "focus", focus: "done", at: 1 });
  await b.page.waitForSelector("[data-focus]:not([hidden])");
  assert.match(
    (await b.page.locator("[data-focus-text]").textContent())!,
    /连续专注 4 次.*15 分钟/,
  );
  await b.event("bubble-focus", "rested");
  await b.page.waitForFunction(
    () => document.querySelectorAll("[data-focus-act]").length === 2,
  );
  await b.page.locator("[data-focus-act='start']").click();
  await b.waitCall("focus_start");
  await b.page.close();
});

test("自动切换轻提示不锁气泡；待确认时切到聊天输入不丢确认条", async () => {
  const b = await bubble(1);
  await b.event("bubble-open", {
    mode: "focus",
    focus: "auto-break",
    at: 1,
  });
  await b.page.waitForSelector("[data-focus]:not([hidden])");
  assert.match(
    (await b.page.locator("[data-focus-text]").textContent())!,
    /自动开始休息 5 分钟/,
  );
  assert.equal(await b.page.locator("[data-focus-act]").count(), 0);
  assert.equal(
    await b.page.locator(".bubble-card[data-focus-waiting]").count(),
    0,
  );
  // Switch to waiting confirmation, then open chat input: confirmation stays.
  await b.event("bubble-open", { mode: "focus", focus: "done", at: 2 });
  await b.page.waitForSelector(".bubble-card[data-focus-waiting]");
  await b.event("bubble-open", { mode: "input", at: 3 });
  assert.equal(
    await b.page.locator("[data-focus]:not([hidden])").count(),
    1,
    "切到聊天输入时待确认条仍留在底部，不会悄悄丢掉",
  );
  await b.page.close();
});

test("专注页只看记录：三个数字、每天的柱子可切这个月、今天每段（中途结束的只写分钟，没选待办写只计时）、这一周花在哪", async () => {
  const page = await browser.newPage();
  await page.addInitScript("window.__name = (fn) => fn");
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() =>
    Boolean((window as any).__focus && (window as any).__studio),
  );
  await page.evaluate(() => (window as any).__studio.block("focus"));
  // No timer on the page: a tomato starts from the pet.
  assert.equal(await page.locator(".focus-controls, .ring-time").count(), 0);
  const t0 = new Date().setHours(9, 0, 0, 0);
  await page.evaluate(async (t0) => {
    const { todos } = await import("/src/todo/api.ts" as string);
    const D = 86_400_000;
    todos.spent = async () => [
      { at: t0, title: "写周报" },
      { at: t0 - D, title: "写周报" },
      { at: t0 - 2 * D, title: "读书" },
    ];
    const day = (back: number, minutes: number) => ({
      day: new Date(Date.now() - back * D).toISOString().slice(0, 10),
      count: Math.round(minutes / 25),
      minutes,
    });
    (window as any).__focus({
      phase: "idle",
      today: 1,
      todayMinutes: 37,
      weekCount: 3,
      weekMinutes: 112,
      streak: 3,
      longest: 9,
      week: [6, 5, 4, 3, 2, 1, 0].map((b) =>
        day(b, b === 0 ? 37 : b === 1 ? 50 : b === 2 ? 25 : 0),
      ),
      month: Array.from({ length: 30 }, (_, i) => day(29 - i, i % 3 ? 25 : 0)),
      sessions: [
        { at: t0, minutes: 25, done: true },
        { at: t0 + 3_600_000, minutes: 12, done: false },
      ],
      weekSessions: [
        { at: t0 - 2 * D, minutes: 25 },
        { at: t0 - D, minutes: 50 },
        { at: t0, minutes: 25 },
        { at: t0 + 3_600_000, minutes: 12 },
      ],
    });
  }, t0);
  await page.locator(".focus-today-row").nth(1).waitFor();
  // The numbers: one big each, the rest in small type.
  const tiles = await page.locator(".focus-tile").allInnerTexts();
  assert.match(tiles[0], /37\s*分钟[\s\S]*1 次 · 比昨天少 13 分钟/);
  assert.match(tiles[1], /112\s*分钟|1\.9\s*小时/);
  assert.match(tiles[2], /3\s*天[\s\S]*最长 9 天/);
  // Each day: the week, then the month.
  assert.equal(await page.locator(".focus-bars li").count(), 7);
  await page.locator('[data-range="month"]').click();
  assert.equal(await page.locator(".focus-bars li").count(), 30);
  // Today, newest first; ended early by its minutes, on nothing 只计时.
  const rows = await page.locator(".focus-today-row").allInnerTexts();
  assert.match(rows[0], /10:00.10:12\s+只计时\s+12 分钟/);
  assert.match(rows[1], /09:00.09:25\s+写周报\s+25 分钟/);
  assert.doesNotMatch(rows.join(" "), /放弃|失败/);
  // The week by to-do, the most first, 只计时 last.
  const spent = await page.locator(".focus-spent-row").allInnerTexts();
  assert.match(spent[0], /写周报[\s\S]*1 小时 15 分钟/);
  assert.match(spent[1], /读书[\s\S]*25 分钟/);
  assert.match(spent[2], /只计时[\s\S]*12 分钟/);
  const settings = page.locator(".focus-two + .focus-settings");
  // 10 for the timer, 1 for the desktop clock taking the pet's color.
  assert.equal(await settings.locator("[data-setting]").count(), 11);
  const minutes = settings.locator('[data-setting="focusMinutes"]');
  await minutes.fill("180");
  await minutes.press("Tab");
  assert.equal(await minutes.inputValue(), "180");
  assert.ok((await minutes.boundingBox())!.width >= 72);
  await page.close();
});
