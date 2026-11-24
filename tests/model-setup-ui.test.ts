import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { createServer } from "vite";
import { chromium } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";
import {
  defaults,
  services,
  type ModelDraft,
  type CompanionSettings,
} from "../apps/shared/companion.ts";

const allowed = !!process.env.QA || process.env.GITHUB_ACTIONS === "true";
async function fixture() {
  const qa = process.env.QA ?? path.resolve("runs/ci-model-flow");
  const tmp = path.join(qa, "model-flow-tmp");
  await fs.mkdir(tmp, { recursive: true });
  const vite = await createServer({
    root: path.resolve("apps/desktop"),
    configLoader: "runner",
    cacheDir: path.join(qa, "model-flow-vite"),
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
    const ctx = await browser.newContext({
      viewport: { width: 1080, height: 900 },
      reducedMotion: "reduce",
    });
    await ctx.route(/^https?:/, (r) =>
      new URL(r.request().url()).origin === new URL(url).origin
        ? r.continue()
        : r.abort(),
    );
    const page = await ctx.newPage();
    const errors: string[] = [],
      calls: string[] = [];
    const state = {
      settings: { ...defaults, model: "" } as CompanionSettings,
      rejectSave: false,
      rejectModels: false,
    };
    const records = new Map<string, { draft: ModelDraft; revision: string }>();
    let next = 0,
      checked: ModelDraft | undefined;
    const bind = (d: ModelDraft) => d.service + " " + d.baseUrl;
    const view = (d: ModelDraft) => ({
      draft: d,
      hasKey: records.has(bind(d)),
      revision: records.get(bind(d))?.revision ?? "",
      active: false,
    });
    page.on("pageerror", (e) => errors.push(e.message));
    await bubbleBridge(page, async (cmd, p) => {
      calls.push(cmd);
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
      if (cmd === "companion_settings") return state.settings;
      if (cmd === "get_persona")
        return { petId: "fixture", text: "", defaultText: "" };
      if (cmd === "memory_view")
        return {
          petId: "fixture",
          user: { entries: [], used: 0, limit: 2000 },
          notes: { entries: [], used: 0, limit: 2200 },
        };
      if (cmd === "tool_cards") return { pending: [], tools: [] };
      if (cmd === "external_config") return { servers: [], grants: [] };
      if (
        [
          "list_documents",
          "list_reminders",
          "pending_reminders",
          "companion_usage",
        ].includes(cmd)
      )
        return [];
      if (["selection_access", "screen_access"].includes(cmd)) return false;
      if (cmd === "save_companion") {
        state.settings = { ...state.settings, ...p.settings };
        return state.settings;
      }
      if (cmd === "model_setup_view") {
        const info = services[p.service as keyof typeof services];
        const saved = [...records.values()].find(
          (r) => r.draft.service === p.service,
        );
        return view(
          p.draft ??
            saved?.draft ?? {
              service: p.service,
              baseUrl: info.baseUrl,
              protocol: info.protocol,
              model: "",
              visionModel: "",
              contextWindow: 32768,
              canSee: false,
            },
        );
      }
      if (cmd === "model_setup_save_key") {
        if (state.rejectSave)
          return { draft: p.draft, hasKey: false, revision: "", active: false };
        assert.equal(p.key, "fixture-only");
        records.set(bind(p.draft), {
          draft: p.draft,
          revision: "fixture-" + ++next,
        });
        return view(p.draft);
      }
      if (cmd === "model_setup_models") {
        if (state.rejectModels) throw Error("auth");
        return { models: ["fixture-model"], source: "service" };
      }
      if (cmd === "model_setup_test") {
        assert.ok(p.draft.model);
        assert.equal(p.revision, records.get(bind(p.draft))?.revision);
        checked = p.draft;
        return { ticket: "fixture-ticket", model: p.draft.model, firstMs: 1 };
      }
      if (cmd === "model_setup_use") {
        state.settings = {
          ...state.settings,
          ...checked!,
          enabled: true,
          modelVerified: true,
        };
        return state.settings;
      }
      throw Error("unexpected fixture command: " + cmd);
    });
    await page.goto(url);
    await page.locator('#blocks [data-block="settings"]').click();
    await page.locator("[data-onboard-model]").waitFor();
    const choose = async (service: string) => {
      await page.locator("[data-onboard-model]").click();
      await page.locator(`.model-services [data-service="${service}"]`).click();
      await page.waitForFunction(
        () =>
          !(document.querySelector('[name="secret"]') as HTMLInputElement)
            .disabled,
      );
    };
    return { page, state, calls, errors, choose, close };
  } catch (e) {
    await close();
    throw e;
  }
}

test(
  "official address is fixed and a saved key explains the remaining model step",
  { skip: !allowed },
  async () => {
    const f = await fixture();
    try {
      await f.choose("openai");
      assert.equal(
        await f.page.locator('[name="endpoint"]').inputValue(),
        services.openai.baseUrl,
      );
      assert.ok(
        await f.page
          .locator('[name="endpoint"]')
          .evaluate((e: HTMLInputElement) => e.readOnly),
      );
      await f.page.locator('[name="secret"]').fill("fixture-only");
      await f.page.locator("[data-save-key]").click();
      await f.page
        .locator("[data-key-status]")
        .filter({ hasText: "已保存" })
        .waitFor();
      assert.equal(await f.page.locator('[name="secret"]').inputValue(), "");
      assert.match(
        await f.page.locator("[data-next-action]").innerText(),
        /模型/,
      );
      assert.ok(await f.page.locator('[data-onboard="next"]').isDisabled());
      await f.page.locator('[name="chat-model"]').fill("fixture-model");
      await f.page.locator("[data-test]").click();
      await f.page.locator(".model-setup").waitFor({ state: "hidden" });
      assert.equal(f.state.settings.modelVerified, true);
      await f.page.locator('[data-onboard="next"]').click();
      await f.page.getByRole("heading", { name: "两个系统权限" }).waitFor();
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  },
);

test(
  "test-and-use saves a newly entered key without an extra mandatory save click",
  { skip: !allowed },
  async () => {
    const f = await fixture();
    try {
      await f.choose("deepseek");
      await f.page.locator('[name="secret"]').fill("fixture-only");
      await f.page.locator('[name="chat-model"]').fill("fixture-model");
      await f.page.locator("[data-test]").click();
      await f.page
        .locator(".model-setup")
        .waitFor({ state: "hidden", timeout: 4000 });
      assert.deepEqual(
        f.calls.filter((s) =>
          [
            "model_setup_save_key",
            "model_setup_test",
            "model_setup_use",
          ].includes(s),
        ),
        ["model_setup_save_key", "model_setup_test", "model_setup_use"],
      );
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  },
);

test(
  "failed saves retain input, discovery stops waiting, and back really goes back",
  { skip: !allowed },
  async () => {
    const f = await fixture();
    try {
      await f.choose("openai");
      f.state.rejectSave = true;
      await f.page.locator('[name="secret"]').fill("fixture-only");
      await f.page.locator("[data-save-key]").click();
      await f.page.waitForFunction(
        () =>
          !(document.querySelector('[name="secret"]') as HTMLInputElement)
            .disabled,
      );
      assert.equal(
        await f.page.locator('[name="secret"]').inputValue(),
        "fixture-only",
      );
      f.state.rejectSave = false;
      await f.page.locator("[data-save-key]").click();
      await f.page
        .locator("[data-key-status]")
        .filter({ hasText: "已保存" })
        .waitFor();
      f.state.rejectModels = true;
      await f.page.locator("[data-models]").click();
      await f.page
        .locator("[data-result]")
        .filter({ hasText: "Key" })
        .waitFor();
      assert.ok(
        !(await f.page.locator("[data-list-note]").innerText()).includes(
          "正在获取",
        ),
      );
      await f.page.locator("[data-cancel]").click();
      assert.ok(await f.page.locator(".model-services").isVisible());
      await f.page.locator("[data-close]").click();
      await f.page.locator('[data-onboard="later"]').click();
      assert.ok(await f.page.locator(".onboard").isHidden());
      await f.page.locator('[name="memory"]').uncheck();
      await f.page
        .locator('.companion-page output[role="status"]')
        .filter({ hasText: "已保存" })
        .waitFor();
      assert.ok(await f.page.locator(".onboard").isHidden());
      assert.deepEqual(f.errors, []);
    } finally {
      await f.close();
    }
  },
);
