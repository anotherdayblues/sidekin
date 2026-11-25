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

test("多语言明确记忆与预写启发式覆盖 zh / zh-TW / en / ja / ko", async () => {
  const {
    explicitMemory,
    extractExplicitFact,
    extractRename,
    isUnsafePrewrite,
  } = await import("../../apps/brain/src/memory.ts");

  // Positive cases across all 5 locales
  for (const text of [
    "记住我爱喝乌龙茶",
    "請記住我喜歡喝烏龍茶",
    "別忘了我對花生過敏",
    "Remember that I drink black coffee",
    "Don’t forget my dog is named Mochi",
    "覚えておいて、私は猫が好きです",
    "烏龍茶が好きだと覚えておいて",
    "기억해 줘: 나는 우롱차를 좋아해",
    "우롱차 좋아한다고 기억해 줘",
  ]) {
    assert.ok(explicitMemory(text), `expected explicitMemory true: ${text}`);
  }

  // Negative / exclusion cases across all 5 locales
  for (const text of [
    "别忘了明天提醒我开会",
    "別忘了明天提醒我開會",
    "不要記住這個",
    "還記得我上次說的嗎",
    "Do you remember my birthday?",
    "覚えてる？",
    "覚えないでいいよ",
    "忘れないでね、明日リマインドして",
    "기억하지 마",
    "이거 기억나?",
  ]) {
    assert.ok(!explicitMemory(text), `expected explicitMemory false: ${text}`);
  }

  // Fact extraction
  assert.equal(extractExplicitFact("請記住我叫小栗"), "我叫小栗");
  assert.equal(
    extractExplicitFact("Remember that I drink black coffee"),
    "I drink black coffee",
  );
  assert.equal(
    extractExplicitFact("覚えておいて：私は猫が好きです"),
    "私は猫が好きです",
  );
  assert.equal(
    extractExplicitFact("烏龍茶が好きだと覚えておいて"),
    "烏龍茶が好きだ",
  );
  assert.equal(
    extractExplicitFact("기억해 줘: 나는 우롱차를 좋아해"),
    "나는 우롱차를 좋아해",
  );
  assert.equal(
    extractExplicitFact("우롱차 좋아한다고 기억해 줘"),
    "우롱차 좋아한다고",
  );

  // Rename extraction
  assert.equal(extractRename("請把我的名字改成小栗"), "小栗");
  assert.equal(extractRename("名前をくりに変えてください"), "くり");
  assert.equal(extractRename("내 이름을 밤톨이로 바꿔 줘"), "밤톨이");
  assert.equal(extractRename("Please change my name to Lizi"), "Lizi");

  // Unsafe prewrite guard
  assert.ok(isUnsafePrewrite("刪除這條記憶"));
  assert.ok(isUnsafePrewrite("設定を変更する"));
  assert.ok(isUnsafePrewrite("이 기록 삭제해 줘"));
  assert.ok(!isUnsafePrewrite("我喜歡喝烏龍茶"));
});
