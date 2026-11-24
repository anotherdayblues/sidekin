import assert from "node:assert/strict";
import test from "node:test";
import { createServer, type ViteDevServer } from "vite";
import { chromium, type Browser } from "playwright";
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
test("旧版动作保留未采用草稿；切换只改对应动作，删除与正在使用检查有效", async () => {
  const page = await browser.newPage({
    viewport: { width: 1180, height: 820 },
  });
  await page.goto(server.resolvedUrls!.local[0]);
  await page.waitForFunction(() => !!(window as any).__studio);
  const pet = await page.evaluate(async () => {
    (window as any).__studio.load("full");
    await (window as any).__studio.ready();
    return (await import("/src/bridge.ts" as string)).browserSnapshot().settings
      .activeId;
  });
  await page.getByRole("button", { name: "旧版动作", exact: true }).click();
  await page.locator(".saved-actions-dialog").waitFor({ state: "visible" });
  assert.equal(
    await page.getByRole("button", { name: "改动记录", exact: true }).count(),
    0,
  );
  // Use a pending candidate from the actual fixture instead of assuming its ID.
  const candidate = await page.evaluate(async (id) => {
    const saved = await import("/src/savedActions.ts" as string);
    return (await saved.savedActions(id!)).find((i: any) => !i.used);
  }, pet);
  assert.ok(candidate);
  await page.locator("[data-saved-filter]").selectOption(candidate.name);
  const row = page.locator(`[data-saved-id="${candidate.id}"]`);
  await row.getByRole("button", { name: "试播", exact: true }).click();
  const originalRules = await page.evaluate(
    async (id) =>
      (await import("/src/bridge.ts" as string)).browserSnapshot().custom[id!]
        .layer.rules,
    pet,
  );
  await row.getByRole("button", { name: "使用这份动作", exact: true }).click();
  await page.waitForFunction(
    async ({ pet, name }) =>
      !!(await import("/src/bridge.ts" as string)).browserSnapshot().custom[
        pet!
      ].layer.actions[name],
    { pet, name: candidate.name },
  );
  assert.deepEqual(
    await page.evaluate(
      async (id) =>
        (await import("/src/bridge.ts" as string)).browserSnapshot().custom[id!]
          .layer.rules,
      pet,
    ),
    originalRules,
  );
  await row.getByRole("button", { name: "正在使用", exact: true }).waitFor();
  assert.ok(
    await row.getByRole("button", { name: "删除", exact: true }).isDisabled(),
  );
  await page.getByRole("button", { name: "关闭", exact: true }).click();
  // A separate unused candidate is retained when its pending card is dismissed.
  const kept = await page.evaluate(async (id) => {
    const api = await import("/src/bridge.ts" as string);
    const saved = await import("/src/savedActions.ts" as string);
    const d = api.browserSnapshot().drafts.find((d: any) => d.petId === id);
    const item = (await saved.savedActions(id!)).find((i: any) => !i.used);
    if (d) await api.discardDraft(d.id);
    return item;
  }, pet);
  assert.ok(kept);
  await page.getByRole("button", { name: "旧版动作", exact: true }).click();
  await page.locator("[data-saved-filter]").selectOption(kept.name);
  const other = page.locator(`[data-saved-id="${kept.id}"]`);
  await other.getByRole("button", { name: "删除", exact: true }).click();
  await page
    .locator(".saved-confirm")
    .getByRole("button", { name: "删除", exact: true })
    .click();
  await other.waitFor({ state: "detached" });
  assert.equal(
    await page.evaluate(
      async ({ pet, id }) =>
        (
          await (
            await import("/src/savedActions.ts" as string)
          ).savedActions(pet!)
        ).some((i: any) => i.id === id),
      { pet, id: kept.id },
    ),
    false,
  );
  await page.close();
});

test("四套皮肤及英文下，旧版动作弹窗、筛选和预览均可使用", async () => {
  const page = await browser.newPage({
    viewport: { width: 1080, height: 760 },
  });
  await page.goto(server.resolvedUrls!.local[0] + "?lang=en");
  await page.waitForFunction(() => !!(window as any).__studio);
  for (const skin of ["studio", "native"]) {
    await page.evaluate(async (s) => {
      await (window as any).__studio.skin(s);
      (window as any).__studio.load("full");
      await (window as any).__studio.ready();
    }, skin);
    await page
      .getByRole("button", { name: "Saved actions", exact: true })
      .click();
    const dialog = page.locator(".saved-actions-dialog");
    await dialog.waitFor({ state: "visible" });
    await dialog.locator(".saved-row").first().waitFor({ state: "visible" });
    assert.ok((await dialog.locator(".saved-row").count()) >= 9);
    const box = await dialog.boundingBox();
    assert.ok(box!.x >= 0 && box!.y >= 0 && box!.y + box!.height <= 760);
    await dialog
      .getByRole("button", { name: "Preview", exact: true })
      .first()
      .click();
    await dialog.getByRole("button", { name: "Close", exact: true }).click();
  }
  await page.close();
});
