import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { text } from "../../apps/brain/src/texts.ts";
import { launch } from "./client.ts";
import { fakeModel } from "./fake-model.ts";

for (const mode of ["tools", "chat-only", "skipped", "offline"]) {
  test("地球按钮与五月天追问：" + mode, async (t) => {
    const question = "嗯，你查查，不是那首歌哦";
    const query = "五月天 好想把你写成一首歌 歌名";
    const page = { url: "https://example.org/story", title: "模拟歌词页" };
    const searches: string[] = [];
    const server = createServer((req, res) => {
      searches.push(
        new URL(req.url!, "http://localhost").searchParams.get("q")!,
      );
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ results: [{ ...page, content: "一段模拟摘要" }] }),
      );
    });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    t.after(() => server.close());
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const model = await fakeModel(
      mode === "tools"
        ? [{ tool: "web_search", args: { query } }, { chunks: ["模拟回答"] }]
        : [{ chunks: ["模拟回答"] }],
    );
    t.after(model.close);
    const brain = launch();
    t.after(brain.close);
    const identity = {
      model: "fixture",
      baseUrl: model.baseUrl,
      protocol: "openai-completions",
    };
    await brain.request("initialize", {
      ...identity,
      service: "custom",
      apiKey: "fixture",
      toolCheck: { ...identity, status: mode === "chat-only" ? "no" : "yes" },
      ...(mode !== "offline" && {
        search: {
          provider: "searxng",
          baseUrl: "http://127.0.0.1:" + address.port,
          apiKey: "",
        },
      }),
    });
    const reply = await brain.request("chat", {
      text: question,
      token: "fixture",
      forceSearch: mode !== "offline",
      history: [
        {
          question: "五月天的歌词，好想把你写成一首歌，出自哪首歌？",
          answer: "上次猜错了",
          at: 1,
        },
      ],
    });
    assert.equal(reply.result?.text, "模拟回答");
    assert.deepEqual(reply.result.sources, []);
    const first = model.requests[0].body;
    const system = first.messages[0].content;
    const canSearch = mode === "tools" || mode === "skipped";
    assert.equal(system.includes(text("web-guidance")), canSearch);
    if (canSearch)
      assert.ok(
        system.indexOf("</性格>") < system.indexOf(text("web-guidance")) &&
          system.indexOf(text("web-guidance")) < system.indexOf("<关于你>"),
      );
    const user = JSON.stringify(first.messages.at(-1));
    assert.equal(user.includes(text("search-now")), canSearch);
    assert.ok(user.includes(question));
    assert.match(JSON.stringify(first.messages), /上次猜错了/);
    const tools = (first.tools ?? []).map(
      (x: { function: { name: string } }) => x.function.name,
    );
    assert.equal(tools.includes("web_search"), canSearch);
    assert.equal(tools.includes("web_read"), mode !== "chat-only");
    assert.deepEqual(
      searches,
      mode === "tools" ? [query] : mode === "chat-only" ? [question] : [],
    );
    assert.equal(model.requests.length, mode === "tools" ? 2 : 1);
    const steps = reply.result.steps;
    if (mode === "offline") assert.deepEqual(steps, []);
    else if (mode === "skipped") assert.equal(steps[0].label, "这次没有搜索");
    else {
      assert.deepEqual(steps[0].pages, [page]);
      assert.ok(!JSON.stringify(steps).includes("一段模拟摘要"));
      assert.match(
        JSON.stringify(model.requests.at(-1)?.body.messages),
        /一段模拟摘要/,
      );
    }
  });
}
