import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright";
import { canEditAction, type Layer } from "../apps/desktop/src/teaching.ts";

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

/** Polls the page until `check` holds (waitForFunction cannot await). */
async function until(page: any, check: () => Promise<boolean>) {
  for (let i = 0; i < 60; i++) {
    if (await page.evaluate(check)) return;
    await page.waitForTimeout(100);
  }
  throw new Error("timed out: " + check.toString().slice(0, 120));
}

test("重画范围（plan/29）：学会的动作都能重画，基础动作暂不开放，睡觉保持原样", () => {
  const action = {
    label: "测试",
    image: "a.png",
    durations: [100, 100, 100, 100],
  };
  const layer: Layer = {
    actions: {
      dance: action,
      sleep: action,
      read: { ...action, loopFrames: [2, 3] },
    },
    rules: [],
  };
  for (const n of ["dance", "read"]) assert.ok(canEditAction(n, layer), n);
  for (const n of [
    "idle",
    "running-left",
    "running-right",
    "waving",
    "jumping",
    "failed",
    "waiting",
    "running",
    "review",
    "sleep",
    "look-up",
    "unknown",
  ])
    assert.equal(canEditAction(n, layer), false, n);
});

test("替换工作动作不被旧注视图覆盖；结束试播和恢复后回到原动作", async () => {
  const page = await browser.newPage();
  await page.goto(server.resolvedUrls!.local[0] + "?fixture");
  // Use the approved atlas as a fixture, and a distinct opaque clip to catch sheet fallback.
  const checked = await page.evaluate(async () => {
    const { SpritePlayer } = await import("/src/player.ts" as string);
    const api = await import("/src/bridge.ts" as string);
    const url = await api.sprite("lizi");
    const canvas = document.createElement("canvas");
    document.body.append(canvas);
    const player = new SpritePlayer(canvas);
    await player.load(url);
    const fixture = document.createElement("canvas");
    fixture.width = 1152;
    fixture.height = 208;
    const ctx = fixture.getContext("2d")!;
    ctx.fillStyle = "#a03929";
    ctx.fillRect(0, 0, 1152, 208);
    player.setState("running", true);
    player.setGaze({ x: 1, y: 0 });
    const before = player.pose();
    await player.addClips({
      running: {
        url: fixture.toDataURL(),
        durations: [120, 120, 120, 120, 120, 220],
      },
    });
    const during = player.pose();
    await new Promise((r) => setTimeout(r, 160));
    const progressed = player.pose().frame;
    player.setGaze({ x: -1, y: 1 });
    const afterGazeMove = player.pose().frame;
    player.removeClipsExcept([]);
    player.setGaze(null);
    const restored = player.pose();
    player.setActive(false);
    await player.addClips({
      dance: {
        url: fixture.toDataURL(),
        durations: [120, 120, 120, 120, 120, 220],
      },
    });
    player.play("dance");
    player.removeClipsExcept([]);
    const removedCustom = player.requestedAction;
    return {
      before,
      during,
      restored,
      progressed,
      afterGazeMove,
      removedCustom,
    };
  });
  assert.equal(checked.before.row, 9);
  assert.equal(checked.during.sheet, "running");
  assert.equal(checked.during.row, 0);
  assert.equal(checked.restored.row, 7);
  assert.equal(checked.restored.sheet, undefined);
  assert.ok(checked.progressed > 0);
  assert.equal(checked.afterGazeMove, checked.progressed);
  assert.equal(checked.removedCustom, "idle");
  await page.close();
});

