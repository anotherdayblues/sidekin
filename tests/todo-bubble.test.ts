// 待办 in the bubble (plan/27): today's card (a line that understands
// "明天下午3点", over today's list to tick off), which one a tomato is on,
// carrying on with the last one, an alert, and after a tomato its to-do.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

const SHOTS = process.env.TODO_SHOTS;
const SKIN = process.env.TODO_SKIN ?? "studio";

test("气泡里的待办：今天、选一件专注、只计时、到点提醒、番茄后完成", async () => {
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
      viewport: { width: 480, height: 460 },
      deviceScaleFactor: SHOTS ? 2 : 1,
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const calls: [string, any][] = [];
    const todo = (
      id: number,
      title: string,
      time: string | null = null,
      group = "today",
    ) => ({
      id,
      title,
      day: "2026-11-16",
      time,
      repeat: null,
      doneAt: null,
      tomatoes: id === 1 ? 2 : 0,
      due: false,
      group,
      carried: group === "carried",
    });
    const today = [
      {
        ...todo(4, "回复设计稿的意见", null),
        day: "2026-11-15",
        carried: true,
      },
      todo(1, "写周报"),
      todo(3, "开会", "15:00"),
    ];
    const intent = { mode: "todo", todo: "today" };
    const event = await bubbleBridge(page, async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "bubble_intent") return intent;
      if (cmd === "get_state")
        return { settings: { theme: "day", skin: SKIN } };
      if (cmd === "companion_settings") return { enabled: false };
      if (cmd === "pending_reminders") return [];
      if (cmd === "todo_list") return today;
      if (cmd === "todo_pending") return [todo(3, "开会", "15:00")];
      if (cmd === "todo_focus_state")
        return { current: today[1], candidates: today };
      if (cmd === "focus_state") return { settings: { focusMinutes: 28 } };
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?bubble");
    const box = page.locator("[data-todo]");
    const said = (cmd: string) =>
      calls.filter(([c]) => c === cmd).map(([, a]) => a);
    const shot = async (name: string) => {
      if (SHOTS)
        await page
          .locator(".bubble-card")
          .screenshot({ path: `${SHOTS}/${SKIN}-${name}.png` });
    };

    // 今天: an empty line (the menu no longer reads a selection, plan/29);
    // what is typed has its date and time understood.
    const input = box.locator(".todo-quick-input");
    await input.waitFor();
    assert.equal(await input.inputValue(), "");
    await input.fill("明天下午3点交报告");
    await box.locator(".todo-quick-chip").getByText("明天 15:00").waitFor();
    assert.equal(await box.locator(".todo-quick-mirror mark").count(), 1);
    assert.equal(await box.locator(".todo-card-row").count(), 3);
    await shot("today");
    await input.press("Enter");
    await box.getByText("记下了：交报告").waitFor();
    assert.equal(said("todo_add")[0].fields.title, "交报告");
    assert.equal(said("todo_add")[0].fields.time, "15:00");
    // Dropped: the words stay words.
    await input.fill("每天9点喝水");
    await box.locator(".todo-quick-drop").click();
    await input.press("Enter");
    assert.deepEqual(said("todo_add").at(-1).fields.title, "每天9点喝水");
    assert.equal(said("todo_add").at(-1).fields.repeat, "");
    // Picked by hand, added with the 添加 key.
    await input.fill("整理照片");
    await box
      .locator(".todo-quick-pickers select")
      .first()
      .selectOption("tomorrow");
    await box.locator('.todo-quick-pickers input[type="time"]').fill("09:30");
    await box.locator(".todo-quick-add").click();
    const byHand = said("todo_add").at(-1).fields;
    assert.equal(byHand.title, "整理照片");
    assert.equal(byHand.time, "09:30");
    assert.match(byHand.day, /^\d{4}-\d{2}-\d{2}$/);
    // Deleted from the list, then taken back: nothing is deleted.
    const row = box.locator(".todo-card-row").first();
    await row.hover();
    await row.locator(".todo-del-key").click();
    await row.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(4300);
    assert.equal(said("todo_remove").length, 0, "taken back in time");

    // ⋯ and a right click open the 待办 page's menu; with 伙伴大脑 off
    // there is no 帮我拆一下.
    const second = box.locator(".todo-card-row").nth(1);
    await second.hover();
    await second.getByRole("button", { name: "更多" }).click();
    assert.deepEqual(await page.locator(".todo-menu button").allInnerTexts(), [
      "移到以后",
      "编辑",
      "开始专注",
      "删除",
    ]);
    await page.keyboard.press("Escape");
    await second.click({ button: "right" });
    await page.getByRole("menuitem", { name: "移到以后" }).click();
    assert.deepEqual(said("todo_move").at(-1), {
      id: 1,
      today: false,
      before: null,
    });

    // Edited in place by the pencil, as on the page.
    const third = box.locator(".todo-card-row").nth(2);
    await third.hover();
    await third.getByRole("button", { name: "编辑" }).click();
    await box.locator(".todo-edit-title").fill("开周会");
    await box
      .locator(".todo-edit")
      .getByRole("button", { name: "保存" })
      .click();
    await box.locator(".todo-edit").waitFor({ state: "detached" });
    assert.equal(said("todo_update").at(-1).id, 3);
    assert.equal(said("todo_update").at(-1).fields.title, "开周会");

    // Ticked off in the list: after a moment, so a slip can be taken back.
    await box.locator(".todo-card-row").nth(1).locator(".todo-check").click();
    await page.waitForTimeout(1500);
    assert.deepEqual(said("todo_complete").at(-1), { id: 1 });

    // 陪我专注 with to-dos for today: which one?
    await event("bubble-open", { mode: "todo", todo: "pick", at: 2 });
    await box.getByText("从待办开始").waitFor();
    assert.equal(
      await box
        .locator(".todo-focus-duration")
        .innerText()
        .then((s) => s.replace(/\s/g, "")),
      "28分钟",
    );
    await shot("pick");
    await box.getByRole("button", { name: /开会/ }).click();
    assert.deepEqual(said("todo_focus").at(-1), { id: 3 });

    // The previous task is still open. Only an explicit choice starts a session.
    await event("bubble-open", { mode: "todo", todo: "pick", at: 3 });
    const timerOnly = box.getByRole("button", { name: "只计时", exact: true });
    await timerOnly.waitFor();
    assert.equal(await box.getByRole("button").first().textContent(), "只计时");
    assert.equal(said("todo_focus").length, 1);
    await timerOnly.click();
    assert.deepEqual(said("todo_focus").at(-1), { id: null });

    // An alert: 完成, or one of four snoozes, each with the time it rings
    // again (今晚 only before 19:30).
    await event("bubble-open", { mode: "todo", todo: "due", at: 4 });
    await box.getByText("提醒", { exact: true }).waitFor();
    await shot("due");
    // The snoozes are folded behind one key; open, each says its time.
    assert.equal(await box.locator(".todo-snoozes").isVisible(), false);
    await box.getByRole("button", { name: "稍后提醒" }).click();
    const keys = await box.locator(".todo-snooze > span").allTextContents();
    assert.ok(
      keys.includes("10 分钟后") && keys.includes("明天早上"),
      keys.join(),
    );
    assert.equal(await box.locator(".todo-snooze small").first().count(), 1);
    await shot("due-later");
    await box.getByRole("button", { name: /1 小时后/ }).click();
    assert.deepEqual(said("todo_answer").at(-1), {
      ids: [3],
      action: "snooze60",
    });

    // A tomato done: the to-do it was on, as a row to tick.
    await event("bubble-open", { mode: "focus", focus: "done", at: 5 });
    const line = page.locator("[data-focus-todo]");
    await line.getByText("写周报").waitFor();
    await shot("focus-done");
    await line.locator(".todo-check").click();
    await line.getByText("完成了！").waitFor({ timeout: 3000 });
    assert.deepEqual(said("todo_complete").at(-1), { id: 1 });
  } finally {
    await browser.close();
    await server.close();
  }
});
