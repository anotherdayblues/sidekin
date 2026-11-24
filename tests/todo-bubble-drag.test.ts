// 待办 in the bubble: today's list is put in order by the ⋮⋮, as on the
// page (drag.ts). Only six rows show; one let go under the last of them
// goes before the first one left for the page, not to the very end.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

const todo = (id: number, title: string) => ({
  id,
  title,
  day: "2026-11-17",
  time: null,
  repeat: null,
  doneAt: null,
  tomatoes: 0,
  due: false,
  group: "today",
  carried: false,
});

async function drag(page: Page, title: string, toY: number) {
  const grip = page
    .locator(".todo-card-row", { hasText: title })
    .locator(".todo-grip");
  const b = (await grip.boundingBox())!;
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2);
  await page.mouse.down();
  await page.mouse.move(b.x + b.width / 2, toY, { steps: 8 });
  await page.mouse.up();
  // The list is drawn again after a move.
  await page.waitForTimeout(200);
}

test("气泡里的待办：今天的可以拖动排序", async () => {
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
      viewport: { width: 480, height: 640 },
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    const calls: [string, any][] = [];
    const today = ["一", "二", "三", "四", "五", "六", "七", "八"].map((n, i) =>
      todo(i + 1, "第" + n + "件"),
    );
    await bubbleBridge(page, async (cmd, args) => {
      calls.push([cmd, args]);
      if (cmd === "bubble_intent") return { mode: "todo", todo: "today" };
      if (cmd === "get_state")
        return { settings: { theme: "day", skin: "studio" } };
      if (cmd === "companion_settings") return { enabled: false };
      if (cmd === "pending_reminders") return [];
      if (cmd === "todo_list") return today;
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?bubble");
    const rows = page.locator("[data-todo] .todo-card-row");
    await rows.first().waitFor();
    assert.equal(await rows.count(), 6);
    assert.equal(await rows.locator(".todo-grip").count(), 6);
    const moves = () =>
      calls.filter(([c]) => c === "todo_move").map(([, a]) => a);

    // 第三件 above 第一件.
    const first = (await rows.nth(0).boundingBox())!;
    await drag(page, "第三件", first.y + 4);
    assert.deepEqual(moves().at(-1), { id: 3, today: true, before: 1 });

    // 第一件 under the last row shown: before 第七件, the first not shown.
    const last = (await rows.nth(5).boundingBox())!;
    await drag(page, "第一件", last.y + last.height + 10);
    assert.deepEqual(moves().at(-1), { id: 1, today: true, before: 7 });

    // Let go where it was: nothing is saved.
    const n = moves().length;
    const second = (await rows.nth(1).boundingBox())!;
    await drag(page, "第二件", second.y + second.height / 2 + 2);
    assert.equal(moves().length, n);
  } finally {
    await browser.close();
    await server.close();
  }
});
