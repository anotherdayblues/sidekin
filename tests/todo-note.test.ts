// 今天的待办 on the pet page (plan/27, plan/35): today's open to-dos,
// struck through and then gone when done, deleted with 撤销, a line to
// write one only while none are left, the count beside the card's title.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

test("今天的待办：划掉、删掉可撤销、没有待办时才能写一条、只在待办变化时重画", async () => {
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
      viewport: { width: 420, height: 640 },
    });
    const calls: [string, any][] = [];
    const now = Date.now();
    const todo = (id: number, title: string, extra = {}) => ({
      id,
      title,
      day: "2026-11-16",
      time: null,
      repeat: null,
      doneAt: null,
      tomatoes: 0,
      due: false,
      group: "today",
      carried: false,
      ...extra,
    });
    const list = [
      todo(1, "回复设计稿的意见", { day: "2026-11-15", carried: true }),
      todo(2, "写周报"),
      todo(3, "开会", { time: "15:00" }),
      todo(4, "订机票", { doneAt: now, group: "done" }),
      todo(5, "很久以前做完的", {
        doneAt: now - 3 * 86_400_000,
        group: "done",
      }),
    ];
    const event = await bubbleBridge(page, async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "todo_list") return list;
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    await page.evaluate(async () => {
      const { mountTodayNote } = await import("/src/todo/note.ts");
      const slot = document.createElement("div");
      const meta = document.createElement("span");
      meta.id = "meta";
      document.querySelector("#app")!.append(slot, meta);
      mountTodayNote(slot, meta);
    });
    const said = (cmd: string) =>
      calls.filter(([c]) => c === cmd).map(([, a]) => a);
    const line = (title: string) =>
      page.locator(".today-note-line", { hasText: title });
    await line("写周报").waitFor();
    // The open ones only; the count goes beside the title.
    assert.deepEqual(await page.locator(".today-note-text").allInnerTexts(), [
      "回复设计稿的意见",
      "写周报",
      "开会",
    ]);
    assert.match(await line("开会").innerText(), /15:00/);
    assert.equal(await page.locator("#meta").textContent(), "3 件");
    assert.equal(await page.locator(".todo-quick").isVisible(), false);

    // Struck through at once, done after a moment.
    await line("写周报").locator(".today-note-item").click();
    assert.equal(await line("写周报").getAttribute("data-state"), "leaving");
    await page.waitForTimeout(1500);
    assert.deepEqual(said("todo_complete"), [{ id: 2 }]);

    // Deleted, then taken back.
    await line("开会").hover();
    await line("开会").locator(".today-note-del").click();
    await line("开会").getByRole("button", { name: "撤销" }).click();
    await page.waitForTimeout(4300);
    assert.equal(said("todo_remove").length, 0);

    // Drawn again only when the to-dos change: no timer asks meanwhile.
    const asked = said("todo_list").length;
    await page.waitForTimeout(1500);
    assert.equal(said("todo_list").length, asked, "nothing polls");
    await event("todos-changed", null);
    await page.waitForTimeout(200);
    assert.equal(said("todo_list").length, asked + 1);

    // All done: said so, and the line to write one shows.
    list.splice(0, 3);
    await event("todos-changed", null);
    await page.locator(".today-note-empty").getByText("一共 1 件").waitFor();
    assert.equal(await page.locator("#meta").textContent(), "");
    const write = page.locator(".today-note .todo-quick-input");
    await write.fill("明天下午3点交报告");
    await page.locator(".today-note .todo-quick-add").click();
    const added = said("todo_add").at(-1).fields;
    assert.deepEqual([added.title, added.time], ["交报告", "15:00"]);
  } finally {
    await browser.close();
    await server.close();
  }
});
