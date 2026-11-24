// 宠物页右栏的卡片 (plan/35): which show and in what order, set in the
// 卡片 list (a switch to show, ⋮⋮ or ↑ ↓ to move), the choice saved with
// the app settings, one size for each card, and 性格 not in the column.
// Checked through the real page.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser, type Page } from "playwright";
import {
  cardList,
  moved,
  shownCards,
} from "../apps/desktop/src/homeWidgetList.ts";

test("清单：没存过用默认三张；存过的只留认识的、不重复、按原顺序；旧版存的大小不管", () => {
  assert.deepEqual(shownCards(undefined), ["today", "focus", "memory"]);
  assert.deepEqual(shownCards(null), ["today", "focus", "memory"]);
  assert.deepEqual(shownCards([]), []);
  assert.deepEqual(
    shownCards([
      { id: "chats", size: "big" } as { id: string },
      { id: "weather" },
      { id: "today" },
      { id: "chats" },
    ]),
    ["chats", "today"],
  );
  // The list: the shown ones in order, then the rest, off.
  assert.deepEqual(cardList(["focus", "today"]), [
    { id: "focus", on: true },
    { id: "today", on: true },
    { id: "memory", on: false },
    { id: "chats", on: false },
  ]);
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id).join();
  const rows = cardList(["today", "focus"]);
  assert.equal(ids(moved(rows, "focus", -1)), "focus,today,memory,chats");
  // At an end it stays.
  assert.equal(ids(moved(rows, "today", -1)), "today,focus,memory,chats");
  assert.equal(ids(moved(rows, "chats", 1)), "today,focus,memory,chats");
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

const day = (n: number) => {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0, 10);
};
const WEEK = [40, 70, 20, 90, 55, 0, 50].map((m, i) => ({
  day: day(6 - i),
  count: 2,
  minutes: m,
}));

async function open() {
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() => (window as any).__studio);
  await page.evaluate(() => (window as any).__studio.load("learned"));
  await page.locator("#widgets > .widget").first().waitFor();
  return page;
}
const focus = (page: Page, state: object) =>
  page.evaluate(async (s) => {
    (await import("/src/focus.ts")).previewFocus(s as any);
  }, state);
const shown = (page: Page) =>
  page.$$eval("#widgets > .widget", (ws) =>
    ws.map((w) => (w as HTMLElement).dataset.widget),
  );
const saved = (page: Page) =>
  page.evaluate(async () => {
    const api = await import("/src/bridge.ts");
    const cs = api.browserSnapshot().settings.homeCards;
    return cs ? cs.map((c) => c.id).join() : null;
  });
const listed = (page: Page) =>
  page.$$eval(".cards-row", (rs) =>
    rs.map(
      (r) =>
        `${(r as HTMLElement).dataset.widget}:${(r.querySelector(".cards-switch") as HTMLInputElement).checked ? "on" : "off"}`,
    ),
  );
