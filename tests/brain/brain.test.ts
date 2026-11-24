import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeModel } from "./fake-model.ts";
import { launch } from "./client.ts";

test("stdio 握手、流式文字、图片和真实工具回传", async (t) => {
  const server = await fakeModel([
    { chunks: ["你好", "呀"] },
    { tool: "read_badge" },
    { chunks: ["LZ-27"] },
  ]);
  t.after(server.close);
  const brain = launch();
  t.after(brain.close);
  assert.equal((await brain.request("ping")).error.code, -32001);
  const key = "fixture-secret";
  assert.deepEqual(
    (
      await brain.request("initialize", {
        apiKey: key,
        model: "fixture",
        baseUrl: server.baseUrl,
      })
    ).result,
    { ready: true },
  );
  assert.equal((await brain.request("ping")).result, "pong");
  assert.equal(
    (await brain.request("initialize", { apiKey: key })).error.code,
    -32001,
  );
  assert.equal((await brain.request("unknown")).error.code, -32601);
  const image = {
    type: "image",
    mimeType: "image/png",
    data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+lmN8AAAAASUVORK5CYII=",
  };
  const reply = await brain.request("chat", { text: "看图", image });
  assert.equal(reply.result.text, "你好呀");
  assert.deepEqual(
    reply.events.map((e: any) => e.params.delta),
    ["你好", "呀"],
  );
  const user = server.requests[0].body.messages.find(
    (m: any) => m.role === "user",
  );
  assert.deepEqual(
    user.content.find((part: any) => part.type === "image_url").image_url.url,
    "data:image/png;base64," + image.data,
  );
  const toolReply = await brain.request("chat", {
    text: "读名牌",
    probeTool: true,
  });
  assert.equal(toolReply.result.text, "LZ-27");
  assert.equal(
    toolReply.events.some(
      (e: any) => e.method === "chat.tool" && e.params.name === "read_badge",
    ),
    true,
  );
  assert.equal(
    server.requests[2].body.messages.find((m: any) => m.role === "tool")
      .content,
    "LZ-27",
  );
  assert.ok(server.requests.every((r) => r.path === "/v1/chat/completions"));
  assert.ok(!JSON.stringify([reply, toolReply]).includes(key));
});

test("服务拒绝请求时返回错误，大脑仍可通信", async (t) => {
  const server = await fakeModel([{ error: 401 }]);
  t.after(server.close);
  const brain = launch();
  t.after(brain.close);
  await brain.request("initialize", {
    apiKey: "fixture",
    model: "fixture",
    baseUrl: server.baseUrl,
  });
  assert.equal(
    (await brain.request("chat", { text: "你好" })).error.code,
    -32003,
  );
  assert.equal((await brain.request("ping")).result, "pong");
});

test("流式请求期间可 ping、换配置和停止，回复按原请求编号匹配", async (t) => {
  const slow = await fakeModel([{ stall: true }]),
    fast = await fakeModel([{ chunks: ["新模型"] }]);
  t.after(slow.close);
  t.after(fast.close);
  const brain = launch();
  t.after(brain.close);
  const config = { model: "fixture", baseUrl: slow.baseUrl, apiKey: "sample" };
  await brain.request("initialize", config);
  const waiting = brain.request("chat", { text: "旧请求" });
  while (!slow.requests.length) await new Promise((r) => setTimeout(r, 10));
  assert.equal((await brain.request("ping")).result, "pong");
  await brain.request("configure", { ...config, baseUrl: fast.baseUrl });
  assert.equal(
    (await brain.request("chat", { text: "新请求" })).result.text,
    "新模型",
  );
  await brain.request("cancel", { id: 2 });
  assert.equal((await waiting).error.message, "stopped");
});

test("工具验证必须实际调用名牌，猜中编号也只算聊天", async (t) => {
  const server = await fakeModel([
    { chunks: ["LZ-27"] },
    { tool: "read_badge" },
    { chunks: ["LZ-27"] },
  ]);
  t.after(server.close);
  const brain = launch();
  t.after(brain.close);
  await brain.request("initialize", {
    model: "fixture",
    apiKey: "dummy",
    baseUrl: server.baseUrl,
  });
  assert.equal((await brain.request("test_tools")).result.toolStatus, "no");
  assert.equal((await brain.request("test_tools")).result.toolStatus, "yes");
});
