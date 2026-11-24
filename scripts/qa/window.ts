// A private browser context showing this repository's UI only. All traffic
// except the explicitly supplied local dev server is blocked.
import { chromium, type Page } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
export async function windowQA(stage: string, name = "acceptance") {
  const qa = await fs.realpath(process.env.QA!);
  if (
    process.env.COMPANION_QA_GUARDED !== "1" ||
    path.dirname(qa) !== (await fs.realpath("runs"))
  )
    throw Error("需要隔离验收");
  const url = new URL(process.env.QA_URL ?? "http://127.0.0.1:1447");
  if (url.hostname !== "127.0.0.1") throw Error("只允许本机测试页");
  const browser = await chromium.launch({
    channel: "chrome",
    args: ["--disable-background-networking"],
  });
  const ctx = await browser.newContext({
    viewport: { width: 980, height: 680 },
  });
  await ctx.route(/^https?:/, (r) =>
    new URL(r.request().url()).origin === url.origin ? r.continue() : r.abort(),
  );
  const page = await ctx.newPage();
  const folder = path.join(qa, "frames-" + stage + "-" + name);
  await fs.mkdir(folder, { recursive: true });
  let seq = 0;
  async function frames(n = 8) {
    for (let i = 0; i < n; i++) {
      await page.screenshot({
        path: path.join(folder, String(++seq).padStart(5, "0") + ".png"),
      });
      await page.waitForTimeout(65);
    }
  }
  async function finish() {
    const out = "captures/brain-stage" + stage;
    await fs.mkdir(out, { recursive: true });
    execFileSync("ffmpeg", [
      "-y",
      "-v",
      "error",
      "-framerate",
      "8",
      "-i",
      folder + "/%05d.png",
      "-frames:v",
      String(seq),
      "-c:v",
      "libx264",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      out + "/" + name + ".mp4",
    ]);
    await browser.close();
  }
  return { page, browser, url, frames, finish };
}
export async function bubbleBridge(
  page: Page,
  handle: (cmd: string, p: any) => Promise<any>,
) {
  await page.exposeBinding("qaInvoke", (_, cmd, p) => handle(cmd, p));
  const setup = () => {
    const w = window as any;
    const handlers = new Map<number, Function>(),
      events = new Map<string, number[]>();
    let id = 0;
    w.isTauri = true;
    w.__TAURI_INTERNALS__ = {
      metadata: {
        currentWindow: { label: "studio" },
        currentWebview: { label: "studio" },
      },
      transformCallback: (fn: Function) => {
        handlers.set(++id, fn);
        return id;
      },
      invoke: (cmd: string, p: any) => {
        if (cmd === "plugin:event|listen") {
          const ids = events.get(p.event) ?? [];
          ids.push(p.handler);
          events.set(p.event, ids);
          return Promise.resolve(p.handler);
        }
        // Pages wait for their language before anything else (plan/15).
        if (cmd === "app_language") return Promise.resolve("zh");
        return w.qaInvoke(cmd, p);
      },
    };
    w.qaEvent = (event: string, payload: any) => {
      for (const id of events.get(event) ?? [])
        handlers.get(id)?.({ event, id, payload });
    };
  };
  await page.addInitScript({
    content: "globalThis.__name=(f)=>f;(" + setup.toString() + ")()",
  });
  return (event: string, payload: any) =>
    page.evaluate(
      ([event, payload]) => (window as any).qaEvent(event, payload),
      [event, payload],
    );
}
