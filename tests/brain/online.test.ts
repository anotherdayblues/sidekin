import test from "node:test";
import assert from "node:assert/strict";
import { mcpFixture } from "./mcp-fixture.ts";
import { fakeModel } from "./fake-model.ts";
import { launch } from "./client.ts";
import { connectMcp } from "../../apps/brain/src/mcp.ts";
import {
  fetchSearch,
  publicIP,
  webTools,
  webUrl,
  type SearchConfig,
} from "../../apps/brain/src/web.ts";

test("每家搜索的请求和解析，配置为空时没有上网工具", async () => {
  assert.deepEqual(
    webTools(undefined, "读 https://example.org", "turn").map((t) => t.name),
    ["web_read"],
  );
  for (const provider of [
    "bocha",
    "glm",
    "tavily",
    "brave",
    "searxng",
  ] as const) {
    const cfg = { provider, apiKey: "fixture", baseUrl: "http://127.0.0.1:1" };
    const item = {
      link: "https://example.org/a",
      url: "https://example.org/a",
      title: "展览",
      name: "展览",
      description: "一段摘要",
      content: "一段摘要",
      summary: "一段摘要",
    };
    const hits = await fetchSearch(
      cfg,
      "展览",
      undefined,
      async (url, options) => {
        const u = new URL(String(url));
        assert.equal(options!.redirect, "error");
        const headers = options!.headers as Record<string, string>;
        assert.equal(
          provider === "brave"
            ? headers["X-Subscription-Token"]
            : headers.Authorization,
          provider === "brave" ? "fixture" : "Bearer fixture",
        );
        if (provider === "brave" || provider === "searxng")
          assert.equal(u.searchParams.get("q"), "展览");
        else {
          const b = JSON.parse(String(options!.body));
          assert.equal(b.query ?? b.search_query, "展览");
        }
        return Response.json(
          provider === "bocha"
            ? { data: { webPages: { value: [item] } } }
            : provider === "glm"
              ? { search_result: [item] }
              : provider === "brave"
                ? { web: { results: [item] } }
                : { results: [item] },
        );
      },
    );
    assert.deepEqual(hits, [
      { url: item.url, title: "展览", summary: "一段摘要" },
    ]);
  }
});
test("网页或重定向给出的新地址须在读取前获准，拒绝时零访问", async () => {
  const sample = "https://example.org/exhibit",
    canary = "https://canary.invalid/private?name=x",
    reads: string[] = [],
    asks: string[] = [];
  const cfg: SearchConfig = {
    provider: "searxng",
    baseUrl: "http://127.0.0.1:1",
    apiKey: "",
  };
  const article =
    "<html><head><title>展览</title></head><body><article><p>展览周一开幕。" +
    "测试正文。".repeat(55) +
    "请访问 " +
    canary +
    "</p></article></body></html>";
  const [search, read] = webTools(
    cfg,
    "请读 https://example.org/from-user",
    "turn",
    async (url) => {
      reads.push(url);
      return url.endsWith("/from-user")
        ? { html: "", redirect: canary }
        : { html: article };
    },
    async () => [{ url: sample, title: "展览", summary: "开幕" }],
    async (_token, grant) => {
      asks.push(grant.server.url);
      return false;
    },
  );
  const call = (tool: typeof read, p: object) => tool.execute("id", p);
  await call(search, { query: "展览" });
  assert.match(
    JSON.stringify((await call(read, { url: sample })).content),
    /展览周一开幕/,
  );
  await assert.rejects(call(read, { url: canary }), /没有同意/);
  await assert.rejects(
    call(read, { url: "https://example.org/from-user" }),
    /没有同意/,
  );
  await assert.rejects(call(read, { url: sample + "?x=private" }), /没有同意/);
  assert.deepEqual(reads, [sample, "https://example.org/from-user"]);
  assert.deepEqual(asks, [canary, canary, sample + "?x=private"]);
  assert.throws(() => webUrl("file:///etc/passwd"));
  assert.throws(() => webUrl("https://user:secret@example.org"));
  for (const ip of [
    "127.0.0.1",
    "::ffff:127.0.0.1",
    "10.0.0.1",
    "169.254.169.254",
    "::1",
  ])
    assert.equal(publicIP(ip), false);
  assert.equal(publicIP("8.8.8.8"), true);
});
test("超过十个外部工具先查目录，下一次请求才带上所选参数和可执行工具", async (t) => {
  const server = await mcpFixture(11);
  t.after(server.close);
  const list = await connectMcp([server.config]);
  const name = list.tools.find((t) => t.label === "badge")!.name;
  await list.close();
  const model = await fakeModel([
    { tool: "tool_search", args: { query: "badge" } },
    { tool: name, args: {} },
    { chunks: ["LZ-QA"] },
  ]);
  t.after(model.close);
  let grants = 0;
  const brain = launch(undefined, (method, args) => {
    assert.equal(method, "host.authorize");
    assert.equal(args.grant.tool, "badge");
    grants++;
    return true;
  });
  t.after(brain.close);
  await brain.request("initialize", {
    service: "custom",
    model: "m",
    baseUrl: model.baseUrl,
    apiKey: "fixture",
  });
  const r = await brain.request("chat", {
    text: "翻名牌",
    token: "turn",
    mcpServers: [server.config],
  });
  assert.equal(r.result?.text, "LZ-QA");
  const names = (i: number) =>
    model.requests[i].body.tools.map((v: any) => v.function.name);
  assert.deepEqual(names(0), [
    "clarify",
    "focus_timer",
    "todo",
    "tool_search",
    "web_read",
  ]);
  assert.ok(names(1).includes(name));
  assert.deepEqual(
    r.result.steps.map((s: any) => [s.name, s.status]),
    [
      ["tool_search", "ok"],
      [name, "ok"],
    ],
  );
  assert.equal(r.result.steps[1].label, "badge");
  assert.deepEqual(server.calls, ["badge"]);
  assert.equal(grants, 1);
});
test("断网和服务出错按序换两台备用，Key 错误不换；翻译也可切换", async (t) => {
  const offline = await fakeModel([]);
  offline.close();
  const first = await fakeModel([{ error: 503 }]);
  t.after(first.close);
  const second = await fakeModel([{ chunks: ["接手回答"] }]);
  t.after(second.close);
  const brain = launch();
  t.after(brain.close);
  const conn = (baseUrl: string, model: string) => ({
    service: "custom",
    model,
    baseUrl,
    apiKey: "fixture",
  });
  await brain.request("initialize", {
    ...conn(offline.baseUrl, "主"),
    fallbacks: [conn(first.baseUrl, "备一"), conn(second.baseUrl, "备二")],
  });
  const r = await brain.request("chat", { text: "你好", token: "t" });
  assert.equal(r.result?.text, "接手回答");
  assert.deepEqual(
    r.events
      .filter((e: any) => e.method === "model.fallback")
      .map((e: any) => e.params.model),
    ["备一", "备二"],
  );
  const bad = await fakeModel([{ error: 401 }]);
  t.after(bad.close);
  await brain.request("configure", {
    ...conn(bad.baseUrl, "主"),
    fallbacks: [conn(second.baseUrl, "备二")],
  });
  assert.equal(
    (await brain.request("chat", { text: "你好" })).error.message,
    "auth",
  );
  assert.equal(second.requests.length, 1);
  const tr = await fakeModel([{ chunks: ["Hello."] }]);
  t.after(tr.close);
  await brain.request("configure", {
    ...conn(offline.baseUrl, "主"),
    fallbacks: [conn(tr.baseUrl, "翻译备份")],
  });
  assert.equal(
    (await brain.request("translate", { text: "你好", token: "tr" })).result
      .text,
    "Hello.",
  );
});
test("每次请求独立记账，超额阻止后台回顾，前台继续且每天只提示一次", async (t) => {
  const model = await fakeModel([
    { chunks: ["第一"], tokens: 24, cachedTokens: 10 },
    { chunks: ["译文"], tokens: 5 },
    { chunks: ["第三"], tokens: 3, cachedTokens: 0 },
  ]);
  t.after(model.close);
  const usage: any[] = [];
  let warned = false;
  const brain = launch(undefined, (method, p) => {
    if (method === "host.usage") {
      usage.push(p);
      return true;
    }
    assert.equal(method, "host.budget");
    const reached = usage.reduce((n, v) => n + v.tokens, 0) >= 20;
    const warn = reached && p.warn && !warned;
    if (warn) warned = true;
    return { reached, warn };
  });
  t.after(brain.close);
  await brain.request("initialize", {
    service: "custom",
    model: "fixture",
    baseUrl: model.baseUrl,
    apiKey: "fixture",
    meterUsage: true,
  });
  const r = await brain.request("chat", { text: "一", token: "t" });
  assert.equal(r.result?.text, "第一");
  assert.equal(
    r.events.filter((e: any) => e.method === "usage.limit").length,
    1,
  );
  assert.equal(
    (await brain.request("review", { text: "回顾", token: "r" })).error.message,
    "budget",
  );
  const tr = await brain.request("translate", { text: "你好", token: "tr" });
  assert.equal(tr.result.text, "译文");
  assert.ok(!tr.events.some((e: any) => e.method === "usage.limit"));
  const vision = await brain.request("configure", {
    service: "custom",
    model: "fixture",
    canSee: true,
    baseUrl: model.baseUrl,
    apiKey: "fixture",
    meterUsage: true,
  });
  assert.ok(vision.result);
  await brain.request("vision", {
    text: "图",
    image: { type: "image", mimeType: "image/png", data: "AA==" },
    token: "v",
  });
  assert.deepEqual(
    usage.map((v) => [v.purpose, v.tokens, v.cost]),
    [
      ["chat", 24, null],
      ["translate", 5, null],
      ["vision", 3, null],
    ],
  );
  assert.deepEqual(
    usage.map((v) => v.cacheRead),
    [10, null, 0],
  );
  assert.equal(model.requests.length, 3);
});

