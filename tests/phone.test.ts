// 手机传文件 in the bubble (plan/20): the QR code, a phone's question and its
// text, each answer going to the host. Checked through the real page with
// the host faked.
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

async function bubble() {
  const page = await browser.newPage();
  await page.emulateMedia({ reducedMotion: "reduce" });
  const calls: [string, any][] = [];
  const event = await bubbleBridge(page, async (cmd, p) => {
    calls.push([cmd, p]);
    if (cmd === "get_state")
      return { settings: { theme: "day", skin: "studio" } };
    if (cmd === "companion_settings") return { enabled: true };
    if (cmd === "pending_reminders") return [];
    if (cmd === "phone_renew")
      return {
        running: true,
        qr: "<svg data-renewed></svg>",
        url: "http://x/t/new/",
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
    return calls.find(([c]) => c === cmd)![1];
  };
  return { page, event, calls, waitCall };
}

test("二维码：第一次带防火墙说明；“连不上”点开才列原因；连上后二维码还在，几台手机都列出来；停止收起气泡", async () => {
  const b = await bubble();
  await b.event("bubble-open", {
    mode: "phone",
    phone: {
      running: true,
      qr: "<svg data-first></svg>",
      url: "http://x/t/a/",
      firstTime: true,
    },
    at: 1,
  });
  await b.page.waitForSelector(
    ".bubble-card[data-state='phone'] .phone-qr svg[data-first]",
  );
  assert.equal(await b.page.locator(".phone-note").count(), 1);
  // The reasons stay folded until asked for.
  assert.equal(await b.page.locator("[data-phone-help]").isHidden(), true);
  await b.page.locator("[data-phone-act='help']").click();
  assert.equal(await b.page.locator("[data-phone-help]").isVisible(), true);
  assert.equal(await b.page.locator("[data-phone-help] li").count(), 3);
  // Phones that open the page are listed by their own names; the code
  // stays for the next one, and an open list of reasons stays open.
  await b.event("phone-connected", { device: "Pixel 7" });
  await b.event("phone-connected", { device: "iPhone" });
  await b.event("phone-connected", { device: "Pixel 7" });
  await b.page.waitForFunction(
    () => document.querySelectorAll("[data-phone-linked] li").length === 2,
  );
  assert.match(
    (await b.page.locator("[data-phone-linked]").textContent())!,
    /Pixel 7 已连上.*iPhone 已连上/,
  );
  assert.equal(await b.page.locator(".phone-qr svg").count(), 1);
  assert.equal(await b.page.locator("[data-phone-help]").isVisible(), true);
  // Stopped elsewhere: the code goes away with the bubble.
  await b.event("phone-changed", { running: false });
  await b.waitCall("hide_bubble");
  await b.page.close();
});

test("手机来问：说清几张照片几个视频；“这台手机以后直接收”交给宿主", async () => {
  const b = await bubble();
  const offer = {
    id: "o1",
    device: "iPhone",
    files: [
      { name: "a.HEIC", size: 2_000_000 },
      { name: "b.jpg", size: 1_000_000 },
      { name: "c.MOV", size: 3_000_000 },
    ],
  };
  await b.event("bubble-open", { mode: "phone-offer", offer, at: 1 });
  await b.page.waitForSelector("[data-phone][data-show='offer']");
  assert.match(
    (await b.page.locator("[data-phone] p").textContent())!,
    /iPhone想传2 张照片、1 个视频（5\.7 MB），收下吗？/,
  );
  await b.page.locator("[data-phone-answer='trust']").click();
  assert.deepEqual(await b.waitCall("phone_answer"), {
    id: "o1",
    answer: "trust",
  });
  await b.waitCall("hide_bubble");
  await b.page.close();
});

test("手机传来的链接：显示原文，带复制和打开；打开交给宿主", async () => {
  const b = await bubble();
  await b.event("bubble-open", {
    mode: "phone-text",
    text: "https://example.com/a",
    link: "https://example.com/a",
    at: 1,
  });
  await b.page.waitForSelector("[data-phone][data-show='text'] blockquote");
  assert.equal(
    await b.page.locator("[data-phone] blockquote").textContent(),
    "https://example.com/a",
  );
  await b.page.locator("[data-phone-act='open']").click();
  assert.deepEqual(await b.waitCall("open_bubble_link"), {
    url: "https://example.com/a",
  });
  await b.page.close();
});

test("电脑没连网：不出二维码，说清楚；连上后二维码自己出现", async () => {
  const b = await bubble();
  await b.event("bubble-open", {
    mode: "phone",
    phone: { running: true, noNetwork: true },
    at: 1,
  });
  await b.page.waitForSelector("[data-phone][data-show='qr']");
  assert.equal(await b.page.locator(".phone-qr").count(), 0);
  assert.match(
    (await b.page.locator("[data-phone] p").first().textContent())!,
    /还没连上/,
  );
  await b.event("phone-changed", {
    running: true,
    qr: "<svg data-later></svg>",
    url: "http://x/t/a/",
  });
  await b.page.waitForSelector(".phone-qr svg[data-later]");
  await b.page.close();
});
