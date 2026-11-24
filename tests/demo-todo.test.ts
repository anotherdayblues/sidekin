// The 待办 and 到点提醒 demos play through to their ends, drawn with the real
// to-do card: a line with its time understood, a paragraph read into three
// to-dos and added; the alert with 完成 and 稍后提醒's list.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright";

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

async function demo(id: string) {
  const page = await browser.newPage({ viewport: { width: 600, height: 420 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.goto(`${server.resolvedUrls!.local[0]}?demo=${id}&skin=native`);
  return { page, errors };
}

test("待办演示：右键选待办，一句话认出时间，粘贴一段话整理成三件加进来", async () => {
  const { page, errors } = await demo("todo");
  const part = (name: string) => page.locator(`[data-part="${name}"]`);
  await part("chip").waitFor({ state: "visible", timeout: 6000 });
  assert.equal(
    await part("draft").locator("mark").textContent(),
    "明天下午3点",
  );
  await part("draft-list").waitFor({ state: "visible", timeout: 6000 });
  assert.equal(await part("draft-list").locator("li").count(), 3);
  await page.getByText("加好了 3 件").waitFor({ timeout: 4000 });
  assert.deepEqual(errors, []);
  await page.close();
});

test("到点提醒演示：到点弹出待办提醒，完成或稍后提醒，稍后有四个时间", async () => {
  const { page, errors } = await demo("reminder");
  const part = (name: string) => page.locator(`[data-part="${name}"]`);
  await part("due").waitFor({ state: "visible", timeout: 7000 });
  assert.equal(
    await part("due").locator(".todo-primary").textContent(),
    "完成",
  );
  await part("snoozes").waitFor({ state: "visible", timeout: 4000 });
  assert.deepEqual(await part("snoozes").locator("small").allTextContents(), [
    "15:10",
    "16:00",
    "20:00",
    "9:00",
  ]);
  // The old card (知道了 / 10 分钟后再提醒) is gone.
  assert.equal(await page.locator("[data-notice]").count(), 0);
  assert.deepEqual(errors, []);
  await page.close();
});
