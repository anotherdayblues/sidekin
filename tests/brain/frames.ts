// Sample the existing studio pet canvas while a packaged brain streams on the same machine.
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { fakeModel } from "./fake-model.ts";
import { launch } from "./client.ts";

if (!process.env.BRAIN_TEST_BIN) throw new Error("请指定 BRAIN_TEST_BIN");
const browser = await chromium.launch({ channel: "chrome" });
const server = await fakeModel([{ chunks: Array(650).fill("栗") }]);
const brain = launch();
try {
  const page = await browser.newPage({
    viewport: { width: 1080, height: 840 },
  });
  const url = process.argv[2] || "http://127.0.0.1:1420";
  await page.route(/^https?:/, (route) =>
    new URL(route.request().url()).origin === new URL(url).origin
      ? route.continue()
      : route.abort(),
  );
  await page.goto(url);
  await page.waitForFunction(() => window.__studio);
  await page.evaluate(async () => {
    window.__studio.load("full");
    await window.__studio.ready();
  });
  await page.locator("canvas#stage").waitFor();
  assert.ok(
    (
      await brain.request("initialize", {
        baseUrl: server.baseUrl,
        apiKey: "fixture",
        model: "fixture",
      })
    ).result.ready,
  );
  const sample = async () => {
    const deadline = performance.now() + 5000;
    while (!server.requests.length) {
      if (performance.now() > deadline) throw new Error("模型未收到请求");
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    return page.evaluate(`new Promise(resolve => {
    let first = 0, previous = 0, count = 0, maxGapMs = 0;
    function frame(now) {
      if (!first) first = now;
      else { count++; maxGapMs = Math.max(maxGapMs, now - previous); }
      previous = now;
      if (now - first >= 2000) resolve({ fps: count * 1000 / (now - first), maxGapMs });
      else requestAnimationFrame(frame);
    }
    requestAnimationFrame(frame);
    })`);
  };
  const [frames, chat] = await Promise.all([
    sample(),
    brain.request("chat", { text: "测试持续逐字输出" }),
  ]);
  assert.equal(chat.result.text.length, 650);
  console.log(JSON.stringify(frames));
} finally {
  brain.close();
  server.close();
  await browser.close();
}
