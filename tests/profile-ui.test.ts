import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";
import { defaults } from "../apps/shared/companion.ts";

const allowed = !!process.env.QA || process.env.GITHUB_ACTIONS === "true";
test(
  "profile editor saves independently, retains failed drafts and keeps all three skins usable",
  { skip: !allowed },
  async () => {
    const qa = process.env.QA ?? path.resolve("runs/ci-profile-tests");
    const tmp = path.join(qa, "profile-ui-tmp");
    await fs.mkdir(tmp, { recursive: true });
    const vite = await createServer({
      root: path.resolve("apps/desktop"),
      configLoader: "runner",
      cacheDir: path.join(qa, "profile-vite"),
      server: { host: "127.0.0.1", port: 0 },
      logLevel: "error",
    });
    await vite.listen();
    const url = vite.resolvedUrls!.local[0];
    let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
    try {
      browser = await chromium.launch({
        channel: "chrome",
        args: ["--disable-background-networking"],
        env: { ...process.env, TMPDIR: tmp, TMP: tmp, TEMP: tmp },
      });
      const context = await browser.newContext({
        viewport: { width: 1080, height: 900 },
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
      let profile = "我叫测试甲，在做随伴项目。\n回答时先说结论。",
        fail = false;
      const entries = ["喜欢乌龙茶。", "经常在晚上整理项目资料。"];
      const calls: any[] = [];
      let pauseSave = false;
      let resumeSave!: () => void;
      const delayedSave = new Promise<void>(
        (resolve) => (resumeSave = resolve),
      );
      let migration:
        { undone: boolean; canUndo: boolean; entries: string[] } | undefined;
      const view = () => ({
        petId: "fixture",
        profile: {
          text: profile,
          used: [...profile].length,
          limit: 2000,
          migration,
        },
        user: { entries, used: entries.join("\n§\n").length, limit: 2000 },
        notes: { entries: ["项目测试全部使用假数据。"], used: 14, limit: 2200 },
      });
      const emit = await bubbleBridge(page, async (cmd, p) => {
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
        if (cmd === "companion_settings")
          return { ...defaults, enabled: true, modelVerified: true };
        if (cmd === "get_persona")
          return { petId: "fixture", text: "", defaultText: "" };
        if (cmd === "tool_cards") return { pending: [], tools: [] };
        if (cmd === "external_config") return { servers: [], grants: [] };
        if (cmd === "memory_view") return view();
        if (cmd === "memory_edit") {
          calls.push(p);
          if (pauseSave) await delayedSave;
          if (fail) throw Error("测试写入失败");
          if (p.profile !== undefined) profile = p.profile;
          else if (p.profileAction) {
            migration!.undone = p.profileAction === "undo";
            profile = migration!.undone ? "" : migration!.entries.join("\n");
          } else if (p.operations?.[0].action === "remove")
            entries.splice(entries.indexOf(p.operations[0].old_text), 1);
          else if (p.operations?.[0].action === "patch")
            entries[entries.indexOf(p.operations[0].old_text)] =
              p.operations[0].content;
          return view();
        }
        if (
          [
            "list_documents",
            "list_reminders",
            "pending_reminders",
            "companion_usage",
            "chat_history",
          ].includes(cmd)
        )
          return [];
        return null;
      });
      await page.goto(url);
      await page.locator('#blocks [data-block="memory"]').click();
      const input = page.getByRole("textbox", { name: "我写的", exact: true });
      await input.waitFor({ timeout: 4000 });
      assert.equal(await input.inputValue(), profile);
      assert.equal(await page.locator(".memo-chips").count(), 0);
      assert.equal(
        await page.getByRole("heading", { name: "它记住的" }).count(),
        1,
      );
      await input.fill("新的测试资料\n保留换行");
      await emit("memory-changed", {});
      assert.equal(
        await input.inputValue(),
        "新的测试资料\n保留换行",
        "pet updates must not discard an unsaved draft",
      );
      fail = true;
      await page.locator("[data-profile-save]").click();
      await page
        .locator("[data-profile-status]")
        .filter({ hasText: "测试写入失败" })
        .waitFor();
      assert.equal(await input.inputValue(), "新的测试资料\n保留换行");
      assert.notEqual(profile, "新的测试资料\n保留换行");
      fail = false;
      await page.locator("[data-profile-save]").click();
      await page
        .locator("[data-profile-status]")
        .filter({ hasText: "已保存" })
        .waitFor();
      assert.equal(profile, "新的测试资料\n保留换行");
      assert.equal(calls.at(-1).operations, undefined);
      assert.equal(entries.length, 2);
      await input.fill("🐈".repeat(2001));
      assert.equal([...(await input.inputValue())].length, 2000);
      await input.fill("我叫测试甲，在做随伴项目。\n回答时先说结论。");
      await page.locator("[data-profile-save]").click();
      await page
        .locator("[data-profile-status]")
        .filter({ hasText: "已保存" })
        .waitFor();
      for (const skin of ["studio", "native"])
        for (const theme of ["day", "night"]) {
          await page.evaluate(
            async ([skin, theme]) => {
              const { applySkin } = await import(
                /* @vite-ignore */ "/src/skin.ts"
              );
              await applySkin(skin);
              document.documentElement.dataset.theme = theme;
            },
            [skin, theme],
          );
          await input.waitFor({ state: "visible" });
          assert.ok(await page.locator("[data-profile-save]").isEnabled());
          if (process.env.PROFILE_CAPTURES) {
            await fs.mkdir(process.env.PROFILE_CAPTURES, { recursive: true });
            await page.locator('.block[data-for="memory"]').screenshot({
              path: path.join(
                process.env.PROFILE_CAPTURES,
                `${skin}-${theme}.png`,
              ),
              animations: "disabled",
            });
          }
        }
      await page
        .locator(".memo-list .companion-entry")
        .first()
        .getByRole("button", { name: "改", exact: true })
        .click();
      await page.locator(".memo-list textarea").fill("修正后的记忆");
      await page
        .locator(".memo-list")
        .getByRole("button", { name: "保存", exact: true })
        .click();
      await page.getByText("修正后的记忆", { exact: true }).waitFor();
      assert.equal(entries[0], "修正后的记忆");
      migration = { undone: false, canUndo: true, entries: [profile] };
      await emit("memory-changed", {});
      await page.getByRole("button", { name: "撤销迁移", exact: true }).click();
      await page
        .getByRole("button", { name: "重新迁移", exact: true })
        .waitFor();
      assert.equal(calls.at(-1).profileAction, "undo");
      assert.equal(await input.inputValue(), "");
      await page.getByRole("button", { name: "重新迁移", exact: true }).click();
      await page
        .getByRole("button", { name: "撤销迁移", exact: true })
        .waitFor();
      assert.equal(calls.at(-1).profileAction, "migrate");
      assert.ok(await input.inputValue());
      pauseSave = true;
      await input.fill("切换页签时保存的资料");
      await page.locator("[data-profile-save]").click();
      await page.getByRole("tab", { name: "笔记", exact: true }).click();
      resumeSave();
      await page.waitForTimeout(200);
      await page.getByRole("tab", { name: "关于你", exact: true }).click();
      await input.waitFor();
      assert.equal(await input.inputValue(), "切换页签时保存的资料");
      assert.deepEqual(errors, []);
    } finally {
      await browser?.close();
      await vite.close();
    }
  },
);
