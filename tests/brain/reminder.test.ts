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

test("多语言提醒创建与停滞守卫启发式覆盖 zh / zh-TW / en / ja / ko", async () => {
  const { isReminderCreationRequest, timedPromise, trailingAction } =
    await import("../../apps/brain/src/turnEnd.ts");

  // Reminder creation requests
  for (const req of [
    "1 分钟后提醒我喝水",
    "10 分鐘後提醒我開會",
    "每週一早上 9 點提醒我寫週報",
    "Remind me in 5 minutes to stretch",
    "10分後に水を飲むようリマインドして",
    "明日9時に会議を通知して",
    "10분 후에 물 마시라고 알려 줘",
    "내일 9시에 회의 알림 설정해 줘",
  ]) {
    assert.ok(
      isReminderCreationRequest(req),
      `expected isReminderCreationRequest true: ${req}`,
    );
  }
  for (const req of [
    "取消明天的提醒",
    "刪除明天的提醒",
    "Cancel my reminder for tomorrow",
    "明日のリマインダーを削除して",
    "내일 알림 취소해 줘",
    "明天提醒我一下？",
  ]) {
    assert.ok(
      !isReminderCreationRequest(req),
      `expected isReminderCreationRequest false: ${req}`,
    );
  }

  // Timed promise guard across locales
  assert.ok(timedPromise("10 分鐘後提醒我", "好，已經幫你設好提醒了。"));
  assert.ok(timedPromise("10分後に通知して", "リマインダーを設定しました。"));
  assert.ok(
    timedPromise("20秒後にニュースを調べて", "わかりました、後で調べますね。"),
  );
  assert.ok(timedPromise("10분 후에 알려 줘", "알림을 설정했습니다."));
  assert.ok(
    timedPromise("10분 뒤에 확인해 줘", "알겠습니다, 이따가 확인해 드릴게요."),
  );
  // Refusals should NOT trigger timedPromise
  assert.ok(!timedPromise("10 分鐘後提醒我", "無法建立這個提醒。"));
  assert.ok(!timedPromise("10分後に通知して", "設定できませんでした。"));
  assert.ok(!timedPromise("10분 후에 알려 줘", "알림을 설정할 수 없습니다."));

  // Trailing action guard across locales
  assert.ok(trailingAction("我現在就幫你查詢一下。"));
  assert.ok(trailingAction("今から調べてみますね。"));
  assert.ok(trailingAction("지금 바로 확인해 볼게요."));
  assert.ok(trailingAction("Let me now check that for you."));
  assert.ok(!trailingAction("查詢完成，明天是晴天。"));
});
