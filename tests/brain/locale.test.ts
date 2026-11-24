// plan/15: what the brain says to the user follows the host's language;
// prompts stay Chinese either way (zh-prompts.test.ts).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { says } from "../../apps/brain/src/locale.ts";
import { launch } from "./client.ts";
import { fakeModel } from "./fake-model.ts";

test("英文设置下，大脑显示给人看的步骤名用英文，发给模型的仍是中文", async (t) => {
  const search = createServer((_, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise<void>((ok) => search.listen(0, "127.0.0.1", ok));
  t.after(() => search.close());
  const port = (search.address() as { port: number }).port;
  for (const locale of ["en", "zh"]) {
    const model = await fakeModel([{ chunks: ["好"] }]);
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
      locale,
      toolCheck: { ...identity, status: "yes" },
      search: {
        provider: "searxng",
        baseUrl: "http://127.0.0.1:" + port,
        apiKey: "",
      },
    });
    const r = await brain.request("chat", {
      text: "查一下",
      token: "x",
      forceSearch: true,
    });
    assert.equal(
      r.result.steps.at(-1).label,
      locale === "en" ? "No search this time" : "这次没有搜索",
    );
    assert.match(model.requests[0].body.messages[0].content, /你是随伴/);
  }
});

test("认宿主的报错不分中英文", () => {
  assert.ok(
    says("内容包含指令、隐藏字符或保留分隔符，整批未写入", "host.entryUnsafe"),
  );
  assert.ok(
    says(
      "The content contains instructions, hidden characters or reserved separators. Nothing was saved",
      "host.entryUnsafe",
    ),
  );
  assert.ok(!says("别的错误", "host.entryUnsafe"));
});

test("英文：中文规则原样保留，末尾加语言说明，每轮提醒一次，选字按英文", async (t) => {
  const model = await fakeModel([
    { chunks: ["Hi"] },
    { chunks: ["x"] },
    { chunks: ["x"] },
    { chunks: ["x"] },
  ]);
  t.after(model.close);
  const brain = launch();
  t.after(brain.close);
  await brain.request("initialize", {
    model: "fixture",
    baseUrl: model.baseUrl,
    apiKey: "fixture",
    locale: "en",
  });
  await brain.request("chat", { text: "hello" });
  const [system, user] = model.requests[0].body.messages;
  assert.match(system.content, /^你是随伴/);
  assert.match(system.content, /How you talk:/);
  assert.match(system.content, /<语言>\nReply in English\./);
  assert.ok(system.content.trimEnd().endsWith("</语言>"));
  const turn = JSON.stringify(user.content);
  assert.match(turn, /Reply in English unless/);
  await brain.request("translate", { text: "closure", action: "explain" });
  assert.match(model.requests[1].body.messages[0].content, /^Explain the text/);
  await brain.request("translate", { text: "Hello there" });
  assert.match(
    model.requests[2].body.messages[0].content,
    /翻译成英文（原文已经是英文时，译成中文）/,
  );
  // 对方语言 (plan/41): an English reader's words go into it, anything else
  // comes back into English.
  await brain.request("translate", { text: "你好", target: "日文" });
  assert.match(
    model.requests[3].body.messages[0].content,
    /翻译成英文（原文已经是英文时，译成日文）/,
  );
});