test("四套皮肤：动作分两栏；只有睡觉和学会的动作有设置键，面板里设双击、随机、定时", async () => {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 820 },
  });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() => Boolean((window as any).__studio));
  const layer = () =>
    page.evaluate(async () => {
      const api = await import("/src/bridge.ts" as string);
      const s = api.browserSnapshot();
      return s.custom[s.settings.activeId!].layer;
    });
  for (const skin of ["studio", "native"]) {
    await page.evaluate(async (s) => {
      await (window as any).__studio.skin(s);
      (window as any).__studio.load("learned");
      await (window as any).__studio.ready();
    }, skin);
    // No drawer, no rule list beside: settings live on the actions.
    assert.equal(await page.locator("#drawer, #tune, #rules").count(), 0);
    await page.locator('.tape-tabs [data-group="base"]').click();
    const base = page.locator(".tape-item");
    await page.locator('.tape-item[data-action="sleep"]').waitFor();
    assert.deepEqual(
      await base.evaluateAll((items) =>
        items.map((i) => (i as HTMLElement).dataset.action),
      ),
      [
        "idle",
        "sleep",
        "waving",
        "jumping",
        "running",
        "review",
        "waiting",
        "failed",
        "running-right",
        "running-left",
      ],
      skin,
    );
    assert.equal(await page.locator(".tape-set").count(), 1, skin);
    assert.equal(
      await page.locator('.tape-item[data-action="sleep"] .tape-set').count(),
      1,
    );
    // A base action plays with its name only: no situations listed.
    await page.locator('.tape-tile[data-action="jumping"]').click();
    assert.equal((await page.locator("#playing").textContent())!, "跳跃");

    await page.locator('.tape-tabs [data-group="learned"]').click();
    await page.locator('.tape-item[data-action="stretch"]').waitFor();
    assert.equal(await page.locator(".tape-item").count(), 2, skin);
    assert.equal(await page.locator(".tape-set").count(), 2, skin);
    assert.equal(await page.locator(".tape-forget, .tape-edit").count(), 0);
    assert.match(
      (await page.locator(".tape-old").textContent())!,
      /以前的安排 5/,
    );
    await page.locator('.tape-item[data-action="stretch"] .tape-set').click();
    const pop = page.locator("#pop");
    assert.equal(await pop.getAttribute("data-kind"), "action");
    assert.match(
      (await pop.textContent())!,
      /伸懒腰.*双击时做.*随机出现.*每天定时/,
    );
    assert.equal(await pop.getByRole("button", { name: "重画" }).count(), 1);
    assert.equal(await pop.getByRole("button", { name: "删除…" }).count(), 1);
    await page.locator('#pop .act-row:has-text("随机出现") input').check();
    await until(page, async () => {
      const api = await import("/src/bridge.ts" as string);
      const s = api.browserSnapshot();
      return s.custom[s.settings.activeId!].layer.rules.some(
        (r: any) =>
          r.when.type === "random" &&
          r.when.weight === 20 &&
          r.do[0].play === "stretch",
      );
    });
    // How often is chosen right under the switch; the panel stays open.
    await page.locator('#pop .act-rate[data-rate="often"]').click();
    await until(page, async () => {
      const api = await import("/src/bridge.ts" as string);
      const s = api.browserSnapshot();
      return s.custom[s.settings.activeId!].layer.rules.some(
        (r: any) => r.when.type === "random" && r.when.weight === 40,
      );
    });
    assert.equal(await page.locator(".tape-rhythm").count(), 0);
    assert.equal(await pop.isVisible(), true);
    // The learned one says under the window when it plays.
    await page.keyboard.press("Escape");
    await page.locator('.tape-tile[data-action="stretch"]').click();
    assert.match(
      (await page.locator("#playing").textContent())!,
      /伸懒腰 · 随机（常常）/,
    );
    await page.locator('.tape-item[data-action="stretch"] .tape-set').click();
    await page.locator('#pop .act-row:has-text("每天定时") input').check();
    await page.locator("#pop .act-time").fill("21:30");
    await page.locator("#pop .act-time").dispatchEvent("change");
    await until(page, async () => {
      const api = await import("/src/bridge.ts" as string);
      const s = api.browserSnapshot();
      return s.custom[s.settings.activeId!].layer.rules.some(
        (r: any) => r.when.type === "clock" && r.when.at === "21:30",
      );
    });
    const rules = (await layer()).rules.filter(
      (r: any) => r.do[0].play === "stretch" && r.do.length === 1,
    );
    assert.ok(rules.length >= 2);
    // Double-click on another action says it moves here.
    await page.keyboard.press("Escape");
    await page
      .locator('.tape-item[data-action="pillow-walk"] .tape-set')
      .click();
    await page.locator('#pop .act-row:has-text("双击时做") input').check();
    await page.keyboard.press("Escape");
    await page.locator('.tape-item[data-action="stretch"] .tape-set').click();
    assert.match((await pop.textContent())!, /现在双击是「抱枕头出来」/);
    await page.keyboard.press("Escape");
  }
  await page.close();
});

