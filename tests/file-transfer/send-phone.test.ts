import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";

// 发到手机 in the expanded stack: the chosen files, or all when none is chosen.
test("the panel's 发到手机 sends the chosen files, or all of them", async () => {
  const server = await createServer({
    root: process.cwd() + "/apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 760, height: 400 } });
    await page.addInitScript({
      content: `globalThis.__name=f=>f;window.sent=[];window.labInvoke=async(cmd,args)=>{if(cmd==='lab_load')return {state:{items:[],lastRemoved:[]},positions:{},layoutVersion:2};if(cmd==='phone_send'){window.sent.push(args.paths);return {sent:args.paths.length,open:true};}};`,
    });
    await page.goto(server.resolvedUrls!.local[0] + "?files");
    await page.waitForFunction(() => Boolean((window as any).labView));
    await page.evaluate(() =>
      window.dispatchEvent(
        new CustomEvent("lab-drop", {
          detail: { paths: ["/f/a.pdf", "/f/b.png", "/f/c.txt"], x: 470, y: 320 },
        }),
      ),
    );
    await page.locator(".pile-top").click();
    await page.locator(".send-phone").click();
    await page.locator('.file[data-path="/f/b.png"]').click();
    await page.locator(".send-phone").click();
    assert.deepEqual(await page.evaluate(() => (window as any).sent), [
      ["/f/a.pdf", "/f/b.png", "/f/c.txt"],
      ["/f/b.png"],
    ]);
    // Sent with the page open on the phone: the notice says so.
    assert.match(await page.locator(".notice").textContent() ?? "", /手机|phone/);
    if (process.env.SHOT)
      await page.screenshot({ path: process.env.SHOT, scale: "device" });
  } finally {
    await browser.close();
    await server.close();
  }
});
