// 待办 with 伙伴大脑 (plan/31), kept quiet: only 开始专注 on a row, the rest
// a right click away; a pasted paragraph offers 整理成几条; 帮我拆一下 is in
// the menu. Nothing is added before the user ticks and confirms.
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

async function open(ai: boolean) {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  const page = await browser.newPage({
    viewport: { width: 900, height: 760 },
    deviceScaleFactor: SHOTS ? 2 : 1,
  });
  page.setDefaultTimeout(10_000);
  const calls: [string, any][] = [];
  const list = [todo(1, "准备搬家"), todo(2, "写周报")];
  let id = 10;
  await bubbleBridge(page, async (cmd, args) => {
    calls.push([cmd, args]);
    if (cmd === "todo_list") return list;
    if (cmd === "todo_focus_state") return { current: null, candidates: [] };
    if (cmd === "todo_ai_ready") return ai;
    if (cmd === "todo_add") return { ...todo(++id, args.fields.title) };
    if (cmd === "todo_plan")
      return args.mode === "split"
        ? [
            { title: "把报价单发给客户", day: day(6) },
            { title: "和客户开会", day: day(1), time: "14:00" },
            { title: "交本月报销", day: day(3) },
          ]
        : [
            { title: "列一张要带走的大件清单", note: "写下来就算完成" },
            { title: "问两家搬家公司报价" },
          ];
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
  const close = async () => {
    await browser.close();
    await server.close();
  };
  return { page, said, close };
}
const row = (page: Page, title: string) =>
  page.locator(".todo-row", { hasText: title });

test("待办 AI：行上有开始专注、编辑、更多和删除、右键菜单、双击改标题、粘贴一段话整理、帮我拆一下", async () => {
  const { page, said, close } = await open(true);
  try {
    await row(page, "准备搬家").waitFor();
    // On the row: 开始专注, a pencil to edit, ⋯ for the rest, an × to delete.
    await row(page, "写周报").hover();
    assert.deepEqual(
      await row(page, "写周报")
        .locator(".todo-acts button")
        .evaluateAll((bs) =>
          bs.map((b) => b.getAttribute("aria-label") ?? b.textContent),
        ),
      ["开始专注", "编辑", "更多", "删"],
    );
    // ⋯ opens the right-click menu, under itself; Escape closes it.
    await row(page, "写周报").getByRole("button", { name: "更多" }).click();
    assert.deepEqual(await page.locator(".todo-menu button").allInnerTexts(), [
      "移到以后",
      "帮我拆一下",
      "编辑",
      "开始专注",
      "删除",
    ]);
    // Every item's words start at one line, the face drawn or not yet.
    const starts = await page.locator(".todo-menu button").evaluateAll((bs) =>
      bs.map((b) => {
        const range = document.createRange();
        range.selectNodeContents(b.lastChild!);
        return Math.round(range.getBoundingClientRect().left);
      }),
    );
    assert.equal(new Set(starts).size, 1, `starts ${starts}`);
    const more = await row(page, "写周报")
      .getByRole("button", { name: "更多" })
      .boundingBox();
    const opened = await page.locator(".todo-menu").boundingBox();
    assert.ok(opened!.y >= more!.y + more!.height, "under the key");
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".todo-menu").count(), 0);

    // A double click on the title edits it in place.
    await row(page, "写周报").locator(".todo-title").dblclick();
    await page.locator(".todo-edit-title").waitFor();
    await page.keyboard.press("Escape");

    // One sentence: no 整理. A paragraph: the quiet key in the corner.
    const input = page.locator(".todo-new .todo-quick-input");
    await input.fill("明天下午3点交报告");
    assert.equal(await page.locator(".todo-quick-tidy").isVisible(), false);
    await input.fill(
      "王总：下周一前把报价单发给客户，周三下午两点约了他们开会。另外周五记得交本月报销。",
    );
    await page.locator(".todo-quick-tidy").waitFor();
    if (SHOTS) await page.screenshot({ path: SHOTS + "/ai-paste.png" });
    await page.locator(".todo-quick-tidy").click();
    await page.locator(".todo-drafts-list li").nth(2).waitFor();
    assert.equal(said("todo_plan").at(-1).mode, "split");
    // Nothing added yet; one unticked, then the rest added.
    assert.equal(said("todo_add").length, 0);
    await page
      .locator(".todo-drafts-list li")
      .nth(2)
      .locator("input")
      .uncheck();
    assert.equal(
      await page.locator(".todo-drafts-go").innerText(),
      "加入 2 件",
    );
    if (SHOTS) await page.screenshot({ path: SHOTS + "/ai-drafts.png" });
    await page.locator(".todo-drafts-go").click();
    await page.waitForFunction(
      () => !document.querySelector(".todo-drafts-list"),
    );
    assert.deepEqual(
      said("todo_add").map((a) => [a.fields.title, a.fields.time]),
      [
        ["把报价单发给客户", ""],
        ["和客户开会", "14:00"],
      ],
    );

    // 帮我拆一下, from the right-click menu, with the pet's mark.
    await row(page, "准备搬家").click({ button: "right" });
    const menu = page.locator(".todo-menu");
    assert.deepEqual(await menu.locator("button").allInnerTexts(), [
      "移到以后",
      "帮我拆一下",
      "编辑",
      "开始专注",
      "删除",
    ]);
    if (SHOTS) await page.screenshot({ path: SHOTS + "/ai-menu.png" });
    await page.getByRole("menuitem", { name: "帮我拆一下" }).click();
    await page
      .locator(".todo-break-slot .todo-drafts-list li")
      .nth(1)
      .waitFor();
    assert.equal(said("todo_plan").at(-1).mode, "break");
    await page.getByText("写下来就算完成").waitFor();
    if (SHOTS) await page.screenshot({ path: SHOTS + "/ai-break.png" });
    const before = said("todo_add").length;
    await page.locator(".todo-break-slot .todo-drafts-go").click();
    await page.getByRole("button", { name: "撤销" }).waitFor();
    // The steps take its place, in 今天, before it; the row then goes.
    assert.equal(said("todo_add").length, before + 2);
    assert.deepEqual(
      said("todo_move").map((m) => [m.today, m.before]),
      [
        [true, 1],
        [true, 1],
      ],
    );
    await page.waitForTimeout(4300);
    assert.deepEqual(said("todo_remove").at(-1), { id: 1 });
  } finally {
    await close();
  }
});

test("伙伴大脑没开：没有整理，菜单里没有帮我拆一下", async () => {
  const { page, close } = await open(false);
  try {
    await row(page, "准备搬家").waitFor();
    await page
      .locator(".todo-new .todo-quick-input")
      .fill(
        "王总：下周一前把报价单发给客户，周三下午两点约了他们开会。另外周五记得交本月报销。",
      );
    await page.waitForTimeout(300);
    assert.equal(await page.locator(".todo-quick-tidy").isVisible(), false);
    await row(page, "准备搬家").click({ button: "right" });
    const items = await page.locator(".todo-menu button").allInnerTexts();
    assert.ok(!items.includes("帮我拆一下"), items.join());
  } finally {
    await close();
  }
});