test("名字旁没有别的键，目光跟随没有开关；右键宠物列表里的宠物：删除这只宠物", async () => {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 820 },
  });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() => Boolean((window as any).__studio));
  await page.evaluate(async () => {
    (window as any).__studio.load("learned");
    await (window as any).__studio.ready();
  });
  assert.equal(
    await page.locator("#name").evaluate((e) => e.parentElement!.className),
    "title",
  );
  assert.equal(await page.locator("#gaze").count(), 0);
  await page.locator(".pet-tile").first().click({ button: "right" });
  const pop = page.locator("#pop");
  const remove = pop.getByRole("button", { name: "删除这只宠物…" });
  const row = (await remove.boundingBox())!;
  await remove.click();
  assert.match((await pop.textContent())!, /删除「栗子」？/);
  const confirm = pop.getByRole("button", {
    name: "删除「栗子」",
    exact: true,
  });
  const panel = (await pop.boundingBox())!;
  assert.ok(panel.y >= row.y + row.height || panel.y + panel.height <= row.y);
  assert.ok(
    Math.min(
      Math.abs(panel.y - row.y - row.height),
      Math.abs(row.y - panel.y - panel.height),
    ) <= 9,
  );
  assert.equal(
    await confirm.evaluate((b) => getComputedStyle(b).backgroundColor),
    "rgb(178, 68, 47)",
  );
  await pop.getByRole("button", { name: "取消" }).click();
  assert.equal(
    await page.locator(".pet-tile").first().getAttribute("aria-label"),
    "栗子",
  );
  await page.close();
});

test("修改动作复用复制弹窗，自动携带技能路径、数据目录、收件箱和选中编号", async () => {
  const page = await browser.newPage();
  await page.addInitScript("window.__name = (fn) => fn");
  await page.addInitScript(() => {
    (window as any).isTauri = true;
    (window as any).__TAURI_INTERNALS__ = {
      transformCallback: () => 1,
      invoke: async (cmd: string) =>
        cmd === "app_language"
          ? "zh"
          : {
              manifest: "/fixture/skills/teach-desktop-pet/SKILL.md",
              dataRoot: "/fixture/data",
              inbox: "/fixture/data/inbox",
            },
    };
    Object.defineProperty(navigator, "clipboard", {
      value: {
        writeText: async (text: string) => ((window as any).__copied = text),
      },
    });
  });
  await page.goto(server.resolvedUrls!.local[0] + "?fixture");
  await page.evaluate(async () => {
    const { showSkillPrompt } = await import(
      "/src/skillPromptPopup.ts" as string
    );
    const { t } = await import("/src/i18n.ts" as string);
    const anchor = document.createElement("button");
    const pop = document.createElement("div");
    pop.id = "test-pop";
    document.body.append(anchor, pop);
    showSkillPrompt(
      anchor,
      "修改测试",
      "teach-desktop-pet",
      t("studio.editAsk", {
        name: "测试宠物",
        id: "fixture-pet",
        action: "running",
        label: "专心工作",
      }),
      t("studio.editHint"),
      {
        openPop: (_a: HTMLElement, nodes: HTMLElement[]) =>
          pop.replaceChildren(...nodes),
        closePop: () => {},
      },
      () => {},
    );
  });
  await page.waitForFunction(
    () =>
      !document.querySelector<HTMLButtonElement>("#test-pop button")!.disabled,
  );
  await page.locator("#test-pop button").click();
  const copied = await page.evaluate(() => (window as any).__copied);
  for (const value of [
    "/fixture/skills/teach-desktop-pet/SKILL.md",
    "/fixture/data",
    "/fixture/data/inbox",
    "fixture-pet",
    "running",
    "参考图",
  ])
    assert.ok(copied.includes(value), value);
  await page.close();
});

