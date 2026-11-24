// 待办 page, plan/30: 今天 and 以后 only; yesterday's carries on in 今天,
// quietly; the order is the user's, by dragging the ⋮⋮, also across the
// two groups; a time is a reminder, with a bell.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

const SHOTS = process.env.TODO_SHOTS;
const day = (offset: number) => {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
};
const todo = (id: number, title: string, extra = {}) => ({
  id,
  title,
  day: day(0),
  time: null,
  repeat: null,
  doneAt: null,
  tomatoes: 0,
  due: false,
  group: "today",
  carried: false,
  ...extra,
});

/** Drags the row's ⋮⋮ to a point, slowly, as a hand does. */
async function drag(page: Page, title: string, to: { x: number; y: number }) {
  const grip = page
    .locator(".todo-row", { hasText: title })
    .locator(".todo-grip");
  const b = (await grip.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x, to.y, { steps: 8 });
  await page.mouse.up();
}

test("待办页：今天和以后两组、昨天的顺延不标红、拖动排序和跨组、提醒带铃铛", async () => {
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
      viewport: { width: 900, height: 760 },
      deviceScaleFactor: SHOTS ? 2 : 1,
    });
    const calls: [string, any][] = [];
    const list = [
      todo(5, "回复设计稿的意见", { day: day(-1), carried: true }),
      todo(1, "写周报"),
      todo(2, "开会", { time: "15:00" }),
      todo(3, "交报告", { day: day(1), time: "15:00", group: "later" }),
      todo(4, "学吉他", { day: null, group: "later" }),
    ];
    await bubbleBridge(page, async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "todo_list") return list;
      if (cmd === "todo_focus_state") return { current: null, candidates: [] };
      if (cmd === "list_reminders") return [];
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    await page.evaluate(async () => {
      localStorage.removeItem("todo-drag-hint-seen");
      const { todoPage } = await import("/src/todo/page.ts");
      const todo = todoPage(document.createElement("section"));
      const shell = document.createElement("div");
      shell.className = "shell";
      const block = document.createElement("section");
      block.className = "block";
      block.dataset.for = "reminders";
      block.append(todo.page);
      shell.append(block);
      document.querySelector("#app")!.append(shell);
      await todo.refresh();
    });
    const said = (cmd: string) =>
      calls.filter(([c]) => c === cmd).map(([, a]) => a);
    const row = (title: string) =>
      page.locator(".todo-row", { hasText: title });
    /** Where a row is, once the list has been drawn again after a move. */
    const box = async (title: string) => {
      await page.waitForTimeout(150);
      await row(title).waitFor();
      return (await row(title).boundingBox())!;
    };
    await row("写周报").waitFor();

    // Two groups; nothing is 已过期; yesterday's says so quietly.
    assert.deepEqual(
      await page
        .locator(".todo-group")
        .evaluateAll((gs) => gs.map((g) => (g as HTMLElement).dataset.group)),
      ["today", "later"],
    );
    assert.equal(await page.getByText("已过期").count(), 0);
    assert.equal(
      await row("回复设计稿的意见").locator(".todo-carried").innerText(),
      "昨天的",
    );
    // A time is a reminder: drawn with a bell.
    assert.equal(await row("开会").locator(".todo-time").innerText(), "15:00");
    const bell = await row("开会")
      .locator(".todo-time")
      .evaluate((e) => getComputedStyle(e, "::before").maskImage);
    assert.match(bell, /svg/);
    // Every open row has its ⋮⋮, and the page says how, once.
    assert.equal(await page.locator(".todo-grip").count(), 5);
    await page.locator(".todo-hint").waitFor();
    if (SHOTS) await page.screenshot({ path: SHOTS + "/page.png" });

    // 开会 dragged above 写周报.
    const top = await box("写周报");
    await drag(page, "开会", { x: top.x + 200, y: top.y + 4 });
    assert.deepEqual(said("todo_move").at(-1), {
      id: 2,
      today: true,
      before: 1,
    });

    // 学吉他 dragged from 以后 to the end of 今天; the group lights up meanwhile.
    const last = await box("开会");
    await box("学吉他");
    const g = (await row("学吉他").locator(".todo-grip").boundingBox())!;
    await page.mouse.move(g.x + 4, g.y + 4);
    await page.mouse.down();
    await page.mouse.move(last.x + 200, last.y + last.height - 4, { steps: 8 });
    assert.equal(
      await page
        .locator('.todo-group[data-group="today"][data-drop-into]')
        .count(),
      1,
    );
    if (SHOTS) await page.screenshot({ path: SHOTS + "/dragging.png" });
    await page.mouse.up();
    assert.deepEqual(said("todo_move").at(-1), {
      id: 4,
      today: true,
      before: null,
    });

    // Let go where it was: nothing is saved.
    const n = said("todo_move").length;
    const self = await box("写周报");
    await drag(page, "写周报", {
      x: self.x + 200,
      y: self.y + self.height / 2 + 2,
    });
    assert.equal(said("todo_move").length, n);

    // Or from the row's right-click menu.
    await row("写周报").click({ button: "right" });
    await page.getByRole("menuitem", { name: "移到以后" }).click();
    assert.deepEqual(said("todo_move").at(-1), {
      id: 1,
      today: false,
      before: null,
    });
    await box("交报告");
    await row("交报告").click({ button: "right" });
    await page.getByRole("menuitem", { name: "移到今天" }).click();
    assert.deepEqual(said("todo_move").at(-1), {
      id: 3,
      today: true,
      before: null,
    });
  } finally {
    await browser.close();
    await server.close();
  }
});
