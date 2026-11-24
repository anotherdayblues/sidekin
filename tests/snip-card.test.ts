import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium, webkit, type Page } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

const picture =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#fff"/></svg>',
  );
const ocr = {
  lines: [
    { t: "Error: Permission denied", x: 0.05, y: 0.1, w: 0.6, h: 0.12, row: 0 },
    { t: "第二行文字", x: 0.05, y: 0.4, w: 0.4, h: 0.12, row: 1 },
  ],
  text: "Error: Permission denied\n第二行文字",
};
const card = (extra: object = {}) => ({
  generation: 7,
  preview: picture,
  canVision: false,
  brainEnabled: true,
  translation: true,
  ocr,
  ...extra,
});

const TOPICS = {
  current: 12 as number | null,
  topics: [
    { id: 12, title: "当前话题" },
    { id: 7, title: "以前的话题" },
  ],
};
async function withCard(
  data: object | null,
  run: (c: {
    page: Page;
    event: (name: string, payload: unknown) => Promise<unknown>;
    calls: { cmd: string; p: any }[];
  }) => Promise<void>,
  deviceScaleFactor = 1,
  topics: () => typeof TOPICS = () => TOPICS,
  engine: "chromium" | "webkit" = "chromium",
) {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = engine === "webkit" ? await webkit.launch() : await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ deviceScaleFactor });
    const calls: { cmd: string; p: any }[] = [];
    const event = await bubbleBridge(page, async (cmd, p) => {
      calls.push({ cmd, p });
      if (cmd === "get_state")
        return { settings: { theme: "day", skin: "studio" } };
      if (cmd === "snip_topics") return topics();
      if (cmd === "snip_card") return data;
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?snipcard");
    await page.waitForFunction(() =>
      document.querySelector(".snipcard-frame img"),
    );
    await run({ page, event, calls });
  } finally {
    await browser.close();
    await server.close();
  }
}

function selectIn(page: Page, from: [number, number], to: [number, number]) {
  return page.evaluate(
    ([from, to]) => {
      const spans = document.querySelectorAll(".snipcard-text span");
      const range = document.createRange();
      range.setStart(spans[from[0]].firstChild!, from[1]);
      range.setEnd(spans[to[0]].firstChild!, to[1]);
      const sel = getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      document.dispatchEvent(new Event("selectionchange"));
      return sel.toString();
    },
    [from, to] as const,
  );
}

test("截图卡片：文字层压在图上对齐，可在图上选字复制，跨行保留换行", async () => {
  await withCard(card(), async ({ page, calls }) => {
    await page.waitForFunction(
      () => document.querySelectorAll(".snipcard-text span").length === 2,
    );
    assert.equal(
      await page.locator(".snipcard-note").textContent(),
      "文字识别可能不够准确",
    );
    assert.equal(await page.locator(".snipcard-note").isVisible(), true);
    const sized = calls.find((c) => c.cmd === "size_snip_card");
    assert.ok(sized && sized.p.generation === 7 && sized.p.width >= 360);
    // The first line's invisible text covers its box on the picture.
    const box = await page.evaluate(() => {
      const f = document
        .querySelector(".snipcard-frame")!
        .getBoundingClientRect();
      const s = document
        .querySelector(".snipcard-text span")!
        .getBoundingClientRect();
      return {
        left: (s.left - f.left) / f.width,
        width: s.width / f.width,
      };
    });
    assert.ok(Math.abs(box.left - 0.05) < 0.01, `left ${box.left}`);
    assert.ok(Math.abs(box.width - 0.6) < 0.02, `width ${box.width}`);
    await selectIn(page, [0, 7], [0, 24]);
    await page.waitForFunction(
      () =>
        document.querySelector("[data-copy-text]")!.textContent === "复制所选",
    );
    await page.locator("[data-copy-text]").click();
    const copied = calls.filter((c) => c.cmd === "copy_translation");
    assert.equal(copied.at(-1)!.p.text, "Permission denied");
    const across = await selectIn(page, [0, 0], [1, 5]);
    assert.match(across, /denied\n第二行文字/);
  });
});