test("以前的基础动作重画草稿仍可试播接受；右键宠物恢复原样，保留规则和历史", async () => {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 820 },
  });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() => Boolean((window as any).__studio));
  const petId = await page.evaluate(async () => {
    (window as any).__studio.load("full");
    await (window as any).__studio.ready();
    const api = await import("/src/bridge.ts" as string);
    const s = api.browserSnapshot(),
      id = s.settings.activeId!;
    const current = {
      actions: {},
      rules: [
        {
          id: "work-tap",
          label: "点一下工作",
          when: { type: "event", event: "click" },
          do: [{ play: "running" }],
        },
      ],
    };
    s.custom[id] = {
      history: {
        current: 1,
        versions: [{ version: 1, summary: "已有规则", acceptedAt: 1 }],
      },
      layer: current,
    };
    s.drafts = [
      {
        id: "edit-fixture",
        petId: id,
        summary: "修改工作动作",
        receivedAt: 1,
        addedActions: ["running"],
        addedRules: [],
        removedActions: [],
        removedRules: [],
        preview: {
          ...current,
          actions: {
            running: {
              label: "专心工作",
              image: "edit.png",
              durations: [120, 120, 120, 120, 120, 220],
            },
          },
        },
      },
    ];
    api.setBrowserState(s, { [`${id}:1`]: current });
    return id;
  });
  const card = page.locator('.card[data-id="edit-fixture"]');
  await card.waitFor({ state: "visible" });
  assert.equal(
    await card.getByRole("button", { name: "当前动作", exact: true }).count(),
    1,
  );
  await card.getByRole("button", { name: "专心工作", exact: true }).click();
  assert.equal(
    await page.evaluate(
      async (id) =>
        !!(await import("/src/bridge.ts" as string)).browserSnapshot().custom[
          id
        ].layer.actions.running,
      petId,
    ),
    false,
  );
  await card.getByRole("button", { name: "接受替换", exact: true }).click();
  await page.waitForFunction(
    async (id) =>
      !!(await import("/src/bridge.ts" as string)).browserSnapshot().custom[id]
        .layer.actions.running,
    petId,
  );
  assert.equal(
    await page.locator('.tape-tile[data-action="running"]').count(),
    1,
  );
  const accepted = await page.evaluate(
    async (id) =>
      (await import("/src/bridge.ts" as string)).browserSnapshot().custom[id]
        .history.current,
    petId,
  );
  // Base actions redrawn before go back from the "⋯" beside the name.
  // Wait until the accepted drawing is in (an async check in
  // waitForFunction would pass at once).
  const redrawn = () =>
    page.evaluate(
      async (id) =>
        !!(await import("/src/bridge.ts" as string)).browserSnapshot().custom[
          id
        ].layer.actions.running,
      petId,
    );
  for (let i = 0; i < 50 && !(await redrawn()); i++)
    await page.waitForTimeout(100);
  await page.waitForTimeout(200);
  await page.locator(".pet-tile").first().click({ button: "right" });
  await page
    .locator("#pop")
    .getByRole("button", { name: "把重画过的基础动作恢复原样" })
    .click();
  await page
    .locator("#pop")
    .getByRole("button", { name: "恢复原动作", exact: true })
    .click();
  await page.waitForFunction(
    async (id) =>
      !(await import("/src/bridge.ts" as string)).browserSnapshot().custom[id]
        .layer.actions.running,
    petId,
  );
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await import("/src/bridge.ts" as string)).browserSnapshot().custom[id]
          .layer.rules.length,
      petId,
    ),
    1,
  );
  await page.evaluate(
    async ({ petId, accepted }) =>
      (async () => {
        const saved = await import("/src/savedActions.ts" as string);
        const item = (await saved.savedActions(petId)).find(
          (i: any) => i.name === "running" && !i.original,
        )!;
        await saved.useSavedAction(petId, item.id);
      })(),
    { petId, accepted },
  );
  await page.waitForFunction(
    async (id) =>
      !!(await import("/src/bridge.ts" as string)).browserSnapshot().custom[id]
        .layer.actions.running,
    petId,
  );
  await page.close();
});

test("待确认动作随当前宠物的草稿显示，处理完最后一份就收起", async () => {
  const page = await browser.newPage({ viewport: { width: 860, height: 650 } });
  try {
    await page.goto(server.resolvedUrls!.local[0]);
    await page.waitForFunction(() => Boolean((window as any).__studio));
    const load = (name: string) =>
      page.evaluate(async (name) => {
        (window as any).__studio.load(name);
        await (window as any).__studio.ready();
      }, name);
    await load("fresh");
    assert.equal(await page.locator("#slot").isVisible(), false);
    assert.equal(await page.locator("#draft-heading").isVisible(), false);
    await page.locator("#teach").click({ trial: true });
    await load("two");
    await page.locator("#draft-next").click();
    await page
      .locator("#cards .card:visible .card-buttons button")
      .last()
      .click();
    await page.locator("#draft-next").waitFor({ state: "hidden" });
    await page.locator("#cards .card:visible .card-buttons .primary").click();
    await page.locator("#slot").waitFor({ state: "hidden" });
    assert.equal(await page.locator("#draft-heading").isVisible(), false);
    await page.locator("#teach").click({ trial: true });
  } finally {
    await page.close();
  }
});
