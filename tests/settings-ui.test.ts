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
            skin: "native",
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
        [
          "list_documents",
          "list_reminders",
          "pending_reminders",
          "todo_list",
        ].includes(cmd)
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
      await f.page.locator('[data-settings-tab="brain"]').click();
      await f.page.locator("[data-search]").selectOption("brave");
      await f.page.locator("[data-search-key]").fill("fixture-only");
      await f.page.locator("#set-online [data-save-online]").click();
      await f.page.waitForFunction(
        () =>
          document
            .querySelector("#set-online [data-online-status]")
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
      await f.page.locator('[data-settings-tab="brain"]').click();
      await f.page.locator("[data-search]").selectOption("brave");
      await f.page.locator("[data-search-key]").fill("fixture-only");
      await f.page.locator("#set-online [data-save-online]").click();
      await f.page.waitForFunction(() =>
        document
          .querySelector("#set-online [data-online-status]")
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
        await f.page.locator("#set-online [data-online-status]").innerText(),
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
      await f.page.locator('[data-settings-tab="abilities"]').click();
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

test(
  "设置页 4 个分段切换正常，外观保留在通用页底部，外部跳转自动切到对应分区",
  { skip: !allowed },
  async () => {
    const f = await fixture(async (cmd) =>
      cmd === "companion_settings"
        ? { ...defaults, enabled: true, modelVerified: true }
        : null,
    );
    try {
      // Default tab is 通用, with #set-look (外观) at the bottom of the general panel.
      assert.equal(
        await f.page
          .locator('[data-settings-tab="general"]')
          .getAttribute("aria-selected"),
        "true",
      );
      assert.equal(
        await f.page.locator('[data-settings-panel="general"] #set-look').count(),
        1,
      );
      assert.equal(
        await f.page.locator('[data-settings-panel="perms"]').isHidden(),
        true,
      );
      // External section event switches directly to 系统权限 tab.
      await f.page.evaluate(() =>
        (window as any).qaEvent("settings-section", "access"),
      );
      await f.page.waitForFunction(
        () =>
          document
            .querySelector('[data-settings-tab="perms"]')
            ?.getAttribute("aria-selected") === "true",
      );
      assert.equal(
        await f.page.locator('[data-settings-panel="perms"]').isVisible(),
        true,
      );
      // External section event for #set-online (上网查资料) switches to 大脑, already open.
      await f.page.evaluate(() =>
        (window as any).qaEvent("settings-section", "online"),
      );
      await f.page.waitForFunction(
        () =>
          document
            .querySelector('[data-settings-tab="brain"]')
            ?.getAttribute("aria-selected") === "true",
      );
      assert.equal(await f.page.locator("[data-search]").isVisible(), true);
      // Folded #set-backups opens its fold.
      await f.page.evaluate(() =>
        (window as any).qaEvent("settings-section", "backups"),
      );
      await f.page.waitForFunction(
        () => document.querySelector<HTMLDetailsElement>("#set-backups")?.open === true,
      );
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  },
);

/** RGB of one screen pixel, read from a 1×1 PNG screenshot. */
async function pixel(page: import("playwright").Page, x: number, y: number) {
  const png = await page.screenshot({ clip: { x, y, width: 1, height: 1 } });
  let at = 8,
    idat = Buffer.alloc(0);
  while (at < png.length) {
    const len = png.readUInt32BE(at),
      type = png.toString("ascii", at + 4, at + 8);
    if (type === "IDAT")
      idat = Buffer.concat([idat, png.subarray(at + 8, at + 8 + len)]);
    at += 12 + len;
  }
  const raw = (await import("node:zlib")).inflateSync(idat);
  return [raw[1], raw[2], raw[3]].join(",");
}

/** The sticky tab bar against the page just beside it, plus a tab's own style. */
async function bandCheck(page: import("playwright").Page) {
  const box = await page.evaluate(() => {
    const bar = document.querySelector<HTMLElement>(".set-tabs")!;
    const r = bar.getBoundingClientRect();
    const tab = bar.querySelector<HTMLElement>('[aria-selected="false"]')!;
    const cs = getComputedStyle(tab);
    return {
      left: r.left,
      top: r.top,
      tabBorder: cs.borderTopWidth,
      tabBg: cs.backgroundColor,
    };
  });
  return {
    bar: await pixel(page, Math.round(box.left + 4), Math.round(box.top + 6)),
    behind: await pixel(page, Math.round(box.left - 8), Math.round(box.top + 6)),
    tabBorder: box.tabBorder,
    tabBg: box.tabBg,
  };
}

test(
  "设置页标签不带表单按钮边框（两套皮肤，日间与夜间）",
  { skip: !allowed },
  async () => {
    const f = await fixture(async (cmd) =>
      cmd === "companion_settings" ? defaults : null,
    );
    try {
      for (const skin of ["native", "studio"])
        for (const theme of ["day", "night"]) {
          await f.page.evaluate(
            ([skin, theme]) => {
              document.documentElement.dataset.skin = skin;
              document.documentElement.dataset.theme = theme;
            },
            [skin, theme],
          );
          const r = await bandCheck(f.page);
          const where = `${skin}/${theme}`;
          assert.equal(r.tabBorder, "0px", `${where}: tab border`);
          assert.equal(r.tabBg, "rgba(0, 0, 0, 0)", `${where}: tab background`);
        }
    } finally {
      await f.close();
    }
  },
);

test(
  "能力页分组叫「功能」；设置页不再显示对方语言，保存其他项时保留它",
  { skip: !allowed },
  async () => {
    let settings = {
      ...defaults,
      enabled: true,
      modelVerified: true,
      translationTarget: "ja",
    };
    let calls = 0;
    const f = await fixture(async (cmd, p) => {
      if (cmd === "save_companion") {
        calls++;
        settings = { ...settings, ...p.settings };
      }
      return ["companion_settings", "save_companion"].includes(cmd)
        ? settings
        : null;
    });
    try {
      await f.page.locator('[data-settings-tab="abilities"]').click();
      assert.equal(
        await f.page.locator("#set-abilities .set-title").innerText(),
        "功能",
      );
      assert.equal(
        await f.page.locator('.companion-page [name="translationTarget"]').count(),
        0,
      );
      await f.page.getByRole("switch", { name: "记忆与旧对话搜索" }).click();
      await waitForSave(() => calls, 1);
      await f.page.waitForFunction(
        () =>
          document.querySelector('.companion-page output[role="status"]')
            ?.textContent === "已保存",
      );
      assert.equal(settings.translationTarget, "ja");
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  },
);

test(
  "伙伴大脑状态是开关下的一行副文字，模型名不重复出现",
  { skip: !allowed },
  async () => {
    const f = await fixture(async (cmd) =>
      cmd === "companion_settings"
        ? {
            ...defaults,
            enabled: true,
            modelVerified: true,
            model: "fixture-model",
          }
        : null,
    );
    try {
      await f.page.locator('[data-settings-tab="brain"]').click();
      const r = await f.page.evaluate(() => {
        const s = document.querySelector<HTMLElement>(".brain-status")!;
        const cs = getComputedStyle(s);
        return {
          bg: cs.backgroundColor,
          inSwitchRow: !!s
            .closest(".switch-row")
            ?.querySelector('[name="enabled"]'),
          text: s.textContent,
          current: document.querySelector("[data-current-model]")!.textContent,
        };
      });
      assert.equal(r.bg, "rgba(0, 0, 0, 0)");
      assert.ok(r.inSwitchRow, "status sits in the 开启伙伴大脑 row");
      assert.match(r.text ?? "", /fixture-model/);
      assert.doesNotMatch(r.current ?? "", /fixture-model/);
    } finally {
      await f.close();
    }
  },
);

test(
  "设置页吸顶条与身后表面同色；原生皮肤没有外层大卡；分组标题在卡片外",
  { skip: !allowed },
  async () => {
    const f = await fixture(async (cmd) =>
      cmd === "companion_settings" ? defaults : null,
    );
    try {
      for (const skin of ["native", "studio"])
        for (const theme of ["day", "night"]) {
          await f.page.evaluate(
            ([skin, theme]) => {
              document.documentElement.dataset.skin = skin;
              document.documentElement.dataset.theme = theme;
            },
            [skin, theme],
          );
          const r = await bandCheck(f.page);
          const gap = Math.max(
            ...r.bar.split(",").map((v, i) => Math.abs(+v - +r.behind.split(",")[i])),
          );
          assert.ok(gap <= 3, `${skin}/${theme}: sticky bar ${r.bar} vs surface ${r.behind}`);
        }
      await f.page.evaluate(() => {
        document.documentElement.dataset.skin = "native";
        document.documentElement.dataset.theme = "day";
      });
      const outer = await f.page.evaluate(() => {
        const cs = getComputedStyle(
          document.querySelector('.block[data-for="settings"] .companion-page')!,
        );
        return { bg: cs.backgroundColor, shadow: cs.boxShadow };
      });
      assert.deepEqual(outer, { bg: "rgba(0, 0, 0, 0)", shadow: "none" });
      await f.page.locator('[data-settings-tab="abilities"]').click();
      const layout = await f.page.evaluate(() => {
        const g = document.querySelector("#set-abilities")!;
        return {
          titleInCard: !!g.querySelector(".set-card .set-title"),
          rowsInCard: g.querySelectorAll(".set-card .switch-row").length,
        };
      });
      assert.equal(layout.titleInCard, false);
      assert.ok(layout.rowsInCard >= 4);
      // 外观 follows the same shape: a bare section, its title above one card.
      const look = await f.page.evaluate(() => {
        const g = document.querySelector<HTMLElement>("#set-look")!;
        return {
          bg: getComputedStyle(g).backgroundColor,
          titleInCard: !!g.querySelector(".set-card .set-title"),
        };
      });
      assert.deepEqual(look, { bg: "rgba(0, 0, 0, 0)", titleInCard: false });
    } finally {
      await f.close();
    }
  },
);

test(
  "「连按两次 ⌘C」跟随翻译开关：翻译关闭时不可操作",
  { skip: !allowed },
  async () => {
    let settings = { ...defaults, enabled: true, modelVerified: true, translation: false };
    const f = await fixture(async (cmd, p) => {
      if (cmd === "save_companion") settings = { ...settings, ...p.settings };
      return ["companion_settings", "save_companion"].includes(cmd)
        ? settings
        : null;
    });
    try {
      await f.page.locator('[data-settings-tab="abilities"]').click();
      const copy = f.page.locator('[name="copyTwice"]');
      assert.equal(await copy.isDisabled(), true, "off with translation off");
      await f.page.getByRole("switch", { name: "翻译", exact: true }).click();
      assert.equal(await copy.isDisabled(), false, "on once translation is on");
    } finally {
      await f.close();
    }
  },
);

test(
  "大脑关着时引导是标签下的一行横幅：继续设置展开三步，×收起；首次启动直接打开三步",
  { skip: !allowed },
  async () => {
    const f = await fixture(async (cmd) =>
      cmd === "companion_settings" ? defaults : null,
    );
    try {
      const banner = f.page.locator(".onboard-banner");
      const card = f.page.locator(".onboard");
      await banner.waitFor({ state: "visible" });
      assert.equal(await card.isVisible(), false, "no big card by itself");
      assert.match(await banner.innerText(), /还差 \d 步完成设置/);
      assert.equal(
        await f.page.evaluate(() => {
          const tabs = document.querySelector(".set-tabs")!;
          const b = document.querySelector(".onboard-banner")!;
          return !!(tabs.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);
        }),
        true,
        "banner sits below the tabs",
      );
      await banner.getByRole("button", { name: "继续设置" }).click();
      assert.equal(await card.isVisible(), true);
      assert.equal(await banner.isVisible(), false);
      await card.getByRole("button", { name: "以后再说" }).click();
      assert.equal(await card.isVisible(), false);
      assert.equal(await banner.isVisible(), false, "以后再说 dismisses both");

      // First launch: the host emits "guide-open" (tips.rs).
      await f.page.evaluate(() => (window as any).qaEvent("guide-open", null));
      await card.waitFor({ state: "visible" });
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  },
);

test("引导横幅的 × 只收起横幅", { skip: !allowed }, async () => {
  const f = await fixture(async (cmd) =>
    cmd === "companion_settings" ? defaults : null,
  );
  try {
    const banner = f.page.locator(".onboard-banner");
    await banner.waitFor({ state: "visible" });
    await banner.getByRole("button", { name: "以后再说" }).click();
    assert.equal(await banner.isVisible(), false);
    assert.equal(await f.page.locator(".onboard").isVisible(), false);
  } finally {
    await f.close();
  }
});

test("用量小票直接放在「用量」标题下，不再套灰卡", { skip: !allowed }, async () => {
  const f = await fixture(async (cmd) =>
    cmd === "companion_settings" ? defaults : null,
  );
  try {
    await f.page.locator('[data-settings-tab="brain"]').click();
    const r = await f.page.evaluate(() => {
      const u = document.querySelector("[data-usage]")!;
      return {
        inGroup: !!u.closest("#set-usage"),
        inCard: !!u.closest(".set-card"),
      };
    });
    assert.deepEqual(r, { inGroup: true, inCard: false });
  } finally {
    await f.close();
  }
});

test(
  "快捷键页分「打开窗口」「对选中的内容」两组，名称不带「快捷键」，每行一句说明",
  { skip: !allowed },
  async () => {
    const f = await fixture(async (cmd) =>
      cmd === "companion_settings" ? { ...defaults, chatShortcut: "" } : null,
    );
    try {
      await f.page.locator('[data-settings-tab="shortcuts"]').click();
      const groups = await f.page.evaluate(() =>
        [...document.querySelectorAll('[data-settings-panel="shortcuts"] .set-group')].map(
          (g) => ({
            title: g.querySelector(".set-title")!.textContent,
            names: [...g.querySelectorAll(".row-name")].map((n) => n.textContent),
            descs: [...g.querySelectorAll(".row-desc")].filter((d) => d.textContent).length,
          }),
        ),
      );
      assert.deepEqual(groups, [
        {
          title: "打开窗口",
          names: ["聊天", "聊天侧边栏", "翻译面板", "剪贴板历史"],
          descs: 4,
        },
        { title: "对选中的内容", names: ["截屏识图", "圈屏提问"], descs: 2 },
      ]);
      assert.equal(
        await f.page.locator('[name="chatShortcut"]').getAttribute("placeholder"),
        "点击设置",
      );
      assert.equal(
        await f.page.locator('[name="chatSnipShortcut"]').getAttribute("placeholder"),
        "点击设置",
      );
    } finally {
      await f.close();
    }
  },
);

test(
  "各页按常用程度排序：上网查资料直接展开在伙伴大脑下面，用量小票在最下面",
  { skip: !allowed },
  async () => {
    const f = await fixture(async (cmd) =>
      cmd === "companion_settings" ? defaults : null,
    );
    try {
      const order = await f.page.evaluate(() =>
        Object.fromEntries(
          ["general", "brain", "abilities"].map((tab) => [
            tab,
            [
              ...document.querySelectorAll(
                `[data-settings-panel="${tab}"] > .set-group`,
              ),
            ].map((g) => g.id),
          ]),
        ),
      );
      assert.deepEqual(order, {
        general: ["set-general", "set-look", "set-guide"],
        brain: ["set-brain", "set-online", "set-brain-more", "set-usage"],
        abilities: ["set-abilities", "set-voice", "set-phone"],
      });
      const parts = await f.page.evaluate(() => ({
        onlineIsGroup: document.querySelector("#set-online")?.tagName,
        searchInOnline: !!document.querySelector("#set-online [data-search]"),
        backupsInFold: !!document.querySelector(
          "#set-brain-more details#set-backups [data-backups]",
        ),
        backupsSave: !!document.querySelector("#set-backups [data-save-online]"),
      }));
      assert.deepEqual(parts, {
        onlineIsGroup: "SECTION",
        searchInOnline: true,
        backupsInFold: true,
        backupsSave: true,
      });
    } finally {
      await f.close();
    }
  },
);

test(
  "通用页一致：上手引导是普通行，语言是紧凑的弹出菜单",
  { skip: !allowed },
  async () => {
    const f = await fixture(async (cmd) =>
      cmd === "companion_settings" ? defaults : null,
    );
    try {
      const r = await f.page.evaluate(() => {
        const steps = document.querySelector<HTMLElement>("#set-guide [data-guide-steps]")!;
        const cs = getComputedStyle(steps);
        const lang = document.querySelector<HTMLElement>('#set-general [name="language"]')!;
        return {
          rowClass: steps.classList.contains("set-row-link"),
          bg: cs.backgroundColor,
          shadow: cs.boxShadow,
          langWidth: lang.getBoundingClientRect().width,
        };
      });
      assert.equal(r.rowClass, true);
      assert.equal(r.bg, "rgba(0, 0, 0, 0)");
      assert.equal(r.shadow, "none");
      assert.ok(r.langWidth < 240, `language popup ${r.langWidth}px wide`);
    } finally {
      await f.close();
    }
  },
);

test(
  "能力页「连按两次 ⌘C」与同卡片其他行左对齐；滚动时吸顶标签条贴紧顶部不露缝",
  { skip: !allowed },
  async () => {
    const f = await fixture(async (cmd) =>
      cmd === "companion_settings" ? defaults : null,
    );
    try {
      await f.page.locator('[data-settings-tab="abilities"]').click();
      const lefts = await f.page.evaluate(() =>
        [
          ...document.querySelectorAll<HTMLElement>(
            "#set-abilities .set-card .switch-row > span",
          ),
        ].map((el) => Math.round(el.getBoundingClientRect().left)),
      );
      assert.ok(lefts.length >= 5);
      assert.equal(
        new Set(lefts).size,
        1,
        `rows should share one left edge, got ${lefts.join(",")}`,
      );

      await f.page.locator('[data-settings-tab="brain"]').click();
      const gap = await f.page.evaluate(() => {
        const block = document.querySelector<HTMLElement>(
          '.block[data-for="settings"]',
        )!;
        block.scrollTop = 260;
        const b = block.getBoundingClientRect();
        const t = document.querySelector<HTMLElement>(".set-tabs")!.getBoundingClientRect();
        return {
          scrollTop: block.scrollTop,
          blockTop: Math.round(b.top),
          tabsTop: Math.round(t.top),
          gap: Math.round(t.top - b.top),
        };
      });
      assert.ok(gap.scrollTop > 0, "settings block should scroll");
      assert.ok(
        gap.gap <= 1,
        `sticky tabs should touch top of settings block, got gap=${gap.gap}px (block=${gap.blockTop}, tabs=${gap.tabsTop})`,
      );
    } finally {
      await f.close();
    }
  },
);