test("截图卡片：在 WebKit（Mac 应用用的内核）里用真鼠标拖，能在图上选中文字", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { host: "127.0.0.1", port: 0 },
    logLevel: "error",
  });
  await server.listen();
  const browser = await webkit.launch();
  try {
    const page = await browser.newPage({
      viewport: { width: 900, height: 700 },
    });
    await bubbleBridge(page, async (cmd) => {
      if (cmd === "get_state")
        return { settings: { theme: "day", skin: "studio" } };
      if (cmd === "snip_card") return card();
      return null;
    });
    await page.goto(server.resolvedUrls!.local[0] + "?snipcard");
    await page.waitForFunction(
      () => document.querySelectorAll(".snipcard-text span").length === 2,
    );
    const f = (await page.locator(".snipcard-frame").boundingBox())!;
    const at = (x: number, y: number) =>
      [f.x + x * f.width, f.y + y * f.height] as const;
    async function drag(from: [number, number], to: [number, number]) {
      await page.evaluate(() => getSelection()!.removeAllRanges());
      await page.mouse.move(...at(...from));
      await page.mouse.down();
      for (let i = 1; i <= 10; i++)
        await page.mouse.move(
          at(...from)[0] + (at(...to)[0] - at(...from)[0]) * (i / 10),
          at(...from)[1] + (at(...to)[1] - at(...from)[1]) * (i / 10),
        );
      await page.mouse.up();
      return page.evaluate(() => getSelection()!.toString());
    }
    // Within the first line, then across both lines.
    assert.ok((await drag([0.1, 0.16], [0.6, 0.16])).length > 5);
    assert.match(await drag([0.3, 0.16], [0.3, 0.46]), /\n/);
    assert.equal(
      await page.locator("[data-copy-text]").textContent(),
      "复制所选",
    );
  } finally {
    await browser.close();
    await server.close();
  }
});

test("截图卡片：问它把问题和选中文字交给宠物，Esc 关闭卡片", async () => {
  await withCard(card(), async ({ page, calls }) => {
    await page.waitForFunction(
      () => document.querySelectorAll(".snipcard-text span").length === 2,
    );
    const target = page.getByLabel("发送到对话");
    assert.equal(await target.inputValue(), "12");
    await target.selectOption("7");
    await page.locator("textarea").fill("这是什么");
    await page.locator("textarea").press("Enter");
    let asked = calls.filter((c) => c.cmd === "snip_card_ask");
    assert.equal(asked.at(-1)!.p.question, "这是什么");
    assert.equal(asked.at(-1)!.p.topic, 7);
    await selectIn(page, [1, 0], [1, 5]);
    await page.locator("[data-send]").click();
    asked = calls.filter((c) => c.cmd === "snip_card_ask");
    assert.match(asked.at(-1)!.p.question, /「第二行文字」/);
    await page.locator("[data-translate]").click();
    assert.equal(
      calls.filter((c) => c.cmd === "snip_card_translate").at(-1)!.p.text,
      "第二行文字",
    );
    await page.keyboard.press("Escape");
    assert.equal(
      calls.filter((c) => c.cmd === "snip_card_close").at(-1)!.p.generation,
      7,
    );
  });
});

test("截图卡片：没配模型只留复制；文字识别稍后才到", async () => {
  await withCard(
    card({ brainEnabled: false, translation: false, ocr: null }),
    async ({ page, event }) => {
      await page.waitForFunction(
        () =>
          document.querySelector("[data-status]")!.textContent ===
          "正在识别文字…",
      );
      assert.equal(await page.locator("[data-ask]").isHidden(), true);
      assert.equal(await page.locator("[data-translate]").isHidden(), true);
      assert.equal(await page.locator("[data-hint]").isVisible(), true);
      assert.equal(await page.locator("[data-copy-image]").isVisible(), true);
      await event("snip-card-ocr", { generation: 7, ocr });
      await page.waitForFunction(
        () => document.querySelectorAll(".snipcard-text span").length === 2,
      );
      await event("snip-card-ocr", {
        generation: 7,
        ocr: { lines: [], text: "", error: "recognize" },
      });
      await page.waitForFunction(() =>
        document
          .querySelector("[data-status]")!
          .textContent!.includes("识别失败"),
      );
    },
  );
});

