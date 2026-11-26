import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium, type Page } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";
import { defaults } from "../apps/shared/companion.ts";

const TINY_PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";
const TINY_PNG_URL = `data:image/png;base64,${TINY_PNG_B64}`;
const SAMPLE_TXT_B64 = Buffer.from("Hello from shelf file!", "utf8").toString(
  "base64",
);

async function withChatPage(
  opts: { width?: number; height?: number },
  handler: (cmd: string, payload: any) => any,
  run: (ctx: {
    page: Page;
    emit: (name: string, payload: unknown) => Promise<unknown>;
    calls: { cmd: string; payload: any }[];
  }) => Promise<void>,
) {
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
      viewport: { width: opts.width ?? 340, height: opts.height ?? 720 },
    });
    const calls: { cmd: string; payload: any }[] = [];
    const emit = await bubbleBridge(page, async (cmd, payload) => {
      calls.push({ cmd, payload });
      if (cmd === "get_state") {
        return {
          pets: [{ id: "lizi", displayName: "栗子" }],
          drafts: [],
          custom: {},
          settings: { activeId: "lizi", theme: "day", skin: "native" },
        };
      }
      if (cmd === "read_pet_thumbnail") return TINY_PNG_URL;
      if (cmd === "companion_settings")
        return { ...defaults, enabled: true, vision: true };
      if (cmd === "chat_snip_status") return { state: "ready", shortcut: "" };
      if (cmd === "take_chat_turn") return null;
      if (cmd === "take_pending_snip_image") return null;
      if (cmd === "chat_topics") return [];
      if (cmd === "translation_history") return [];
      return handler(cmd, payload);
    });
    await page.goto(server.resolvedUrls!.local[0] + "?chat");
    await run({ page, emit, calls });
  } finally {
    await browser.close();
    await server.close();
  }
}

