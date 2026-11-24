import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeModel } from "./fake-model.ts";
import { launch } from "./client.ts";

test("番茄钟工具：说“陪我专注半小时”就让宿主开始 30 分钟；结果回给模型", async (t) => {
  const server = await fakeModel([
    { tool: "focus_timer", args: { action: "start", minutes: 30 } },
    { chunks: ["开始啦，我陪你。"] },
  ]);
  t.after(server.close);
  const calls: any[] = [];
  const brain = launch(undefined, (method, params) => {
    calls.push({ method, params });
    if (method === "host.focus")
      return {
        phase: "focus",
        changed: true,
        minutesLeft: 30,
        tomato: "1/4",
        doneToday: 0,
      };
    return null;
  });
  t.after(brain.close);
  await brain.request("initialize", {
    apiKey: "fixture-secret",
    model: "fixture",
    baseUrl: server.baseUrl,
  });
  const reply = await brain.request("chat", {
    text: "陪我专注半小时",
    token: "t1",
  });
  assert.equal(reply.result.text, "开始啦，我陪你。");
  const call = calls.find((c) => c.method === "host.focus");
  assert.deepEqual(call.params, { token: "t1", action: "start", minutes: 30 });
  const tool = server.requests[0].body.tools.find(
    (x: any) => x.function.name === "focus_timer",
  );
  assert.deepEqual(tool.function.parameters.properties.action.enum, [
    "start",
    "pause",
    "resume",
    "stop",
    "rest",
    "status",
  ]);
  assert.match(JSON.stringify(server.requests[1].body.messages), /1\/4/);
  const steps = reply.events.filter((e: any) => e.method === "chat.steps");
  assert.equal(steps.at(-1).params.steps[0].label, "专注计时");
});
