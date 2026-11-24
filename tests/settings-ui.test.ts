import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { createServer } from "vite";
import { chromium } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";
import { FIXTURES } from "../apps/desktop/src/fixtures.ts";
import { defaults } from "../apps/shared/companion.ts";

// Each case uses a private browser and only synthetic IPC responses. No screenshots.
const allowed = !!process.env.QA || process.env.GITHUB_ACTIONS === "true";
async function waitForSave(count: () => number, expected: number) {
  const deadline = Date.now() + 30_000;
  while (count() < expected) {
    assert.ok(Date.now() < deadline, `save ${expected} did not start`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
async function fixture(
  handle: (cmd: string, p: any) => Promise<any>,
  usage?: object,
) {
  const qa = process.env.QA ?? path.resolve("runs/ci-settings-tests");
  const tmp = path.join(qa, "ui-tmp");
  await fs.mkdir(tmp, { recursive: true });
  const vite = await createServer({
    root: path.resolve("apps/desktop"),
    configLoader: "runner",
    cacheDir: path.join(qa, "ui-vite"),
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await vite.listen();
  const url = vite.resolvedUrls!.local[0];
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  const close = async () => {
    await browser?.close();
    await vite.close();
  };
  try {
    browser = await chromium.launch({
      channel: "chrome",
      args: ["--disable-background-networking"],
      env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
    });
    const context = await browser.newContext({
      viewport: { width: 1080, height: 780 },
      reducedMotion: "reduce",
    });
    await context.route(/^https?:/, (r) =>
      new URL(r.request().url()).origin === new URL(url).origin
        ? r.continue()
        : r.abort(),
    );
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    await bubbleBridge(page, async (cmd, p) => {
      if (cmd === "get_state")
        return {
          pets: [],
          drafts: [],
          custom: {},
          settings: {
            activeId: null,
            visible: false,
            paused: false,
            size: 160,
            position: null,
            behaviors: {},
            theme: "day",
            skin: "studio",
          },
        };
      if (cmd === "get_persona")
        return { petId: "fixture", text: "", defaultText: "" };
      if (cmd === "memory_view")
        return {
          petId: "fixture",
          user: { entries: [], used: 0, limit: 2000 },
          notes: { entries: [], used: 0, limit: 2200 },
        };
      if (cmd === "companion_usage") return usage ?? {};
      if (cmd === "tool_cards") return { pending: [], tools: [] };
      if (cmd === "external_config") return { servers: [], grants: [] };
      if (
        ["list_documents", "list_reminders", "pending_reminders"].includes(cmd)
      )
        return [];
      if (["screen_access", "selection_access"].includes(cmd)) return true;
      return handle(cmd, p);
    });
    await page.goto(url);
    await page.locator('#blocks [data-block="settings"]').click();
    await page.locator('[name="memory"]').waitFor({ state: "attached" });
    return {
      page,
      errors,
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}

test(
  "settings saves wait and merge on the previous successful result",
  { skip: !allowed },
  async () => {
    let settings = { ...defaults, enabled: true, modelVerified: true };
    let calls = 0,
      release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const f = await fixture(async (cmd, p) => {
      if (cmd === "companion_settings") return settings;
      if (cmd === "save_companion") {
        calls++;
        if (calls === 1) await first;
        settings = { ...settings, ...p.settings };
        if (p.searchKey)
          settings.search = {
            ...settings.search!,
            credentialRef: "fixture-confirmed",
          };
        return settings;
      }
      return null;
    });
    try {
      await f.page.locator("[data-search]").selectOption("brave");
      await f.page.locator("[data-search-key]").fill("fixture-only");
      await f.page.locator("[data-save-online]").click();
      await f.page.waitForFunction(
        () =>
          document
            .querySelector("[data-online-status]")
            ?.textContent?.includes("正在") ||
          document
            .querySelector('.companion-page output[role="status"]')
            ?.textContent?.includes("保存中"),
      );
      await f.page.evaluate(() => {
        const e = document.querySelector('[name="memory"]') as HTMLInputElement;
        e.checked = false;
        e.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await f.page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 400)),
      );
      assert.ok(
        await f.page.locator("[data-search-key]").isDisabled(),
        "the tested credentials must stay fixed until the response",
      );
      assert.equal(calls, 1, "second save must wait for the first response");
      release();
      await f.page.waitForFunction(
        () =>
          document.querySelector('.companion-page output[role="status"]')
            ?.textContent === "已保存",
      );
      await waitForSave(() => calls, 2);
      assert.equal(calls, 2);
      assert.equal(settings.memory, false);
      assert.equal(settings.search?.provider, "brave");
      assert.equal(settings.search?.credentialRef, "fixture-confirmed");
      assert.deepEqual(f.errors, []);
    } finally {
      release();
      await f.close();
    }
  },
);

test(
  "failed disk save shows failure and leaves the selected skin unchanged",
  { skip: !allowed },
  async () => {
    const latest = { ...FIXTURES.empty.settings, size: 175 };
    let submittedSize: number | undefined;
    const f = await fixture(async (cmd, args) => {
      if (cmd === "companion_settings")
        return { ...defaults, enabled: true, modelVerified: true };
      if (cmd === "get_settings") return latest;
      if (cmd === "save_settings") {
        submittedSize = args.settings.size;
        throw Error("fixture-write-failed");
      }
      return null;
    });
    try {
      await f.page.locator('.skin-card[data-skin="studio"]').click();
      await f.page.waitForTimeout(500);
      assert.equal(submittedSize, latest.size);
      assert.match(
        await f.page.locator("#lcd").innerText(),
        /fixture-write-failed/,
      );
      assert.equal(
        await f.page.locator("html").getAttribute("data-skin"),
        "native",
      );
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  },
);

test(
  "a failed save keeps its draft and does not block the next queued edit",
  { skip: !allowed },
  async () => {
    let settings = { ...defaults, enabled: true, modelVerified: true };
    let calls = 0,
      release!: () => void;
    const first = new Promise<void>((r) => (release = r));
    const f = await fixture(async (cmd, p) => {
      if (cmd === "companion_settings") return settings;
      if (cmd === "save_companion") {
        calls++;
        if (calls === 1) {
          await first;
          throw Error("fixture-save-failed");
        }
        settings = { ...settings, ...p.settings };
        return settings;
      }
      return null;
    });
    try {
      await f.page.locator("[data-search]").selectOption("brave");
      await f.page.locator("[data-search-key]").fill("fixture-only");
      await f.page.locator("[data-save-online]").click();
      await f.page.waitForFunction(() =>
        document
          .querySelector("[data-online-status]")
          ?.textContent?.includes("正在"),
      );
      await f.page.evaluate(() => {
        const e = document.querySelector('[name="memory"]') as HTMLInputElement;
        e.checked = false;
        e.dispatchEvent(new Event("change", { bubbles: true }));
      });
      await f.page.evaluate(
        () => new Promise((resolve) => setTimeout(resolve, 400)),
      );
      assert.equal(calls, 1);
      release();
      await waitForSave(() => calls, 2);
      assert.equal(calls, 2);
      assert.equal(settings.memory, false);
      assert.equal(settings.search, null);
      assert.match(
        await f.page.locator("[data-online-status]").innerText(),
        /fixture-save-failed/,
      );
      assert.ok(await f.page.locator("[data-search-key]").inputValue());
      assert.deepEqual(f.errors, []);
    } finally {
      release();
      await f.close();
    }
  },
);

test(
  "only the switch changes the setting and Space toggles it",
  { skip: !allowed },
  async () => {
    let settings = { ...defaults, enabled: true, modelVerified: true };
    const f = await fixture(async (cmd, p) => {
      if (cmd === "save_companion") settings = { ...settings, ...p.settings };
      return ["companion_settings", "save_companion"].includes(cmd)
        ? settings
        : null;
    });
    try {
      const input = f.page.locator('[name="memory"]');
      const initial = await input.isChecked();
      await f.page
        .getByText("记忆与旧对话搜索", { exact: true })
        .click({ position: { x: 5, y: 10 } });
      assert.equal(
        await input.isChecked(),
        initial,
        "clicking the text must leave the setting alone",
      );
      const control = f.page.getByRole("switch", { name: "记忆与旧对话搜索" });
      await control.click();
      assert.equal(await control.isChecked(), !initial);
      await control.press("Space");
      assert.equal(await control.isChecked(), initial);
    } finally {
      await f.close();
    }
  },
);

test("用量页只显示今天和本月的三项合计", { skip: !allowed }, async () => {
  const f = await fixture(
    async (cmd) => (cmd === "companion_settings" ? defaults : null),
    {
      today: {
        tokens: 1000,
        cacheRead: null,
        costUsd: 0.001,
        missingCache: true,
      },
      month: {
        tokens: 1200,
        cacheRead: 0,
        costUsd: 1,
        missingCache: true,
        missingCost: true,
      },
    },
  );
  try {
    const rows = f.page.locator("[data-usage] tr");
    await rows.nth(3).waitFor({ state: "attached" });
    assert.deepEqual(await rows.nth(0).locator("th").allTextContents(), [
      "",
      "今天",
      "本月",
    ]);
    assert.deepEqual(await rows.nth(1).locator("th,td").allTextContents(), [
      "总 token",
      "1,000",
      "1,200",
    ]);
    assert.deepEqual(await rows.nth(2).locator("th,td").allTextContents(), [
      "其中缓存命中",
      "未报告",
      "0部分统计",
    ]);
    assert.deepEqual(await rows.nth(3).locator("th,td").allTextContents(), [
      "估算费用",
      "低于 ¥0.01",
      "¥6.67部分统计",
    ]);
    assert.equal(await rows.count(), 4);
  } finally {
    await f.close();
  }
});

test(
  "用量小票跟随当前宠物，没有选中宠物时隐藏头像",
  { skip: !allowed },
  async () => {
    const images: Record<string, string> = {};
    const f = await fixture(async (cmd, p) => {
      if (cmd === "read_sprite") return images[p.id];
      return cmd === "companion_settings" ? defaults : null;
    });
    try {
      for (const [id, color] of [
        ["lizi", "red"],
        ["tuanzi", "blue"],
      ]) {
        images[id] = await f.page.evaluate((color) => {
          const c = document.createElement("canvas");
          c.width = 192;
          c.height = 208;
          const ctx = c.getContext("2d")!;
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 192, 208);
          return c.toDataURL();
        }, color);
      }
      const portrait = f.page.locator(".receipt-pet");
      for (const [id, name, channel] of [
        ["lizi", "栗子", 0],
        ["tuanzi", "团子", 2],
      ] as const) {
        const snapshot = {
          ...FIXTURES.full,
          drafts: [],
          custom: {},
          settings: { ...FIXTURES.full.settings, activeId: id },
        };
        await f.page.evaluate(
          (s) => (window as any).qaEvent("library-changed", s),
          snapshot,
        );
        await f.page.waitForFunction(
          (name) =>
            document
              .querySelector(".receipt-pet:not([hidden])")
              ?.getAttribute("aria-label") === name,
          name,
        );
        assert.equal(
          await portrait.evaluate(
            (el, channel) =>
              (el as HTMLCanvasElement)
                .getContext("2d")!
                .getImageData(48, 52, 1, 1).data[channel],
            channel,
          ),
          255,
        );
      }
      await f.page.evaluate(
        (s) => (window as any).qaEvent("library-changed", s),
        FIXTURES.empty,
      );
      assert.equal(await portrait.getAttribute("hidden"), "");
    } finally {
      await f.close();
    }
  },
);

test(
  "通用开关读写系统启动项，失败时恢复；跟随仅在展示窗内生效",
  { skip: !allowed },
  async () => {
    let enabled = false,
      fail = false;
    const f = await fixture(async (cmd, p) => {
      if (cmd === "companion_settings") return defaults;
      if (cmd === "login_start_enabled") return enabled;
      if (cmd === "set_login_start") {
        if (fail) throw Error("fixture denied");
        return (enabled = p.enabled);
      }
      return null;
    });
    try {
      const toggle = f.page.locator("#set-general input");
      assert.equal(await toggle.isChecked(), false);
      await toggle.check();
      await f.page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>("#set-general input")!
            .disabled,
      );
      assert.equal(enabled, true);
      fail = true;
      await toggle.click();
      await f.page.waitForFunction(() =>
        document
          .querySelector("#set-general small")!
          .textContent?.includes("失败"),
      );
      assert.equal(await toggle.isChecked(), true);
      fail = false;
      await toggle.uncheck();
      await f.page.waitForFunction(
        () =>
          !document.querySelector<HTMLInputElement>("#set-general input")!
            .disabled,
      );
      assert.equal(enabled, false);

      await f.page.locator('#blocks [data-block="pet"]').click();
      const changes = await f.page.evaluate(async () => {
        const modulePath = "/src/player.ts";
        const { SpritePlayer } = await import(modulePath);
        const gaze: boolean[] = [];
        const original = SpritePlayer.prototype.setGaze;
        SpritePlayer.prototype.setGaze = (point: unknown) =>
          gaze.push(point !== null);
        try {
          const frame = document.querySelector("#window")!;
          const move = () =>
            new PointerEvent("pointermove", {
              bubbles: true,
              clientX: 80,
              clientY: 100,
            });
          document.body.dispatchEvent(move());
          frame.dispatchEvent(move());
          frame.dispatchEvent(new PointerEvent("pointerleave"));
          document.body.dispatchEvent(move());
          return gaze;
        } finally {
          SpritePlayer.prototype.setGaze = original;
        }
      });
      assert.deepEqual(changes, [true, false]);
    } finally {
      await f.close();
    }
  },
);