test("chat composer and translation pane keep zero horizontal overflow and anchor send button at 340px across native & studio skins", async () => {
  await withChatPage(
    { width: 340, height: 720 },
    (cmd) => {
      if (cmd === "chat_window_state")
        return { pinned: true, translations: false };
      if (cmd === "take_translations_request") return false;
      if (cmd === "take_pending_chat_files") return [];
      if (cmd === "current_chat_topic") return { id: 1, turns: [] };
      return null;
    },
    async ({ page, calls }) => {
      await page.waitForSelector(".chat-composer textarea");
      const deadline = Date.now() + 3000;
      while (
        !calls.some((c) => c.cmd === "take_pending_chat_files") &&
        Date.now() < deadline
      ) {
        await new Promise((r) => setTimeout(r, 20));
      }
      await page.evaluate(async () => {
        await Promise.all(
          document.getAnimations().map((a) => a.finished.catch(() => {})),
        );
      });

      for (const skin of ["native", "studio"] as const) {
        for (const theme of ["day", "night"] as const) {
          await page.evaluate(
            ({ skin, theme }) => {
              document.documentElement.dataset.skin = skin;
              document.documentElement.dataset.theme = theme;
              document.querySelector(".chat-status")!.textContent = "";
            },
            { skin, theme },
          );
          // Idle: empty .chat-status collapses to 0px height.
          const emptyHeight = await page
            .locator(".chat-status")
            .evaluate((el) => el.getBoundingClientRect().height);
          assert.equal(
            emptyHeight,
            0,
            `${skin}/${theme}: empty .chat-status must take 0px`,
          );

          // Long status hint wraps cleanly without pushing textarea or send off-screen.
          await page.evaluate(() => {
            const st = document.querySelector(".chat-status")!;
            st.textContent =
              "拖入文件支持图片，或 txt、md、docx、html、pdf，或者很长很长一段报错信息 https://example.com/very/long/unbroken/path/that/must/wrap";
          });
          const metrics = await page.evaluate(() => {
            const composer = document.querySelector(".chat-composer")!;
            const textarea = document.querySelector(".chat-composer textarea")!;
            const send = document.querySelector(".chat-tools [data-send]")!;
            const status = document.querySelector(".chat-status")!;
            const cr = composer.getBoundingClientRect();
            const tr = textarea.getBoundingClientRect();
            const sr = send.getBoundingClientRect();
            const str = status.getBoundingClientRect();
            return {
              scrollW: composer.scrollWidth,
              clientW: composer.clientWidth,
              sendRight: sr.right,
              winW: window.innerWidth,
              textareaRight: tr.right,
              statusHeight: str.height,
              statusRight: str.right,
              composerRight: cr.right,
              whiteSpace: getComputedStyle(status).whiteSpace,
            };
          });
          assert.ok(
            metrics.scrollW <= metrics.clientW + 1,
            `${skin}/${theme}: composer overflowed (${metrics.scrollW} > ${metrics.clientW})`,
          );
          assert.ok(
            metrics.sendRight <= metrics.winW,
            `${skin}/${theme}: send button pushed off-screen (${metrics.sendRight} > ${metrics.winW})`,
          );
          assert.ok(
            metrics.textareaRight <= metrics.winW,
            `${skin}/${theme}: textarea pushed off-screen`,
          );
          assert.ok(
            metrics.statusHeight > 20,
            `${skin}/${theme}: long status should wrap onto multiple lines`,
          );
          assert.ok(
            metrics.statusRight <= metrics.composerRight + 1,
            `${skin}/${theme}: status overflowed composer`,
          );
          assert.equal(metrics.whiteSpace, "normal");
        }
      }

      // Check translation pane footer output wrapping at 340px too.
      await page.evaluate(() => {
        document
          .querySelector<HTMLElement>(".chat-translation")!
          .removeAttribute("hidden");
        const out = document.querySelector<HTMLElement>(".tr-compose output")!;
        out.textContent = "";
      });
      const trEmptyH = await page
        .locator(".tr-compose output")
        .evaluate((el) => el.getBoundingClientRect().height);
      assert.equal(trEmptyH, 0, "empty .tr-compose output must take 0px");

      await page.evaluate(() => {
        document.querySelector<HTMLElement>(".tr-compose output")!.textContent =
          "翻译失败：这是一个很长的错误提示，在 340px 窄侧栏下应该完整换行显示而不能把按钮挤出屏幕";
      });
      const trMetrics = await page.evaluate(() => {
        const compose = document.querySelector(".tr-compose")!;
        const send = document.querySelector(".tr-compose [data-tr-send]")!;
        const out = document.querySelector(".tr-compose output")!;
        return {
          scrollW: compose.scrollWidth,
          clientW: compose.clientWidth,
          sendRight: send.getBoundingClientRect().right,
          winW: window.innerWidth,
          outHeight: out.getBoundingClientRect().height,
        };
      });
      assert.ok(trMetrics.scrollW <= trMetrics.clientW + 1);
      assert.ok(trMetrics.sendRight <= trMetrics.winW);
      assert.ok(trMetrics.outHeight > 20);
    },
  );
});