const until = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 5000;
  while (!(await check())) {
    assert.ok(Date.now() < end, "timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
};

test("平时：默认三张，每张上面是标题、最后一行是去处；没有编辑的东西，右栏里也没有性格", async () => {
  const page = await open();
  assert.deepEqual(await shown(page), ["today", "focus", "memory"]);
  const titles = await page.$$eval("#widgets .hc-title", (ts) =>
    ts.map((t) => t.textContent),
  );
  assert.deepEqual(titles, ["今天的待办", "今天的专注", "它最近记住的"]);
  // One key to go on in each, at its foot.
  for (const id of ["today", "focus", "memory"]) {
    const keys = page.locator(`.widget[data-widget="${id}"] .hc-act`);
    assert.equal(await keys.count(), 1, id);
    assert.ok(
      await keys.evaluate((k) => !k.nextElementSibling),
      `${id}: the key is last`,
    );
  }
  // No editing in place any more (plan/35).
  assert.equal(
    await page
      .locator(".widget-remove, .widget-grip, .widget-size, #widget-add")
      .count(),
    0,
  );
  assert.equal(await page.locator(".cards-pop").count(), 0);
  assert.equal(
    await page.locator(".side .persona-row, .side textarea").count(),
    0,
  );
  await page.close();
});

test("卡片清单：开关显示、⋮⋮ 拖动和方向键换顺序，每次都存下；Esc 和点外面关上", async () => {
  const page = await open();
  await page.click("#cards-key");
  assert.equal(await page.getAttribute("#cards-key", "aria-expanded"), "true");
  assert.deepEqual(await listed(page), [
    "today:on",
    "focus:on",
    "memory:on",
    "chats:off",
  ]);

  // Off: gone from the column, saved.
  await page.click('.cards-row[data-widget="memory"] .cards-name');
  assert.deepEqual(await shown(page), ["today", "focus"]);
  await until(async () => (await saved(page)) === "today,focus");
  // On again where it stands in the list; chats too, read when it shows.
  await page.click('.cards-row[data-widget="chats"] .cards-name');
  await page.click('.cards-row[data-widget="memory"] .cards-name');
  assert.deepEqual(await shown(page), ["today", "focus", "memory", "chats"]);
  await page.waitForSelector('.widget[data-widget="chats"] .hc-chat');

  // ↑ on a grip moves it, and keeps the focus on it.
  await page.focus('.cards-row[data-widget="chats"] .cards-grip');
  await page.keyboard.press("ArrowUp");
  assert.deepEqual(await shown(page), ["today", "focus", "chats", "memory"]);
  assert.equal(
    await page.evaluate(
      () =>
        (document.activeElement?.closest(".cards-row") as HTMLElement)?.dataset
          .widget,
    ),
    "chats",
  );
  await until(async () => (await saved(page)) === "today,focus,chats,memory");

  // Dragging ⋮⋮: today to the end.
  const grip = await page
    .locator('.cards-row[data-widget="today"] .cards-grip')
    .boundingBox();
  const last = await page
    .locator('.cards-row[data-widget="memory"]')
    .boundingBox();
  await page.mouse.move(grip!.x + grip!.width / 2, grip!.y + grip!.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip!.x + 5, last!.y + last!.height - 3, {
    steps: 12,
  });
  await page.mouse.up();
  assert.deepEqual(await shown(page), ["focus", "chats", "memory", "today"]);
  await until(async () => (await saved(page)) === "focus,chats,memory,today");

  await page.keyboard.press("Escape");
  assert.equal(await page.locator(".cards-pop").count(), 0);
  await page.click("#cards-key");
  await page.mouse.click(600, 300);
  assert.equal(await page.locator(".cards-pop").count(), 0);
  assert.equal(await page.getAttribute("#cards-key", "aria-expanded"), "false");
  await page.close();
});

test("每张卡的内容：专注是今天分钟、这周小时和小柱子；记住的两件；待办最多五件，有待办时不显示写一条", async () => {
  const page = await open();
  await focus(page, {
    week: WEEK,
    today: 2,
    todayMinutes: 50,
    weekMinutes: 325,
    streak: 3,
  });
  const f = page.locator('.widget[data-widget="focus"]');
  await f.locator(".hc-bars i").first().waitFor();
  assert.equal(await f.locator(".hc-big").textContent(), "50");
  assert.equal(await f.locator(".hc-bars i").count(), 7);
  assert.match((await f.locator(".hc-sub").textContent())!, /5\.4/);
  assert.equal(await f.locator(".hc-meta").textContent(), "连续 3 天");
  assert.equal(await f.locator(".hc-act").textContent(), "专注");
  const m = page.locator('.widget[data-widget="memory"]');
  await m.locator(".hc-text").first().waitFor();
  assert.equal(await m.locator(".hc-text").count(), 2);
  assert.equal(await m.locator(".hc-meta").textContent(), "共 3 件");
  const today = page.locator('.widget[data-widget="today"]');
  await today.locator(".today-note-line").first().waitFor();
  assert.ok((await today.locator(".today-note-line").count()) <= 5);
  assert.equal(await today.locator(".todo-quick").isVisible(), false);
  assert.match((await today.locator(".hc-meta").textContent())!, /^\d+ 件$/);
  await page.close();
});

test("待办卡：有待办时点 + 才出现写一条，Esc 收起；专注卡点「专注」在卡里问做哪件，取消或 Esc 回去，选了就收起", async () => {
  const page = await open();
  const today = page.locator('.widget[data-widget="today"]');
  await today.locator(".today-note-line").first().waitFor();
  const write = today.locator(".todo-quick");
  assert.equal(await write.isVisible(), false);
  await today.locator(".hc-add").click();
  assert.ok(await write.isVisible());
  assert.ok(
    await today
      .locator(".todo-quick-input")
      .evaluate((i) => i === document.activeElement),
  );
  await page.keyboard.press("Escape");
  await until(async () => !(await write.isVisible()));

  await focus(page, {
    week: WEEK,
    today: 2,
    todayMinutes: 50,
    weekMinutes: 325,
    streak: 3,
  });
  const f = page.locator('.widget[data-widget="focus"]');
  await f.locator(".hc-act").click();
  await f.locator(".hc-ask").waitFor();
  assert.equal(
    await f.locator(".hc-ask .hc-text").textContent(),
    "这次做哪件？",
  );
  const picks = f.locator(".hc-pick");
  assert.ok((await picks.count()) >= 1 && (await picks.count()) <= 5);
  assert.equal(await f.locator(".hc-act").textContent(), "只计时");
  // 取消 and Esc go back; choosing one closes the list too.
  await f.locator(".hc-ask .hc-btn").click();
  await f.locator(".hc-bars").waitFor();
  await f.locator(".hc-act").click();
  await f.locator(".hc-ask").waitFor();
  await page.keyboard.press("Escape");
  await f.locator(".hc-bars").waitFor();
  await f.locator(".hc-act").click();
  await picks.first().click();
  await f.locator(".hc-bars").waitFor();
  assert.equal(await f.locator(".hc-pick").count(), 0);
  await page.close();
});

test("专注中：卡片换成倒计时、暂停和结束，点结束就停；这周没专注时说清楚，点「专注」照样在卡里问做哪件", async () => {
  const page = await open();
  await focus(page, {
    week: WEEK,
    weekMinutes: 325,
    phase: "focus",
    round: 3,
    length: 25 * 60_000,
    endsAt: Date.now() + 18 * 60_000,
    pausedLeft: null,
  });
  const f = page.locator('.widget[data-widget="focus"]');
  await f.locator(".hc-clock").waitFor();
  assert.match((await f.locator(".hc-clock").textContent())!, /^1[78]:\d\d$/);
  const keys = await f
    .locator(".hc-btn")
    .evaluateAll((bs) => bs.map((b) => b.textContent));
  assert.deepEqual(keys, ["暂停", "结束"]);
  assert.match((await f.locator(".hc-meta").textContent())!, /第 3 个/);
  // 结束 stops it: the card is back to the day's numbers.
  await f.locator(".hc-btn", { hasText: "结束" }).click();
  await f.locator(".hc-bars").waitFor();

  await focus(page, {
    phase: "idle",
    week: WEEK.map((d) => ({ ...d, minutes: 0 })),
    weekMinutes: 0,
  });
  await f.locator(".hc-line-big").waitFor();
  assert.ok(await f.locator(".hc-bars[data-flat]").count());
  // 专注 asks in the card, as when the week has some.
  await f.locator(".hc-act").click();
  await f.locator(".hc-ask").waitFor();
  await page.close();
});

test("性格：宠物那组设置里一行，点开从右边出一块大面板，整份能写，字数跟着变，恢复默认、保存在下面，关掉回到原处", async () => {
  const page = await open();
  const row = page.locator("#controls .persona-row");
  assert.ok(await row.isVisible());
  // Only the word and the arrow: nothing of the text on the row.
  assert.equal((await row.textContent())!.trim(), "性格");
  await row.click();
  const sheet = page.locator("dialog.persona-sheet[open]");
  await sheet.waitFor();
  const name = (await page.locator("#name").textContent())!;
  assert.equal(
    await sheet.locator("#persona-title").textContent(),
    `${name}的性格`,
  );
  const text = sheet.locator("textarea");
  assert.ok(await text.isVisible());
  assert.ok((await text.boundingBox())!.height > 300);
  await text.fill("说话方式：\n- 轻松\n\n平时：\n- 先听再说");
  assert.equal(
    await sheet.locator(".persona-count").textContent(),
    "22 / 1500 字",
  );
  const keys = await sheet
    .locator(".persona-foot button")
    .evaluateAll((bs) => bs.map((b) => b.textContent));
  assert.deepEqual(keys, ["恢复默认", "保存"]);
  await sheet.locator(".persona-close").click();
  assert.equal(await page.locator("dialog.persona-sheet[open]").count(), 0);
  // Esc closes it as well.
  await row.click();
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("dialog.persona-sheet[open]").count(), 0);
  await page.close();
});
