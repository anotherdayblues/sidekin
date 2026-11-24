// 主窗口关掉 5 分钟后释放 (plan/22 M1): asked by the host, the page lets
// itself go only if nothing would be lost.
import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

test("主窗口：有没保存的字、开着的对话框或还在做的事时不释放，否则释放", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    const calls: string[] = [];
    const event = await bubbleBridge(page, async (cmd) => {
      calls.push(cmd);
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    await page.evaluate(async () => {
      document.body.insertAdjacentHTML(
        "beforeend",
        `<form id="f"><input id="name" value="小猪"></form><input id="q" type="search"><dialog id="d">x</dialog>`,
      );
      document.getElementById("f")!.addEventListener("submit", (e) => {
        e.preventDefault();
      });
      const { keepStudio } = await import("/src/studioKeep.ts");
      const keep = keepStudio();
      (window as any).qaKeep = keep;
      keep.ready();
    });
    const released = async () => {
      calls.length = 0;
      await event("studio-release-check", null);
      await page.waitForTimeout(50);
      return calls.includes("studio_release");
    };
    assert.ok(calls.includes("studio_ready"), "the page says it is ready");
    assert.equal(await released(), true, "nothing open: let go");

    await page.locator("#q").fill("合同编号");
    assert.equal(
      await released(),
      true,
      "search filter input never blocks release",
    );

    await page.locator("#name").fill("小猪猪");
    assert.equal(await released(), false, "a field typed into: kept");
    await page.evaluate(() =>
      (document.getElementById("f") as HTMLFormElement).requestSubmit(),
    );
    assert.equal(
      await released(),
      true,
      "submitting a form clears its dirty fields automatically",
    );
    await page.locator("#name").fill("小猪猪2");
    assert.equal(
      await released(),
      false,
      "editing again after submit protects the new change",
    );
    await page.locator("#name").fill("小猪猪");
    assert.equal(await released(), true, "typed back to submitted value: let go");

    await page.evaluate(() =>
      (document.getElementById("d") as HTMLDialogElement).showModal(),
    );
    assert.equal(await released(), false, "a dialog open: kept");
    await page.evaluate(() =>
      (document.getElementById("d") as HTMLDialogElement).close(),
    );

    await page.evaluate(() => {
      let done!: () => void;
      (window as any).qaDone = () => done();
      (window as any).qaKeep.track(new Promise<void>((r) => (done = r)));
    });
    assert.equal(await released(), false, "a save still running: kept");
    await page.evaluate(() => (window as any).qaDone());
    assert.equal(await released(), true);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("聊天侧栏：空闲时响应释放，有未发草稿时保留不释放", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    const calls: string[] = [];
    const event = await bubbleBridge(page, async (cmd) => {
      calls.push(cmd);
      if (cmd === "get_state")
        return { pets: [], settings: { theme: "day", skin: "studio" } };
      if (cmd === "current_chat_topic") return { id: null, turns: [] };
      if (cmd === "chat_topics") return [];
      if (cmd === "chat_window_state")
        return { pinned: true, translations: false };
      if (cmd === "take_translations_request") return false;
      if (cmd === "take_chat_turn") return null;
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?chat");
    await page.locator(".chat-composer textarea").waitFor();
    while (!calls.includes("take_translations_request"))
      await new Promise((r) => setTimeout(r, 20));
    const released = async () => {
      calls.length = 0;
      await event("chat-release-check", null);
      await page.waitForTimeout(50);
      return calls.includes("chat_window_release");
    };
    assert.equal(await released(), true, "idle chat panel: let go");
    await page.locator(".chat-composer textarea").fill("还没发送的草稿");
    assert.equal(await released(), false, "unsent draft: kept");
    await page.locator(".chat-composer textarea").fill("");
    assert.equal(await released(), true, "cleared draft: let go");
  } finally {
    await browser.close();
    await server.close();
  }
});
