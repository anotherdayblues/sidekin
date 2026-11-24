import assert from "node:assert/strict";
import { test } from "node:test";
import { launch } from "./client.ts";
import { fakeModel } from "./fake-model.ts";
const request = {
  text: "1 分钟后提醒我喝水",
  remindersEnabled: true,
  token: "test",
};
test("只有工具返回成功才向用户确认到点提醒", async (t) => {
  const args = {
    action: "create",
    prompt: "喝水",
    mode: "notify",
    schedule: "in 1m",
  };
  const server = await fakeModel([
    { tool: "cronjob_manage", args },
    { chunks: ["已设好。"] },
    { chunks: ["设好了"] },
    { chunks: ["设好了"] },
  ]);
  t.after(server.close);
  const calls: any[] = [];
  const brain = launch(undefined, (name, p) => {
    assert.equal(name, "host.reminder_create");
    calls.push(p);
    return { id: 1, nextAt: 60000 };
  });
  t.after(brain.close);
  await brain.request("initialize", {
    model: "fixture",
    baseUrl: server.baseUrl,
    apiKey: "fixture",
  });
  const r = await brain.request("chat", request);
  assert.equal(r.result.text, "已设好。");
  assert.deepEqual(r.result.steps, [
    { name: "cronjob_manage", label: "管理定时任务", status: "ok", textOffset: 0 },
  ]);
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].schedule, { kind: "once", after_seconds: 60 });
  const refused = await brain.request("chat", { ...request, token: "empty" });
  assert.match(refused.result.text, /没有设好/);
  assert.deepEqual(
    refused.events
      .filter((e: any) => e.method === "chat.delta")
      .map((e: any) => e.params.delta),
    [refused.result.text],
  );
});

test("聊天中自填的回答会写进定时任务", async (t) => {
  const schedule = "every day at 12pm Asia/Shanghai";
  const server = await fakeModel([
    {
      tool: "clarify",
      args: { question: "关注什么？", options: ["市场", "交通"] },
    },
    {
      tool: "cronjob_manage",
      args: {
        action: "create",
        name: "市场周报",
        prompt: "查资料写周报",
        schedule,
      },
    },
    { chunks: ["设好了"] },
  ]);
  t.after(server.close);
  let saved: any;
  const brain = launch(
    undefined,
    (_m, p) => {
      saved = p;
      return { id: 2 };
    },
    (msg) => {
      if (msg.method === "chat.question")
        void brain.request("answer_question", {
          token: "topic-7",
          id: msg.params.id,
          answer: "义乌文具批发",
        });
    },
  );
  t.after(brain.close);
  await brain.request("initialize", {
    model: "fixture",
    baseUrl: server.baseUrl,
    apiKey: "fixture",
  });
  const r = await brain.request("chat", {
    text: "每天写一份报告",
    remindersEnabled: true,
    token: "topic-7",
  });
  assert.equal(saved.mode, "agent");
  assert.match(saved.message, /义乌文具批发/);
  assert.equal(r.result.answers[0].answer, "义乌文具批发");
});

test("同一个工具按编号派发管理操作，只改名称时保留指令和日程", async (t) => {
  const hostCalls: { method: string; params: any }[] = [];
  const actions = ["list", "update", "pause", "resume", "run", "remove"];
  const server = await fakeModel(
    actions.flatMap((action) => [
      {
        tool: "cronjob_manage",
        args: {
          action,
          ...(action === "list" ? {} : { job_id: 7 }),
          ...(action === "update" ? { name: "新名称" } : {}),
        },
      },
      { chunks: ["操作完成"] },
    ]),
  );
  t.after(server.close);
  const brain = launch(undefined, (method, params) => {
    hostCalls.push({ method, params });
    return { ok: true };
  });
  t.after(brain.close);
  await brain.request("initialize", {
    model: "fixture",
    baseUrl: server.baseUrl,
    apiKey: "fixture",
  });
  for (const action of actions)
    await brain.request("chat", {
      text: action,
      remindersEnabled: true,
      token: "manage",
    });
  assert.deepEqual(
    hostCalls.map((c) => c.method),
    [
      "host.reminder_list",
      "host.reminder_edit",
      ...Array(4).fill("host.reminder_manage"),
    ],
  );
  assert.deepEqual(hostCalls[1].params, {
    token: "manage",
    id: 7,
    name: "新名称",
  });
  assert.deepEqual(
    hostCalls.slice(2).map((c) => [c.params.id, c.params.action]),
    actions.slice(2).map((a) => [7, a]),
  );
});

test("只有延时承诺也会继续执行，拿到回执才结束；反复只承诺则明确报未确认", async (t) => {
  const promise = "好，20 秒后去查义乌的新闻～";
  const args = { action: "create", schedule: "in 20s", prompt: "查义乌新闻" };
  const server = await fakeModel([
    { chunks: [promise] },
    { tool: "cronjob_manage", args },
    { chunks: ["已设好。"] },
    ...Array.from({ length: 3 }, () => ({
      chunks: ["I'll check in 20 seconds."],
    })),
  ]);
  t.after(server.close);
  const calls: string[] = [];
  const brain = launch(undefined, (method) => {
    calls.push(method);
    return { id: 18, nextAt: 60000 };
  });
  t.after(brain.close);
  await brain.request("initialize", {
    model: "fixture",
    baseUrl: server.baseUrl,
    apiKey: "fixture",
  });
  const done = await brain.request("chat", {
    ...request,
    text: "20秒之后给我查查义乌新闻。",
  });
  assert.equal(done.result.text, "已设好。");
  assert.deepEqual(calls, ["host.reminder_create"]);
  const failed = await brain.request("chat", {
    ...request,
    text: "Check the headlines in 20 seconds.",
  });
  assert.match(failed.result.text, /未能确认/);
  assert.equal(server.requests.length, 6);
});
