import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "vite";
import { chromium, webkit } from "playwright";

test("工具夹在前后两段文字之间，重读历史保持顺序，旧记录照常显示", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0 },
  });
  await server.listen();
  try {
    for (const engine of [webkit, chromium]) {
      const browser = await engine.launch(
        engine === chromium ? { channel: "chrome" } : {},
      );
      try {
        const page = await browser.newPage();
        await page.addInitScript({content: "globalThis.__name = f => f"});
        await page.goto(server.resolvedUrls!.local[0] + "?fixture");
        const result = await page.evaluate(async () => {
          const { chatMessages, fromTurns } =
            await import("/src/chatMessages.ts");
          const log = chatMessages(document.body, "");
          const before = "我查一下🔎。",
            middle = "再核对一下。",
            final = "这是结果。";
          const search = {
            name: "web_search",
            label: "搜索",
            status: "ok",
            textOffset: before.length,
          };
          const steps = [
            search,
            { ...search },
            { ...search, textOffset: (before + middle).length },
          ];
          function order() {
            return [
              ...log.el.querySelectorAll(
                '.chat-row[data-from="pet"] .chat-text,.chat-row[data-from="pet"] .tool-fold > button',
              ),
            ].map((e) => e.textContent?.trim());
          }
          log.push({ role: "pet", text: before, at: 1, streaming: true });
          log.patchLast({ steps: steps.slice(0, 2) });
          log.patchLast({ text: before + middle });
          log.patchLast({ steps });
          log.patchLast({ text: before + middle + final });
          const live = order();
          const record = {
            question: "查查",
            answer: before + middle + final,
            at: 1,
            steps,
          };
          log.set(fromTurns([record]));
          const reopened = order();
          log.set(
            fromTurns([
              {
                ...record,
                steps: [{ name: "web_search", label: "搜索", status: "ok" }],
              },
            ]),
          );
          return { live, reopened, legacy: order() };
        });
        const expected = [
          "我查一下🔎。",
          "搜索了 2 次",
          "再核对一下。",
          "搜索了 1 次",
          "这是结果。",
        ];
        assert.deepEqual(result.live, expected);
        assert.deepEqual(result.reopened, expected);
        assert.deepEqual(result.legacy, [
          "搜索了 1 次",
          "我查一下🔎。再核对一下。这是结果。",
        ]);
      } finally {
        await browser.close();
      }
    }
  } finally {
    await server.close();
  }
});
