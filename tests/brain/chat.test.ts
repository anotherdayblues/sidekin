import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeModel } from "./fake-model.ts";
import { launch } from "./client.ts";
import { splitHistory, instructions } from "../../apps/brain/src/prompt.ts";
test("性格、日期、星期、时区和历史通过实际请求送给模型", async (t) => {
  const server = await fakeModel([{ chunks: ["好"] }]);
  t.after(server.close);
  const brain = launch();
  t.after(brain.close);
  await brain.request("initialize", {
    baseUrl: server.baseUrl,
    model: "fixture",
    apiKey: "fake",
  });
  await brain.request("chat", {
    text: "现在几点",
    pet: { displayName: "栗子", description: "橘猫", personality: "沉静" },
    history: [{ question: "你好", answer: "早上好", at: 1 }],
  });
  const wire = JSON.stringify(server.requests[0].body);
  for (const word of [
    "栗子",
    "今天是",
    "沉静",
    "星期",
    Intl.DateTimeFormat().resolvedOptions().timeZone,
    "早上好",
    "现在几点",
  ])
    assert.ok(wire.includes(word), word);
  const long = Array.from({ length: 30 }, (_, i) => ({
    role: "user" as const,
    content: "这是一段历史".repeat(25) + i,
    timestamp: i,
  }));
  const clipped = splitHistory(long, 4096)!.tail;
  assert.ok(clipped.length < long.length);
  assert.equal(clipped.at(-1), long.at(-1));
});
test("无连接和 60 秒无回答分别报告 network / timeout", async (t) => {
  const server = await fakeModel([{ stall: true }]);
  const brain = launch();
  t.after(brain.close);
  const cfg = { baseUrl: server.baseUrl, model: "fixture", apiKey: "fake" };
  await brain.request("initialize", cfg);
  try {
    assert.equal(
      (await brain.request("chat", { text: "超时" })).error.message,
      "timeout",
    );
  } finally {
    server.close();
  }
  assert.equal(
    (await brain.request("chat", { text: "断网" })).error.message,
    "network",
  );
});
