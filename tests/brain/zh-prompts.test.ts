// plan/15 step 1: everything the model is sent in Chinese, word for word.
// Multi-language work must leave this file unchanged. When the prompts are
// changed on purpose, regenerate it with UPDATE_PROMPT_SNAPSHOT=1 and read the diff.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFileSync, writeFileSync } from "node:fs";
import { test } from "node:test";
import { instructions } from "../../apps/brain/src/prompt.ts";
import { text, timeNote } from "../../apps/brain/src/texts.ts";
import { selectionSystemPrompt } from "../../apps/brain/src/translate.ts";
import { attachedText } from "../../apps/brain/src/attachments.ts";
import { launch } from "./client.ts";
import { fakeModel } from "./fake-model.ts";

const snapshot = new URL("./zh-prompts.snap.txt", import.meta.url);
const zone = "Asia/Shanghai";
const now = Date.UTC(2026, 10, 12, 6, 30);
const names = [
  "core",
  "persona-default",
  "tool-memory",
  "tool-search-history",
  "review",
  "model-hints",
  "hermes-tool-use",
  "time-note",
  "translate",
  "selection-explain",
  "selection-polish",
  "selection-summarize",
  "snip-note",
  "image-note",
  "proactive",
  "proactive-gate",
  "compact",
  "checkpoint",
  "tool-web-search",
  "tool-web-read",
  "web-guidance",
  "search-now",
  "tool-focus",
  "tool-todo",
  "todo-split",
  "todo-break",
  "tool-library",
  "tool-pet-action",
  "voice-reply",
  "attached-file",
  "attached-file-omitted",
] as const;

function wire(body: any) {
  const content = (c: any) =>
    typeof c === "string"
      ? c
      : c
          .map((p: any) => (p.type === "text" ? p.text : "<" + p.type + ">"))
          .join("\n---\n");
  return [
    ...body.messages.map(
      (m: any) => `[${m.role}]\n${content(m.content ?? "")}`,
    ),
    ...(body.tools ?? []).map(
      (t: any) =>
        `[tool ${t.function.name}]\n${t.function.description}\n${JSON.stringify(t.function.parameters, null, 2)}`,
    ),
  ].join("\n\n");
}

test("发给模型的中文内容逐字不变", async (t) => {
  const out: [string, string][] = [];
  for (const n of names) out.push(["文件 " + n, text(n)]);

  const at = new Date(now);
  const sections = {
    profile: "我写的介绍",
    user: "用户爱喝乌龙茶",
    notes: "一条笔记",
    catalog: "资料库目录",
  };
  out.push(["系统提示 默认", instructions({}, at, "fixture", {}, false, zone)]);
  out.push([
    "系统提示 自定义宠物和资料",
    instructions(
      { displayName: "栗子", description: "橘猫" },
      at,
      "fixture",
      sections,
      true,
      zone,
    ),
  ]);
  out.push([
    "系统提示 自写性格",
    instructions(
      { personality: "沉静" },
      at,
      "qwen-max",
      sections,
      false,
      zone,
    ),
  ]);
  out.push([
    "系统提示 deepseek 带工具",
    instructions({}, at, "deepseek-chat", {}, true, zone, true),
  ]);
  out.push(["时间提示 刚说过", timeNote(at, now - 60_000, zone)]);
  out.push(["时间提示 几小时", timeNote(at, now - 3 * 3600_000, zone)]);
  out.push(["时间提示 几天", timeNote(at, now - 2 * 86400_000, zone)]);
  for (const [label, prompt] of [
    ["翻译 外文自动", { text: "Take a seat." }],
    ["翻译 中文自动", { text: "请坐" }],
    ["翻译 指定日文", { text: "请坐", target: "日文" }],
    ["解释", { text: "closure", action: "explain" }],
    ["润色", { text: "I goes home", action: "polish" }],
    ["总结", { text: "Long article", action: "summarize" }],
  ] as const)
    out.push(["选字 " + label, selectionSystemPrompt(prompt)]);
  out.push([
    "附件",
    attachedText([
      { name: "a.md", text: "附件内容" },
      { name: "big.pdf", text: "" },
    ]).join("\n---\n"),
  ]);

  // The whole request as the brain sends it, tools included.
  const search = createServer((_, res) => {
    res.setHeader("content-type", "application/json");
    res.end(
      JSON.stringify({
        results: [
          { url: "https://example.org", title: "示例页", content: "示例摘要" },
        ],
      }),
    );
  });
  await new Promise<void>((ok) => search.listen(0, "127.0.0.1", ok));
  t.after(() => search.close());
  const port = (search.address() as { port: number }).port;
  const model = await fakeModel([
    { chunks: ["好"] },
    { chunks: ["好"] },
    { chunks: ["好"] },
    { chunks: ["好"] },
    { chunks: ["好"] },
  ]);
  t.after(model.close);
  const brain = launch();
  t.after(brain.close);
  const identity = {
    model: "fixture",
    baseUrl: model.baseUrl,
    protocol: "openai-completions",
  };
  await brain.request("initialize", {
    ...identity,
    service: "custom",
    apiKey: "fixture",
    canSee: true,
    toolCheck: { ...identity, status: "yes" },
    search: {
      provider: "searxng",
      baseUrl: "http://127.0.0.1:" + port,
      apiKey: "",
    },
  });
  const base = { token: "fixture", now, taskZone: zone };
  const history = [
    { question: "你好", answer: "早上好", at: now - 3 * 3600_000 },
  ];
  const requests: [string, object][] = [
    [
      "全部工具",
      {
        ...base,
        text: "今天怎么样",
        history,
        memoryEnabled: true,
        memorySnapshot: "关于你\n\n笔记\n",
        remindersEnabled: true,
        libraryEnabled: true,
        petActions: [{ name: "dance", label: "跳舞" }],
      },
    ],
    [
      "截图",
      {
        ...base,
        text: "这是什么",
        image: { type: "image", mimeType: "image/png", data: "AA==" },
      },
    ],
    [
      "上传图片和附件",
      {
        ...base,
        text: "看看",
        image: { type: "image", mimeType: "image/png", data: "AA==" },
        imageSource: "upload",
        files: [{ name: "a.md", text: "附件内容" }],
      },
    ],
    ["地球按钮", { ...base, text: "查查明天天气", forceSearch: true }],
  ];
  for (const [label, params] of requests) {
    const before = model.requests.length;
    await brain.request("chat", params);
    model.requests
      .slice(before)
      .forEach((r, i) => out.push([`请求 ${label} ${i + 1}`, wire(r.body)]));
  }
  const before = model.requests.length;
  await brain.request("review", { ...base, text: "复盘", history });
  model.requests
    .slice(before)
    .forEach((r, i) => out.push([`请求 复盘 ${i + 1}`, wire(r.body)]));

  const actual = out.map(([k, v]) => `### ${k}\n${v}\n`).join("\n");
  if (process.env.UPDATE_PROMPT_SNAPSHOT) writeFileSync(snapshot, actual);
  assert.equal(actual, readFileSync(snapshot, "utf8"));
});