for (const scale of [1.25, 1.5]) {
  test(`截图卡片在 ${scale * 100}% 下完整显示图片、文字和按钮`, async () => {
    await withCard(card(), async ({ page, calls }) => {
      await page.waitForFunction(() => document.querySelector<HTMLImageElement>(".snipcard-frame img")?.naturalWidth);
      const frame = page.locator(".snipcard-frame");
      const bounds = await frame.boundingBox();
      assert.ok(bounds && Math.abs(bounds.width * scale - 400) < 3);
      const request = calls.filter(call => call.cmd === "size_snip_card").at(-1);
      assert.ok(request);
      await page.setViewportSize({ width: request.p.width, height: request.p.height });
      for (const name of ["复制图片", "复制文字"]) {
        const box = await page.getByRole("button", { name, exact: true }).boundingBox();
        assert.ok(box && box.x >= 0 && box.x + box.width <= request.p.width + 1);
        assert.ok(box.y >= 0 && box.y + box.height <= request.p.height + 1);
      }
    }, scale);
  });
}

test("截图卡片：从新话题开始，发出第一条后接着发的都进同一个对话", async () => {
  // Nothing open: the card starts on 新话题.
  let open = { current: null as number | null, topics: [] as { id: number; title: string }[] };
  await withCard(
    card(),
    async ({ page, event, calls }) => {
      const target = page.getByLabel("发送到对话");
      await page.waitForFunction(
        () => !(document.querySelector(".snipcard-destination select") as HTMLSelectElement).disabled,
      );
      assert.equal(await target.inputValue(), "");
      await page.locator("textarea").fill("这是什么");
      await page.locator("textarea").press("Enter");
      const asked = () => calls.filter((c) => c.cmd === "snip_card_ask");
      assert.equal(asked().at(-1)!.p.topic, null, "the first one opens a topic");
      // The bubble has asked it, in topic 31; another card's news is not ours.
      open = { current: 31, topics: [{ id: 31, title: "" }] };
      await event("snip-topic", { generation: 6, topic: 99 });
      await event("snip-topic", { generation: 7, topic: 31 });
      await page.waitForFunction(
        () => (document.querySelector(".snipcard-destination select") as HTMLSelectElement).value === "31",
      );
      await page.locator("textarea").fill("再说说");
      await page.locator("textarea").press("Enter");
      assert.equal(asked().at(-1)!.p.topic, 31, "the next one continues it");
    },
    1,
    () => open,
  );
});

for (const engine of ["webkit", "chromium"] as const) {
  test(`窄截图有长话题时，关闭键、发送键和目标选择器都能用鼠标点击 · ${engine}`, async () => {
    const preview =
      "data:image/svg+xml;utf8," +
      encodeURIComponent(
        '<svg xmlns="http://www.w3.org/2000/svg" width="308" height="52"><rect width="308" height="52" fill="white"/></svg>',
      );
    const title = "这是一个很长的历史对话标题".repeat(10);
    await withCard(
      card({ preview, ocr: { lines: [], text: "" } }),
      async ({ page, calls }) => {
        const close = page.locator("[data-close]"),
          send = page.locator("[data-send]"),
          dest = page.locator(".snipcard-destination select");
        await page.waitForFunction(
          () =>
            document.querySelectorAll(".snipcard-destination option").length ===
            2,
        );
        await page.waitForFunction(
          () =>
            document.querySelector<HTMLImageElement>(".snipcard-frame img")
              ?.naturalWidth === 308,
        );
        const size = calls.filter((c) => c.cmd === "size_snip_card").at(-1)!.p;
        await page.setViewportSize({ width: size.width, height: size.height });
        const bounds = await page.locator(".snipcard").boundingBox();
        assert.ok(bounds);
        for (const control of [
          close,
          send,
          dest,
          page.locator(".snipcard-frame"),
        ]) {
          const b = await control.boundingBox();
          assert.ok(b);
          assert.ok(
            b.x >= bounds.x && b.x + b.width <= bounds.x + bounds.width + 1,
            `control from ${b.x} to ${b.x + b.width} should fit in card ending at ${bounds.x + bounds.width}`,
          );
        }
        await dest.selectOption("21");
        await page.locator("textarea").fill("测试发送");
        await send.click({ timeout: 2000 });
        await close.click({ timeout: 2000 });
        assert.equal(calls.find((c) => c.cmd === "snip_card_ask")?.p.topic, 21);
        assert.equal(
          calls.find((c) => c.cmd === "snip_card_close")?.p.generation,
          7,
        );
      },
      2,
      () => ({ current: null, topics: [{ id: 21, title }] }),
      engine,
    );
  });
}
