import assert from "node:assert/strict";
import test from "node:test";
import { instructions } from "../../apps/brain/src/prompt.ts";
import { launch } from "./client.ts";
import { fakeModel } from "./fake-model.ts";

test("manual profile has its own prompt variable, separate from remembered entries", () => {
  const prompt = instructions({}, new Date(0), "fixture", {
    profile: "我写的测试资料\n第二行",
    user: "它记住的测试条目",
    notes: "办事笔记",
  });
  assert.ok(prompt.includes("我写的测试资料\n第二行"));
  assert.ok(prompt.includes("它记住的测试条目"));
  assert.ok(!prompt.includes("{{我写的}}"));
});

test("the next request sends the latest manual fields even with memory tools disabled", async (t) => {
  const server = await fakeModel([
    { chunks: ["第一句"] },
    { chunks: ["下一句"] },
  ]);
  t.after(server.close);
  const brain = launch();
  t.after(brain.close);
  await brain.request("initialize", {
    apiKey: "fixture",
    model: "fixture",
    baseUrl: server.baseUrl,
    service: "custom",
  });
  for (const value of ["旧", "新"]) {
    const r = await brain.request("chat", {
      topic: 42,
      text: "测试",
      memoryEnabled: false,
      pet: { personality: value + "性格" },
      sections: { profile: value + "手写资料", user: "" },
    });
    assert.ok(!r.error);
  }
  const system = JSON.stringify(
    server.requests[1].body.messages.find((m: any) => m.role === "system"),
  );
  assert.ok(system.includes("新手写资料"));
  assert.ok(system.includes("新性格"));
  assert.ok(!system.includes("旧手写资料"));
});