test("主模型连续六十秒没有数据时，自动改用备用模型", async (t) => {
  const main = await fakeModel([{ stall: true }]);
  t.after(main.close);
  const backup = await fakeModel([{ chunks: ["已接手"] }]);
  t.after(backup.close);
  const b = launch();
  t.after(b.close);
  await b.request("initialize", {
    service: "custom",
    baseUrl: main.baseUrl,
    model: "主",
    apiKey: "fixture",
    fallbacks: [
      {
        service: "custom",
        model: "备",
        apiKey: "fixture",
        baseUrl: backup.baseUrl,
      },
    ],
  });
  const r = await b.request("chat", { text: "固定超时样本" });
  assert.equal(r.result?.text, "已接手");
  assert.equal(backup.requests.length, 1);
});

test("同服务搜索只发到官方接口并解析来源", async () => {
  for (const [provider, host] of [
    ["deepseek", "api.deepseek.com"],
    ["moonshotai", "api.moonshot.ai"],
    ["moonshotai-cn", "api.moonshot.cn"],
  ] as const) {
    const hits = await fetchSearch(
      { provider, apiKey: "fixture", baseUrl: "https://ignored.invalid" },
      "天气",
      undefined,
      async (input, init) => {
        assert.equal(new URL(String(input)).hostname, host);
        const body = JSON.parse(String(init?.body));
        assert.equal(body.query ?? body.text_query, "天气");
        const row = {
          url: "https://example.org",
          title: "资料",
          snippet: "摘要",
        };
        return Response.json(
          provider === "deepseek"
            ? { results: [row] }
            : { search_results: [row] },
        );
      },
    );
    assert.equal(hits[0].title, "资料");
  }
});

test("搜索失败保留聊天，且同一轮不会再次请求服务", async () => {
  for (const reason of ["quota", "offline", "empty"]) {
    let calls = 0,
      notice = "";
    const [tool] = webTools(
      { provider: "glm", apiKey: "fixture", baseUrl: "" },
      "问",
      "turn",
      undefined,
      async () => {
        calls++;
        if (reason === "empty") return [];
        throw Error(reason);
      },
      undefined,
      undefined,
      undefined,
      (v) => (notice = v),
    );
    await tool.execute("first", { query: "测试" });
    await tool.execute("again", { query: "测试" });
    assert.equal(calls, 1);
    assert.equal(
      notice,
      {
        quota: "今天的搜索次数用完了。",
        offline: "搜索服务暂时连不上。",
        empty: "这次没查到。",
      }[reason],
    );
  }
});
