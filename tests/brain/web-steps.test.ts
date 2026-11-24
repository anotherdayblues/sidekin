import assert from "node:assert/strict";
import test from "node:test";
import { toolSteps } from "../../apps/brain/src/toolSteps.ts";
import { webTools } from "../../apps/brain/src/web.ts";
test("搜索、成功读取和失败读取只留下对应的元数据", async () => {
  const pages = ["a", "b"].map((n) => ({
    title: n,
    url: "https://example.org/" + n,
  }));
  const sources: object[] = [];
  const [search, read] = webTools(
    { provider: "glm", apiKey: "fixture", baseUrl: "" },
    "",
    "t",
    async (url) => {
      if (url.endsWith("/b")) throw Error("对方拒绝访问");
      return { plain: true, html: "不保存的正文" };
    },
    async () => pages.map((p) => ({ ...p, summary: "不保存的摘要" })),
    undefined,
    undefined,
    (p) => sources.push(p),
  );
  const trace = toolSteps(() => {});
  for (const [tool, args] of [
    [search, { query: "关键词" }],
    [read, { url: pages[0].url }],
    [read, { url: pages[1].url }],
  ] as const) {
    trace.start("reused", tool.name, tool.label, args);
    try {
      const result = await tool.execute("reused", args);
      trace.finish(
        "reused",
        result as Parameters<typeof trace.finish>[1],
        false,
      );
    } catch (e) {
      trace.finish(
        "reused",
        { content: [{ text: (e as Error).message }] },
        true,
      );
    }
  }
  const steps = trace.snapshot();
  assert.deepEqual(
    steps.map((s) => s.count),
    [2, 1, 0],
  );
  assert.deepEqual(steps[0].pages, pages);
  assert.deepEqual(steps[1].pages, sources);
  assert.equal(steps[2].reason, "对方拒绝访问");
  assert.doesNotMatch(JSON.stringify(steps), /不保存/);
});

test("空结果之后允许模型换词再查", async () => {
  const queries: string[] = [];
  const notices: string[] = [];
  const [search] = webTools(
    { provider: "glm", apiKey: "fixture", baseUrl: "" },
    "",
    "t",
    undefined,
    async (_cfg, query) => {
      queries.push(query);
      return query === "新词"
        ? [{ title: "页面", url: "https://example.org/", summary: "摘要" }]
        : [];
    },
    undefined,
    undefined,
    undefined,
    (msg) => notices.push(msg),
  );
  for (const query of ["原词", "原词", "新词"])
    await search.execute("id", { query });
  assert.deepEqual(queries, ["原词", "新词"]);
  assert.deepEqual(notices, ["这次没查到。", ""]);
});

test("工具前的文字长度随步骤保存，后续回复仍属于同一轮", async (t) => {
  const intro = "我去看一下🔎。";
  const { fakeModel } = await import("./fake-model.ts");
  const { launch } = await import("./client.ts");
  const endpoint = await fakeModel([
    { tool: "read_badge", intro },
    { chunks: ["查到了。"] },
  ]);
  t.after(endpoint.close);
  const brain = launch();
  t.after(brain.close);
  await brain.request("initialize", {
    service: "custom",
    model: "fixture",
    apiKey: "test",
    baseUrl: endpoint.baseUrl,
  });
  const answer = await brain.request("chat", {
    text: "读名牌",
    probeTool: true,
  });
  assert.equal(answer.result?.text, intro + "查到了。");
  assert.equal(answer.result?.steps[0].textOffset, intro.length);
});
