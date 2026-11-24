// 切换宠物后打开「性格」：必须立刻显示当前宠物的性格（不能停留在第一只宠物），
// 保存时带上当前宠物的 petId，且底部只有「恢复默认」「保存」（无「试一句」）。
import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";
import { defaults } from "../apps/shared/companion.ts";

const spriteDataUrl =
  "data:image/webp;base64," +
  fs.readFileSync(path.resolve("examples/lizi/spritesheet.webp")).toString("base64");

let server: ViteDevServer;
let browser: Browser;

test.before(async () => {
  server = await createServer({
    root: path.resolve("apps/desktop"),
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

test("切换宠物后打开性格显示新宠物内容并保存到对应 petId，且不再有试一句按钮", async () => {
  const page = await browser.newPage({ viewport: { width: 1180, height: 820 } });
  const pets = [
    {
      id: "pink-pig",
      displayName: "粉色小猪",
      description: "爱吃草莓的粉色小猪",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.webp",
      fingerprint: "fp-pink-pig",
      revision: "1",
    },
    {
      id: "lizi",
      displayName: "栗子",
      description: "爱打盹的小橘猫",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.webp",
      fingerprint: "fp-lizi",
      revision: "1",
    },
  ];
  const personas: Record<string, string> = {
    "pink-pig": "爱吃草莓的粉色小猪\n说话方式：软绵绵的",
    lizi: "爱打盹的小橘猫\n说话方式：慢悠悠的",
  };
  let activeId = "pink-pig";
  const savedCalls: Array<{ petId: string; text: string | null }> = [];
  const makeSnapshot = () => ({
    pets,
    drafts: [],
    custom: {},
    settings: {
      activeId,
      visible: true,
      paused: false,
      size: 160,
      position: null,
      behaviors: {},
      theme: "day",
      skin: "native",
    },
  });

  let emit!: (event: string, payload: any) => Promise<void>;
  emit = await bubbleBridge(page, async (cmd, p) => {
    if (cmd === "get_state") return makeSnapshot();
    if (cmd === "get_settings") return makeSnapshot().settings;
    if (cmd === "read_sprite") return spriteDataUrl;
    if (cmd === "save_settings") {
      if (p?.settings?.activeId) activeId = p.settings.activeId;
      const snap = makeSnapshot();
      queueMicrotask(() => void emit("library-changed", snap));
      return snap;
    }
    if (cmd === "companion_settings") return { ...defaults, enabled: true };
    if (cmd === "tips_state") return { guideShown: true, seen: [] };
    if (cmd === "get_persona") {
      return {
        petId: activeId,
        text: personas[activeId],
        defaultText: personas[activeId],
      };
    }
    if (cmd === "save_persona") {
      savedCalls.push({ petId: p.petId, text: p.text });
      if (typeof p.text === "string") personas[p.petId] = p.text;
      return null;
    }
    if (cmd === "memory_view") {
      return {
        petId: activeId,
        user: { entries: [], used: 0, limit: 2000 },
        notes: { entries: [], used: 0, limit: 2200 },
      };
    }
    if (cmd === "companion_usage") return {};
    if (cmd === "tool_cards") return { pending: [], tools: [] };
    if (cmd === "external_config") return { servers: [], grants: [] };
    if (
      [
        "list_documents",
        "list_reminders",
        "pending_reminders",
        "focus_records",
        "clipboard_list",
      ].includes(cmd)
    )
      return [];
    if (["screen_access", "selection_access"].includes(cmd)) return true;
    return null;
  });

  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(
    () => document.querySelector("#name")?.textContent === "粉色小猪",
  );

  // Switch from 粉色小猪 -> 栗子 in the left roster.
  await page.locator('.pet-tile[aria-label="栗子"]').click();
  await page.waitForFunction(
    () => document.querySelector("#name")?.textContent === "栗子",
  );

  // Open 性格 sheet: must immediately show 栗子's personality, never 粉色小猪's.
  await page.locator("#controls .persona-row").click();
  const sheet = page.locator("dialog.persona-sheet[open]");
  await sheet.waitFor();
  assert.equal(await sheet.locator("#persona-title").textContent(), "栗子的性格");
  assert.equal(
    await sheet.locator("textarea").inputValue(),
    "爱打盹的小橘猫\n说话方式：慢悠悠的",
  );
  const buttons = await sheet
    .locator(".persona-foot button")
    .evaluateAll((bs) => bs.map((b) => b.textContent));
  assert.deepEqual(buttons, ["恢复默认", "保存"]);

  // Save must send 栗子's petId, not 粉色小猪's.
  await sheet.locator("textarea").fill("栗子的新性格");
  await sheet.locator("[data-persona-save]").click();
  await page.waitForFunction(
    () =>
      document.querySelector("[data-persona-output]")?.textContent ===
      "性格已保存，下个话题生效",
  );
  assert.deepEqual(savedCalls, [{ petId: "lizi", text: "栗子的新性格" }]);

  await page.close();
});
