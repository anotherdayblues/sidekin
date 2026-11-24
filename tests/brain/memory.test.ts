import { test } from "node:test";
import assert from "node:assert/strict";
import { launch } from "./client.ts";
import { fakeModel } from "./fake-model.ts";
test("明确记住先写后台，然后才对用户确认；关闭能力不写入", async (t) => {
  const server = await fakeModel([
    { chunks: ["记住了"] },
    { chunks: ["没有开启记忆"] },
  ]);
  t.after(server.close);
  const ops: any[] = [];
  const brain = launch(undefined, (method, params) => {
    assert.equal(method, "host.memory");
    ops.push(params.operations);
    return { saved: true };
  });
  t.after(brain.close);
  await brain.request("initialize", {
    apiKey: "fixture",
    model: "fixture",
    baseUrl: server.baseUrl,
    service: "custom",
  });
  const p = {
    text: "记住我叫小栗，最爱喝乌龙茶",
    token: "test",
    memoryEnabled: true,
    memorySnapshot: "关于你\n\n笔记\n",
  };
  const r = await brain.request("chat", p);
  assert.deepEqual(r.result.steps, [
    { name: "memory", label: "写记忆", status: "ok", textOffset: 0 },
  ]);
  assert.equal(ops[0][0].content, "我叫小栗，最爱喝乌龙茶");
  assert.ok(
    r.events.findIndex((e: any) => e.method === "chat.remembered") <
      r.events.findIndex((e: any) => e.method === "chat.delta"),
  );
  await brain.request("chat", { ...p, memoryEnabled: false });
  assert.equal(ops.length, 1);
  assert.ok(
    !server.requests[1].body.tools?.some(
      (t: any) => t.function.name === "memory",
    ),
  );
});

test("overflow errors deliver the latest complete notebook to the model", async (t) => {
  const fresh = ["会话开始后更新的第一条", "最新完整第二条"];
  const server = await fakeModel([
    {
      tool: "memory",
      args: {
        operations: [{ book: "user", action: "add", content: "新条目" }],
      },
    },
    { chunks: ["需要合并已有条目。"] },
  ]);
  t.after(server.close);
  const brain = launch(undefined, (method) => {
    assert.equal(method, "host.memory");
    throw Error(
      "关于你超出 4 个字符。整批未写入。\n当前完整条目：" +
        JSON.stringify(fresh),
    );
  });
  t.after(brain.close);
  await brain.request("initialize", {
    apiKey: "fixture",
    model: "fixture",
    baseUrl: server.baseUrl,
    service: "custom",
  });
  const r = await brain.request("chat", {
    text: "今天继续聊",
    token: "fixture",
    memoryEnabled: true,
    sections: { user: "话题开头的旧记忆" },
  });
  assert.ok(!r.error);
  const result = JSON.stringify(
    server.requests[1].body.messages.filter((m: any) => m.role === "tool"),
  );
  for (const entry of fresh) assert.ok(result.includes(entry));
  assert.ok(!r.events.some((e: any) => e.method === "chat.remembered"));
});
