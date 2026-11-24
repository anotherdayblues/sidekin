import assert from "node:assert/strict";
import { launch } from "./client.ts";
import {
  fixtureMemory,
  reminderCase,
  memoryCases,
  fixtureImage,
  fixtureTime,
  prompts,
  startLiveGate,
} from "./live-gate.ts";
const gate = await startLiveGate(),
  brain = launch();
try {
  const refused = await fetch(gate.url + "/responses", {
    method: "POST",
    headers: { Authorization: "Bearer " + gate.token },
    body: JSON.stringify({ input: "fixture-negative-test" }),
  });
  assert.equal(refused.status, 403);
  assert.equal(gate.audit.forwarded, 0);
  await brain.request("initialize", {
    service: "openai",
    model: gate.model,
    baseUrl: gate.url,
    apiKey: gate.token,
  });
  const malformed = await brain.request("chat", {
    text: prompts.chat,
    now: fixtureTime,
    history: [
      { question: "negative-fixture-not-allowed", answer: "fixture", at: 0 },
    ],
  });
  assert.ok(malformed.error);
  assert.equal(gate.audit.forwarded, 0);
  const altered = await brain.request("vision", {
    text: prompts.vision,
    now: fixtureTime,
    image: { type: "image", mimeType: "image/png", data: "iVBORw0KGgo=" },
  });
  assert.ok(altered.error);
  assert.equal(gate.audit.forwarded, 0);
  const ping = await brain.request("test", { now: fixtureTime });
  assert.ok(ping.result?.firstMs > 0);
  console.log("OpenAI 首字", ping.result.firstMs, "ms");
  for (const [method, params, expected] of [
    ["chat", { text: prompts.clock, now: fixtureTime }, /\d{1,2}:\d{2}/],
    ["chat", { text: prompts.chat, now: fixtureTime }, /.+/],
    ["translate", { text: prompts.translation }, /猫/],
    [
      "vision",
      { text: prompts.vision, now: fixtureTime, image: await fixtureImage() },
      /Screen Recording/i,
    ],
  ] as const) {
    const reply = await brain.request(method, params);
    assert.match(reply.result?.text ?? "", expected);
    assert.ok(reply.events.some((e: any) => e.method === "chat.delta"));
    console.log(method, "白名单样本通过");
  }
  let stored = false;
  for (const [i, p] of memoryCases.entries()) {
    const session = launch(undefined, (method, args) => {
      const result = fixtureMemory(method, args);
      stored = true;
      return result;
    });
    try {
      await session.request("initialize", {
        service: "openai",
        model: gate.model,
        baseUrl: gate.url,
        apiKey: gate.token,
      });
      const r = await session.request("chat", p);
      if (i === 0)
        assert.ok(
          stored && r.events.some((e: any) => e.method === "chat.remembered"),
        );
      assert.match(
        r.result?.text ?? "",
        i === 0 ? /记|好|小栗/ : i === 1 ? /小栗/ : /不知|没有|没记|未记/,
      );
    } finally {
      session.close();
    }
  }
  console.log("白名单记忆样本：写入确认、重启回忆、删除后回答通过");
  await brain.request("configure", {
    service: "custom",
    model: gate.model,
    baseUrl: gate.url,
    apiKey: gate.token,
  });
  const badge = await brain.request("chat", {
    text: prompts.badge,
    probeTool: true,
    now: fixtureTime,
  });
  assert.ok(badge.events.some((e: any) => e.method === "chat.tool"));
  assert.match(badge.result?.text ?? "", /LZ-27/i);
  console.log("名牌工具往返通过");
  let created = false;
  const reminders = launch(undefined, (method, args) => {
    const result = fixtureMemory(method, args);
    if (method === "host.reminder_create") created = true;
    return result;
  });
  try {
    await reminders.request("initialize", {
      service: "custom",
      model: gate.model,
      baseUrl: gate.url,
      apiKey: gate.token,
    });
    const reply = await reminders.request("chat", reminderCase);
    assert.ok(
      created &&
        reply.result?.text &&
        reply.events.some((e: any) => e.method === "chat.reminderChanged"),
    );
    console.log("白名单提醒样本：真实模型创建并确认");
  } finally {
    reminders.close();
  }
} finally {
  brain.close();
  gate.close();
}
