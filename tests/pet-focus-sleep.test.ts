// 专注时宠物不睡: while a tomato runs the pet works beside you, so the
// "10 minutes untouched, take a nap" rule waits; a tomato starting wakes a
// napping pet; paused or over, it naps 10 untouched minutes later.
import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { chromium } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

const MIN = 60_000;

test("番茄钟进行中宠物不睡；开始专注会叫醒睡着的宠物；暂停后照常睡", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { port: 0, host: "127.0.0.1" },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const p = await browser.newPage();
    const atlas =
      "data:image/webp;base64," +
      readFileSync("examples/lizi/spritesheet.webp").toString("base64");
    const strip =
      "data:image/png;base64," +
      readFileSync("examples/lizi-sleep/actions/sleep.png").toString("base64");
    const idle = {
      phase: "idle",
      endsAt: 0,
      length: 0,
      pausedLeft: null,
      round: 0,
      longBreak: false,
      settings: { focusMinutes: 25, breakMinutes: 5, ambient: "", volume: 0 },
      week: [],
      now: 0,
    };
    let focus: Record<string, unknown> = idle;
    const event = await bubbleBridge(p, async (cmd, args) => {
      if (cmd === "get_state")
        return {
          pets: [{ id: "fixture", sleepStrip: "sleep.png", fingerprint: "f" }],
          custom: {},
          drafts: [],
          settings: { activeId: "fixture", visible: true, behaviors: {} },
        };
      if (cmd === "read_sprite") return args.sleep ? strip : atlas;
      if (cmd === "read_action_image") return strip;
      if (cmd === "companion_settings") return { enabled: true };
      if (cmd === "focus_state") return focus;
      if (cmd.includes("menu")) return [1, "menu"];
      if (cmd === "list_reminders") return [];
      if (cmd === "system_idle_seconds") return 0;
      return null;
    });
    await p.clock.install();
    await p.goto(server.resolvedUrls!.local[0] + "?fixture");
    await p.evaluate(async () => {
      const { SpritePlayer } = await import("/src/player.ts");
      const original = SpritePlayer.prototype.load;
      SpritePlayer.prototype.load = function (url) {
        (window as any).fixturePlayer = this;
        return original.call(this, url);
      };
      await (
        await import("/src/pet.ts")
      ).mountPet(document.querySelector("#app")!);
    });
    const action = () =>
      p.evaluate(() => (window as any).fixturePlayer.requestedAction);
    const setFocus = async (next: Record<string, unknown>) => {
      focus = next;
      await event("focus-changed", { state: next, moment: null });
      await p.clock.runFor(4000);
    };

    // Untouched for 10 minutes: a nap, as before.
    await p.clock.fastForward(10 * MIN + 1000);
    await p.clock.runFor(4000);
    assert.equal(await action(), "@sleep", "10 分钟没碰，照常睡");

    // A tomato starts: the napping pet wakes and works.
    const running = {
      ...idle,
      phase: "focus",
      length: 25 * MIN,
      endsAt: Date.now() + 25 * MIN,
    };
    await setFocus(running);
    assert.equal(await action(), "running", "开始专注叫醒它，回到工作姿势");

    // Long into the tomato, still untouched: it keeps working.
    await p.clock.fastForward(15 * MIN);
    await p.clock.runFor(4000);
    assert.equal(await action(), "running", "专注中不睡");

    // Paused: the working pose goes; the nap comes 10 untouched minutes
    // later, as at any other time.
    await setFocus({ ...running, pausedLeft: 10 * MIN });
    assert.notEqual(await action(), "@sleep", "刚暂停不马上睡");
    await p.clock.fastForward(10 * MIN);
    await p.clock.runFor(4000);
    assert.equal(await action(), "@sleep", "暂停后 10 分钟没碰，照常睡");

    // Break: pet settles into sleep to rest, then wakes when break ends.
    await setFocus(running);
    assert.equal(await action(), "running", "恢复专注继续工作");
    await setFocus({
      ...idle,
      phase: "break",
      length: 5 * MIN,
      endsAt: Date.now() + 5 * MIN,
    });
    assert.equal(await action(), "@sleep", "休息中进入打盹");
    await setFocus({ ...idle, phase: "rested" });
    assert.equal(await action(), "waiting", "休息结束自动醒来并进入等待");
    await setFocus(idle);
    assert.equal(await action(), "idle", "结束后回到待机");
  } finally {
    await browser.close();
    await server.close();
  }
});
