// 待办 page (plan/27): add one for today, check one off (struck through a
// moment first, so a slip can be taken back), and start a tomato on one.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

const SHOTS = process.env.TODO_SHOTS;

test("待办页：新建、勾掉可撤回、开始专注", async () => {
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
      viewport: { width: 820, height: 560 },
    });
    const calls: [string, any][] = [];
    const list = [
      {
        id: 1,
        title: "写周报",
        day: "2026-11-16",
        time: null,
        repeat: null,
        doneAt: null,
        tomatoes: 2,
        due: false,
        group: "today",
      },
      {
        id: 2,
        title: "开会",
        day: "2026-11-16",
        time: "15:00",
        repeat: "daily",
        doneAt: null,
        tomatoes: 0,
        due: false,
        group: "today",
      },
    ];
    await bubbleBridge(page, async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "todo_list") return list;
      if (cmd === "todo_focus_state")
        return { current: null, candidates: list };
      if (cmd === "list_reminders") return [];
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    await page.evaluate(async () => {
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
    await row("写周报").waitFor();
    assert.equal(await row("写周报").locator(".todo-tomatoes i").count(), 2);
    assert.match(await row("开会").locator(".todo-meta").innerText(), /15:00/);
    if (SHOTS) await page.screenshot({ path: SHOTS + "/page-test.png" });

    // Added for today, from the line at the top.
    await page.locator(".todo-new .todo-quick-input").fill("交报告");
    await page.locator(".todo-new .todo-quick-input").press("Enter");
    await page.waitForFunction(
      () =>
        document.querySelector<HTMLInputElement>(".todo-new .todo-quick-input")!
          .value === "",
    );
    const [added] = said("todo_add");
    assert.equal(added.fields.title, "交报告");
    assert.match(added.fields.day, /^\d{4}-\d{2}-\d{2}$/);

    // Checked, then taken back within the moment: nothing is completed.
    await row("写周报").locator(".todo-check").click();
    assert.equal(await row("写周报").getAttribute("data-state"), "leaving");
    await row("写周报").locator(".todo-check").click();
    assert.equal(await row("写周报").getAttribute("data-state"), "open");
    await page.waitForTimeout(1500);
    assert.equal(said("todo_complete").length, 0, "taken back in time");

    // Checked and left: completed after the moment.
    await row("开会").locator(".todo-check").click();
    await page.waitForTimeout(400);
    assert.equal(said("todo_complete").length, 0, "not at once");
    await page.waitForTimeout(1200);
    assert.deepEqual(said("todo_complete"), [{ id: 2 }]);

    // Deleted: 撤销 for a moment, then gone.
    await row("开会").click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除" }).click();
    await page.getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(4300);
    assert.equal(said("todo_remove").length, 0, "taken back");
    await row("开会").click({ button: "right" });
    await page.getByRole("menuitem", { name: "删除" }).click();
    await page.waitForTimeout(4300);
    assert.deepEqual(said("todo_remove"), [{ id: 2 }]);

    // A tomato on one.
    await row("写周报").hover();
    await row("写周报").getByRole("button", { name: "开始专注" }).click();
    assert.deepEqual(said("todo_focus").at(-1), { id: 1 });

    // A pencil on the row under the pointer opens its editor; 取消 closes it.
    await row("写周报").hover();
    await row("写周报").getByRole("button", { name: "编辑" }).click();
    await page.locator(".todo-edit-title").waitFor();
    assert.equal(await page.locator(".todo-edit-title").inputValue(), "写周报");
    await page
      .locator(".todo-edit")
      .getByRole("button", { name: "取消" })
      .click();
    await page.locator(".todo-edit").waitFor({ state: "detached" });

    // The × on the row: deleted, with 撤销 for a moment.
    await row("写周报").hover();
    await row("写周报").getByRole("button", { name: "删" }).click();
    await row("写周报").getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(4300);
    assert.equal(said("todo_remove").length, 1, "only the one before");
  } finally {
    await browser.close();
    await server.close();
  }
});

// The one a tomato was on last is 专注中 only while the tomato runs; once it
// ends, the row is plain again and can start a new one (plan/29).
test("待办页：只在番茄钟进行时标“专注中”", async () => {
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
      viewport: { width: 820, height: 560 },
    });
    const todo = {
      id: 1,
      title: "写周报",
      day: "2026-11-16",
      time: null,
      repeat: null,
      doneAt: null,
      tomatoes: 1,
      due: false,
      group: "today",
    };
    let phase = "idle";
    await bubbleBridge(page, async (cmd) => {
      if (cmd === "todo_list") return [todo];
      if (cmd === "todo_focus_state")
        return { current: todo, candidates: [todo] };
      if (cmd === "focus_state") return { phase, now: Date.now() };
      if (cmd === "list_reminders") return [];
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    await page.evaluate(async () => {
      const { todoPage } = await import("/src/todo/page.ts");
      const todo = todoPage(document.createElement("section"));
      (window as any).__todo = todo;
      document.querySelector("#app")!.append(todo.page);
      await todo.refresh();
    });
    const row = page.locator(".todo-row", { hasText: "写周报" });
    await row.waitFor();
    assert.equal(await row.getAttribute("data-focusing"), null, "idle");
    await row.hover();
    assert.equal(
      await row.getByRole("button", { name: "开始专注" }).count(),
      1,
      "can start again",
    );

    phase = "focus";
    await page.evaluate(() => (window as any).__todo.refresh());
    assert.equal(await row.getAttribute("data-focusing"), "", "running");

    phase = "done";
    await page.evaluate(() => (window as any).__todo.refresh());
    assert.equal(await row.getAttribute("data-focusing"), null, "finished");
  } finally {
    await browser.close();
    await server.close();
  }
});