test("cold-start chat does not double-reload and ignores stale saved.translations; cold-start translations skips eager chat load and lazily loads on back", async () => {
  // 1) Cold-start into chat even when saved.translations === true
  await withChatPage(
    { width: 380, height: 700 },
    (cmd) => {
      if (cmd === "chat_window_state")
        return { pinned: true, translations: true };
      if (cmd === "take_translations_request") return false;
      if (cmd === "take_pending_chat_files") return [];
      if (cmd === "current_chat_topic")
        return {
          id: 7,
          turns: [{ question: "你好", answer: "在呢", at: Date.now() }],
        };
      return null;
    },
    async ({ page, calls }) => {
      await page.waitForFunction(() =>
        document.body.textContent?.includes("在呢"),
      );
      assert.equal(
        await page.locator(".chat-translation").isVisible(),
        false,
        "saved.translations must not override open_chat_window",
      );
      const loads = calls.filter((c) => c.cmd === "current_chat_topic").length;
      assert.equal(loads, 1, "cold-start chat must load current topic once");
    },
  );

  // 2) Cold-start straight into translations skips eager chat load, then lazily loads on `< 返回聊天`
  let trRequested = true;
  await withChatPage(
    { width: 380, height: 700 },
    (cmd) => {
      if (cmd === "chat_window_state")
        return { pinned: true, translations: true };
      if (cmd === "take_translations_request") {
        const out = trRequested;
        trRequested = false;
        return out;
      }
      if (cmd === "take_pending_chat_files") return [];
      if (cmd === "current_chat_topic")
        return {
          id: 8,
          turns: [{ question: "回来啦", answer: "懒加载成功", at: Date.now() }],
        };
      return null;
    },
    async ({ page, emit, calls }) => {
      await page.waitForSelector(".chat-translation:not([hidden])");
      assert.equal(
        calls.filter((c) => c.cmd === "current_chat_topic").length,
        0,
        "cold-start into translations must skip eager chat history load",
      );

      // Clicking `< 返回聊天` lazily loads chat history exactly once.
      await page.locator("[data-tr-back]").click();
      await page.waitForFunction(() =>
        document.body.textContent?.includes("懒加载成功"),
      );
      assert.equal(
        await page.locator(".chat-translation").isVisible(),
        false,
      );
      assert.equal(
        calls.filter((c) => c.cmd === "current_chat_topic").length,
        1,
      );

      // Warm switch to translations, then warm `chat-window-open` hides translations!
      trRequested = true;
      await emit("chat-translations", {});
      await page.waitForSelector(".chat-translation:not([hidden])");
      await emit("chat-window-open", {});
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>(".chat-translation")?.hidden ===
          true,
      );
    },
  );
});

test("pending shelf files attach images and documents on cold-start and warm chat-files-attached, closing topics and translations", async () => {
  let pendingFiles: string[] = [
    "/tmp/staged/photo.png",
    "/tmp/staged/notes.txt",
  ];
  let trRequested = false;

  await withChatPage(
    { width: 380, height: 700 },
    (cmd, payload) => {
      if (cmd === "chat_window_state")
        return { pinned: true, translations: false };
      if (cmd === "take_translations_request") {
        const out = trRequested;
        trRequested = false;
        return out;
      }
      if (cmd === "take_pending_chat_files") {
        const out = pendingFiles;
        pendingFiles = [];
        return out;
      }
      if (cmd === "chat_image_source") {
        assert.equal(payload.path, "/tmp/staged/photo.png");
        return TINY_PNG_B64;
      }
      if (cmd === "library_source") {
        assert.equal(payload.path, "/tmp/staged/notes.txt");
        return SAMPLE_TXT_B64;
      }
      if (cmd === "current_chat_topic") return { id: 1, turns: [] };
      return null;
    },
    async ({ page, emit }) => {
      // Cold-start pending files attach both image preview and document chip.
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>(".chat-attached")?.hidden ===
            false &&
          document.querySelectorAll(".chat-file-chip").length === 1,
      );
      assert.match(
        (await page.locator(".chat-file-chip").textContent()) ?? "",
        /notes\.txt/,
      );

      // Open topics drawer & translations, then fire warm `chat-files-attached`:
      // both translations and topics must close and the file must attach.
      await page.locator("header [data-topics]").click();
      assert.equal(
        await page.locator(".chat-view").getAttribute("data-topics"),
        "open",
      );
      trRequested = true;
      await emit("chat-translations", {});
      await page.waitForSelector(".chat-translation:not([hidden])");

      pendingFiles = ["/tmp/staged/notes.txt"];
      await emit("chat-files-attached", {});
      await page.waitForFunction(
        () =>
          document.querySelector<HTMLElement>(".chat-translation")?.hidden ===
            true &&
          document.querySelector(".chat-view")?.getAttribute("data-topics") ===
            "closed",
      );
    },
  );
});
