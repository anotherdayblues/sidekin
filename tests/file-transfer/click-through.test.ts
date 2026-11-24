import test from "node:test";
import assert from "node:assert/strict";
import { chromium } from "playwright";
import { createServer } from "vite";
import { bubbleBridge } from "../../scripts/qa/window.ts";
test("one cursor owner combines the current sleeping pose, file UI and a held file press", async () => {
  const server = await createServer({
    root: process.cwd() + "/apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({
      viewport: { width: 560, height: 400 },
    });
    let cursor = { x: 500, y: 300 };
    const ignores: boolean[] = [];
    await bubbleBridge(page, async (cmd, args) => {
      if (cmd.includes("set_ignore_cursor_events")) {
        ignores.push(args.value);
        return null;
      }
      if (cmd === "lab_cursor") return [cursor.x, cursor.y];
      if (cmd.includes("outer_position")) return { x: 0, y: 0 };
      if (cmd.includes("scale_factor")) return 1;
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    await page.evaluate(async () => {
      document.documentElement.dataset.petScene = "true";
      const canvas = document.createElement("canvas");
      canvas.style.cssText =
        "position:fixed;left:0;top:0;width:160px;height:174px";
      const file = document.createElement("button");
      file.className = "pile-top";
      file.style.cssText =
        "position:fixed;left:200px;top:40px;width:64px;height:78px";
      file.textContent = "file";
      document.body.append(canvas, file);
      const { petPointer } = await import("/src/petPointer.ts");
      (window as any).qaPointer = petPointer({
        canvas,
        player: {
          hit: () => true,
          shape: { hit: () => false },
          setGaze: () => {},
          requestedAction: "idle",
        } as any,
        drag: { active: false } as any,
        visible: () => true,
        paused: () => false,
        clickOnly: () => true,
        behavior: () => ({ gaze: false }) as any,
        gaze: () => ({ bubbleAt: null, gazeUntil: 0, lookAtBubble: false }),
        touch: () => {},
        input: () => {},
        hover: () => {},
        hovered: () => false,
        sync: () => {},
        begin: () => {},
        release: () => {},
        double: () => {},
        menu: async () => null as any,
      });
    });
    const poll = () =>
      page.evaluate(async () => {
        await (window as any).qaPointer.poll();
        (window as any).qaPointer.stop();
      });
    await poll();
    assert.deepEqual(
      ignores,
      [true],
      "transparent background must pass through under the shared owner",
    );
    cursor = { x: 80, y: 80 };
    await poll();
    assert.equal(
      ignores.at(-1),
      false,
      "the current sleeping pose remains clickable outside the idle mask",
    );
    cursor = { x: 220, y: 60 };
    await poll();
    assert.equal(ignores.at(-1), false, "file UI also receives clicks");
    cursor = { x: 500, y: 300 };
    await page.evaluate(() => (document.body.dataset.filePressed = "fixture"));
    await poll();
    assert.equal(
      ignores.at(-1),
      false,
      "a held file gesture keeps capture outside the stack",
    );
    await page.evaluate(() => delete document.body.dataset.filePressed);
    await poll();
    assert.equal(ignores.at(-1), true);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("回复仍在后台时，已过期的输入光标不能继续控制宠物目光", async () => {
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
    await bubbleBridge(page, async (cmd) => {
      if (cmd === "lab_cursor") return [500, 500];
      if (cmd.includes("scale_factor")) return 1;
      if (cmd.includes("position")) return { x: 500, y: 500 };
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    const writes = await page.evaluate(async () => {
      const { petPointer } = await import("/src/petPointer.ts");
      const canvas = document.createElement("canvas");
      document.body.append(canvas);
      const writes: unknown[] = [];
      let until = Date.now() + 1500;
      const pointer = petPointer({
        canvas,
        player: {
          requestedAction: "idle",
          setGaze: (p: unknown) => writes.push(p),
        },
        drag: { active: false },
        visible: () => true,
        paused: () => false,
        clickOnly: () => false,
        behavior: () => ({ gaze: true }),
        hovered: () => false,
        hover: () => {},
        input: () => {},
        gaze: () => ({
          bubbleAt: { x: 14, y: 24 },
          gazeUntil: until,
          lookAtBubble: true,
        }),
      } as any);
      await pointer.poll();
      pointer.stop();
      until = 0;
      await pointer.poll();
      pointer.stop();
      return writes;
    });
    assert.ok(writes[0]);
    assert.equal(writes[1], null);
  } finally {
    await browser.close();
    await server.close();
  }
});

test("鼠标由外壳推送：不动时宠物窗口不再向外壳问位置，动了才判断", async () => {
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
      viewport: { width: 560, height: 400 },
    });
    const calls: string[] = [];
    const ignores: boolean[] = [];
    const nears: boolean[] = [];
    const push = await bubbleBridge(page, async (cmd, args) => {
      calls.push(cmd);
      if (cmd.includes("set_ignore_cursor_events")) {
        ignores.push(args.value);
        return null;
      }
      if (cmd === "lab_cursor_near") {
        nears.push(args.near);
        return null;
      }
      if (cmd === "lab_cursor") return [2000, 2000];
      if (cmd.includes("outer_position")) return { x: 0, y: 0 };
      if (cmd.includes("scale_factor")) return 1;
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.style.cssText =
        "position:fixed;left:0;top:0;width:160px;height:174px";
      document.body.append(canvas);
      const { petPointer } = await import("/src/petPointer.ts");
      (window as any).qaInputs = 0;
      (window as any).qaPointer = petPointer({
        canvas,
        player: {
          hit: () => true,
          setGaze: () => {},
          requestedAction: "idle",
        } as any,
        drag: { active: false } as any,
        visible: () => true,
        paused: () => false,
        clickOnly: () => true,
        behavior: () => ({ gaze: false }) as any,
        gaze: () => ({ bubbleAt: null, gazeUntil: 0 }),
        touch: () => {},
        input: () => (window as any).qaInputs++,
        hover: () => {},
        hovered: () => false,
        sync: () => {},
        begin: () => {},
        release: () => {},
        double: () => {},
        menu: async () => null as any,
      } as any);
      await (window as any).qaPointer.poll();
    });
    assert.deepEqual(ignores, [true], "far away: clicks pass through");
    assert.deepEqual(
      nears,
      [false],
      "far away: the shell is told to slow down",
    );
    // A still cursor: only local checks, no calls to the shell.
    calls.length = 0;
    await page.waitForTimeout(1200);
    assert.deepEqual(calls, []);
    // A push near the pet is judged at once and speeds the shell up.
    await push("pet-cursor", { x: 80, y: 80 });
    await page.waitForTimeout(50);
    assert.equal(ignores.at(-1), false, "over the pet: clickable");
    assert.equal(nears.at(-1), true);
    assert.equal(await page.evaluate(() => (window as any).qaInputs), 1);
    // The same place again is not new input.
    await push("pet-cursor", { x: 80, y: 80 });
    assert.equal(await page.evaluate(() => (window as any).qaInputs), 1);
    // A window move is pushed too: the cursor is now outside the pet.
    await push("tauri://move", { x: 300, y: 0 });
    await push("pet-cursor", { x: 81, y: 80 });
    await page.waitForTimeout(50);
    assert.equal(ignores.at(-1), true);
    await page.evaluate(() => (window as any).qaPointer.stop());
  } finally {
    await browser.close();
    await server.close();
  }
});

test("拖完松手：宿主挪了窗口但没发移动通知，宠物也要马上接得到下一次按下", async () => {
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
      viewport: { width: 560, height: 400 },
    });
    const ignores: boolean[] = [];
    // Where the host has put the window; drag_pet moves it, no move event.
    let at = { x: 0, y: 0 };
    const push = await bubbleBridge(page, async (cmd, args) => {
      if (cmd.includes("set_ignore_cursor_events")) {
        ignores.push(args.value);
        return null;
      }
      if (cmd === "drag_pet") {
        if (args.release) at = { x: 300, y: 0 };
        return null;
      }
      if (cmd === "lab_cursor") return [80, 80];
      if (cmd.includes("outer_position")) return at;
      if (cmd.includes("scale_factor")) return 1;
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    await page.evaluate(async () => {
      const canvas = document.createElement("canvas");
      canvas.style.cssText =
        "position:fixed;left:0;top:0;width:160px;height:174px";
      document.body.append(canvas);
      const { petPointer } = await import("/src/petPointer.ts");
      let moved = false;
      (window as any).qaPointer = petPointer({
        canvas,
        player: {
          hit: () => true,
          endSustained: () => false,
          setGaze: () => {},
          requestedAction: "idle",
        } as any,
        drag: {
          active: false,
          get hasMoved() {
            return moved;
          },
          begin() {
            this.active = true;
          },
          moved() {
            moved = true;
          },
          end() {
            this.active = false;
            return moved;
          },
        } as any,
        visible: () => true,
        paused: () => false,
        clickOnly: () => false,
        gaze: () => ({ bubbleAt: null, gazeUntil: 0 }),
        touch: () => {},
        input: () => {},
        hover: () => {},
        hovered: () => false,
        sync: () => {},
        begin: () => {},
        release: () => {},
        double: () => {},
        menu: async () => null as any,
      } as any);
      await (window as any).qaPointer.poll();
    });
    // The window starts taking clicks; only a change is sent.
    const ignoring = () => ignores.at(-1) ?? false;
    assert.equal(ignoring(), false, "over the pet: clickable");
    // A drag: the host moves the window by 300 and sends no move event.
    await page.mouse.move(80, 80);
    await page.mouse.down();
    await page.mouse.move(120, 90, { steps: 4 });
    await page.mouse.up();
    // The cursor is over the pet where it now is.
    await push("pet-cursor", { x: 380, y: 80 });
    await page.waitForTimeout(150);
    assert.equal(
      ignoring(),
      false,
      "right after a drag the pet takes the next press",
    );
    await page.evaluate(() => (window as any).qaPointer.stop());
  } finally {
    await browser.close();
    await server.close();
  }
});
