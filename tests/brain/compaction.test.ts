import assert from "node:assert/strict";
import { test } from "node:test";
import { splitHistory } from "../../apps/brain/src/prompt.ts";
import { text } from "../../apps/brain/src/texts.ts";
import { launch } from "./client.ts";
import { fakeModel } from "./fake-model.ts";

const windowSize = 4096,
  threshold = 3072;
const chinese = "茶".repeat(3200);
const cfg = {
  service: "custom",
  model: "fixture",
  apiKey: "test",
  contextWindow: windowSize,
};
const turn = (question: string, answer: string, at: number) => ({
  question,
  answer,
  at,
});
const checkpoint = (body: object) =>
  JSON.stringify(body).includes(text("checkpoint").split("\n")[0]);

test("同话题上一次输入低于 75% 时，长中文原文仍然送给模型", async (t) => {
  const s = await fakeModel([
    { chunks: ["已读"], tokens: threshold },
    { chunks: ["继续"] },
  ]);
  t.after(s.close);
  const b = launch();
  t.after(b.close);
  await b.request("initialize", { ...cfg, baseUrl: s.baseUrl });
  await b.request("chat", { topic: 1, text: chinese, now: 1 });
  const r = await b.request("chat", {
    topic: 1,
    text: "继续",
    now: 2,
    history: [turn(chinese, "已读", 1)],
  });
  assert.equal(r.result?.text, "继续");
  assert.equal(s.requests.length, 2);
  assert.ok(JSON.stringify(s.requests[1].body).includes(chinese));
});

test("达到 75% 触发一次摘要，计入缓存输入；后续低用量沿用摘要，新话题独立", async (t) => {
  const s = await fakeModel([
    { chunks: ["旧回答"], tokens: threshold + 1, cachedTokens: 2048 },
    { chunks: ["话题摘要"] },
    { chunks: ["第二答"], tokens: 501 },
    { chunks: ["第三答"], tokens: threshold + 1 },
    { chunks: ["新话题回答"] },
  ]);
  t.after(s.close);
  const b = launch();
  t.after(b.close);
  await b.request("initialize", { ...cfg, baseUrl: s.baseUrl });
  await b.request("chat", { topic: 1, text: "第一问", now: 1 });
  const history = [turn("第一问", "旧回答", 1)];
  assert.equal(
    (await b.request("chat", { topic: 1, text: "第二问", now: 2, history }))
      .result?.text,
    "第二答",
  );
  const compact = s.requests[1].body;
  assert.equal(compact.messages[0].content, text("compact"));
  assert.ok(checkpoint(s.requests[2].body));
  history.push(turn("第二问", "第二答", 2));
  assert.equal(
    (await b.request("chat", { topic: 1, text: "第三问", now: 3, history }))
      .result?.text,
    "第三答",
  );
  assert.ok(checkpoint(s.requests[3].body));
  assert.ok(!JSON.stringify(s.requests[3].body).includes("旧回答"));
  assert.equal(
    (
      await b.request("chat", {
        topic: 2,
        text: "新话题",
        now: 4,
        history: [turn("独立历史", "好", 1)],
      })
    ).result?.text,
    "新话题回答",
  );
  assert.ok(!checkpoint(s.requests[4].body));
  assert.equal(s.requests.length, 5);
});

test("工具调用返回的输入用量控制下一轮，工具请求和结果都保留", async (t) => {
  const s = await fakeModel([
    { tool: "read_badge", tokens: threshold + 1 },
    { chunks: ["摘要"] },
    { chunks: ["名牌 LZ-27"] },
  ]);
  t.after(s.close);
  const b = launch();
  t.after(b.close);
  await b.request("initialize", { ...cfg, baseUrl: s.baseUrl });
  const r = await b.request("chat", {
    topic: 4,
    text: "现在读名牌",
    history: [turn("上一句", "嗯", 1)],
    probeTool: true,
  });
  assert.equal(r.result?.text, "名牌 LZ-27");
  assert.equal(s.requests.length, 3);
  assert.equal(s.requests[1].body.messages[0].content, text("compact"));
  const followup = s.requests[2].body;
  assert.ok(checkpoint(followup));
  assert.ok(
    followup.messages.some(
      (m: any) => m.role === "tool" && m.content === "LZ-27",
    ),
  );
});

test("没有输入用量时，估算区分短中文、长中文，并保留当前轮", async (t) => {
  const list = (content: string) => [
    { role: "user" as const, content, timestamp: 1 },
    { role: "user" as const, content: "继续", timestamp: 2 },
  ];
  assert.equal(splitHistory(list("茶".repeat(1100)), windowSize), undefined);
  assert.deepEqual(
    splitHistory(list(chinese), windowSize)?.tail,
    list(chinese).slice(-1),
  );
  // The second reply omits usage. The third request must not use the first reply's low count.
  const s = await fakeModel([
    { chunks: ["一"], tokens: 50 },
    { chunks: ["二"] },
    { chunks: ["摘要"] },
    { chunks: ["三"] },
  ]);
  t.after(s.close);
  const b = launch();
  t.after(b.close);
  await b.request("initialize", { ...cfg, baseUrl: s.baseUrl });
  await b.request("chat", { topic: 1, text: "甲", now: 1 });
  const history = [turn("甲", "一", 1)];
  await b.request("chat", { topic: 1, text: "乙", now: 2, history });
  history.push(turn("乙", "二", 2));
  const r = await b.request("chat", {
    topic: 1,
    text: chinese,
    now: 3,
    history,
  });
  assert.equal(r.result?.text, "三");
  assert.equal(s.requests.length, 4);
  assert.equal(s.requests[2].body.messages[0].content, text("compact"));
  assert.ok(checkpoint(s.requests[3].body));
});

for (const canSee of [true, false]) {
  test(`截图后的纯文字追问按模型能力恢复历史图片：${canSee}`, async (t) => {
    const s = await fakeModel([{ chunks: ["好"] }]);
    t.after(s.close);
    const b = launch();
    t.after(b.close);
    await b.request("initialize", { ...cfg, canSee, baseUrl: s.baseUrl });
    const image = "iVBORw0KGgo=";
    const history = [
      {
        ...turn("看我在干嘛", "在聊天", 1),
        image_data: image,
        files: [{ name: "截图文字", text: "示例文字" }],
      },
    ];
    await b.request("chat", { topic: 1, text: "你看到猫了吗？", history });
    const user = s.requests[0].body.messages.filter(
      (m: any) => m.role === "user",
    );
    const old = JSON.stringify(user[0]);
    assert.ok(old.includes("示例文字"));
    assert.equal(old.includes("data:image/png;base64," + image), canSee);
    assert.ok(!JSON.stringify(user.at(-1)).includes(image));
  });
}
