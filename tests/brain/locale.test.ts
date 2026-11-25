// plan/15: what the brain says to the user follows the host's language;
// prompts stay Chinese either way (zh-prompts.test.ts).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { test } from "node:test";
import { says } from "../../apps/brain/src/locale.ts";
import {
  defaultPersonaPrompt,
  languageBlock,
  selectionPrompt,
  turnLanguageNote,
} from "../../apps/brain/src/localePrompts.ts";
import {
  selectionSystemPrompt,
  translationTarget,
} from "../../apps/brain/src/translate.ts";
import { getLocale, registry, type LocaleEntry } from "../../apps/shared/locales/index.ts";
import { launch } from "./client.ts";
import { fakeModel } from "./fake-model.ts";

test("英文设置下，大脑显示给人看的步骤名用英文，发给模型的仍是中文", async (t) => {
  const search = createServer((_, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ results: [] }));
  });
  await new Promise<void>((ok) => search.listen(0, "127.0.0.1", ok));
  t.after(() => search.close());
  const port = (search.address() as { port: number }).port;
  for (const locale of ["en", "zh"]) {
    const model = await fakeModel([{ chunks: ["好"] }]);
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
      locale,
      toolCheck: { ...identity, status: "yes" },
      search: {
        provider: "searxng",
        baseUrl: "http://127.0.0.1:" + port,
        apiKey: "",
      },
    });
    const r = await brain.request("chat", {
      text: "查一下",
      token: "x",
      forceSearch: true,
    });
    assert.equal(
      r.result.steps.at(-1).label,
      locale === "en" ? "No search this time" : "这次没有搜索",
    );
    assert.match(
      model.requests[0].body.messages[0].content,
      locale === "en" ? /你是Suiby/ : /你是随伴/,
    );
  }
});

test("认宿主的报错不分中英文", () => {
  assert.ok(
    says("内容包含指令、隐藏字符或保留分隔符，整批未写入", "host.entryUnsafe"),
  );
  assert.ok(
    says(
      "The content contains instructions, hidden characters or reserved separators. Nothing was saved",
      "host.entryUnsafe",
    ),
  );
  assert.ok(!says("别的错误", "host.entryUnsafe"));
});

test("英文：中文规则原样保留，末尾加语言说明，每轮提醒一次，选字按英文", async (t) => {
  const model = await fakeModel([
    { chunks: ["Hi"] },
    { chunks: ["x"] },
    { chunks: ["x"] },
    { chunks: ["x"] },
  ]);
  t.after(model.close);
  const brain = launch();
  t.after(brain.close);
  await brain.request("initialize", {
    model: "fixture",
    baseUrl: model.baseUrl,
    apiKey: "fixture",
    locale: "en",
  });
  await brain.request("chat", { text: "hello" });
  const [system, user] = model.requests[0].body.messages;
  assert.match(system.content, /^你是Suiby/);
  assert.match(system.content, /How you talk:/);
  assert.match(system.content, /<语言>\nReply in English\./);
  assert.ok(system.content.trimEnd().endsWith("</语言>"));
  const turn = JSON.stringify(user.content);
  assert.match(turn, /Reply in English unless/);
  await brain.request("translate", { text: "closure", action: "explain" });
  assert.match(model.requests[1].body.messages[0].content, /^Explain the text/);
  await brain.request("translate", { text: "Hello there" });
  assert.match(
    model.requests[2].body.messages[0].content,
    /翻译成英文（原文已经是英文时，译成中文）/,
  );
  // 对方语言 (plan/41): an English reader's words go into it, anything else
  // comes back into English.
  await brain.request("translate", { text: "你好", target: "日文" });
  assert.match(
    model.requests[3].body.messages[0].content,
    /翻译成英文（原文已经是英文时，译成日文）/,
  );
});

test("两级语言层插槽与翻译路由：繁中/日语/韩语命中专属精调，未配置语言走通用模板兜底", () => {
  const zhTw = getLocale("zh-TW");
  const ja = getLocale("ja");
  const ko = getLocale("ko");
  const mockEs: LocaleEntry = {
    id: "es",
    nativeName: "Español",
    shortLabel: "ES",
    htmlLang: "es",
    hreflang: "es",
    dateLocale: "es-ES",
    hour12: false,
    matchTags: ["es"],
    fallback: ["es", "en", "zh"],
    websitePath: "/es/",
    guidePath: "/es/guide/",
    brain: {
      promptMode: "overlay",
      promptName: "Spanish",
      promptNameZh: "西班牙文",
      defaultPartnerZh: "英文",
      selfPattern: "西班牙文|西班牙语|español|spanish|^es$",
    },
  };

  // 已落地的专属语言层文件自动命中
  assert.match(languageBlock(zhTw), /台灣繁體中文/);
  assert.match(turnLanguageNote(zhTw), /台灣繁體中文/);
  assert.match(defaultPersonaPrompt(zhTw, registry), /^說話方式：/);
  assert.match(selectionPrompt("explain", zhTw), /台灣繁體中文/);

  assert.match(languageBlock(ja), /自然な日本語/);
  assert.match(turnLanguageNote(ja), /自然な日本語/);
  assert.match(defaultPersonaPrompt(ja, registry), /^話し方：/);
  assert.match(selectionPrompt("explain", ja), /日本語/);

  assert.match(languageBlock(ko), /자연스러운 한국어/);
  assert.match(turnLanguageNote(ko), /자연스러운 한국어/);
  assert.match(defaultPersonaPrompt(ko, registry), /^말하는 방식:/);
  assert.match(selectionPrompt("summarize", ko), /한국어/);

  // 无专属文件的新语言（如未来的 es）：通用模板兜底 + 人设按 fallback 链回退到英文
  assert.match(languageBlock(mockEs, () => undefined), /Reply in Spanish\./);
  assert.match(turnLanguageNote(mockEs, () => undefined), /Reply in Spanish/);
  assert.match(
    selectionPrompt("explain", mockEs, () => undefined),
    /^Explain the text the user sent, in Spanish\./,
  );
  assert.match(defaultPersonaPrompt(mockEs, registry), /^How you talk:/);

  // 翻译路由：自动互译、指定对方语言、以及防自译回退
  assert.equal(
    translationTarget("Hello", undefined, undefined, ja).target,
    "日文（原文已经是日文时，译成英文）",
  );
  assert.equal(
    translationTarget("こんにちは", "法文", "formal", ja).target,
    "日文（原文已经是日文时，译成法文），语气正式、礼貌",
  );
  assert.equal(
    translationTarget("こんにちは", "日本語", undefined, ja).target,
    "日文（原文已经是日文时，译成英文）",
  );
  assert.equal(
    translationTarget("Hello", undefined, undefined, ko).target,
    "韩文（原文已经是韩文时，译成英文）",
  );
  assert.match(
    selectionSystemPrompt({ text: "closure", action: "explain" }, zhTw),
    /台灣繁體中文/,
  );
  assert.match(
    selectionSystemPrompt({ text: "這個設定很棒", action: "polish" }, zhTw),
    /台灣繁體中文/,
  );
  assert.match(
    selectionSystemPrompt({ text: "这个配置很棒", action: "polish" }, getLocale("zh")),
    /^润色用户发来的原文/,
  );
});

test("次级轮次（review / tool-memory 重试 / wantsReceipt / needsTool）全部附带当前语言锚点，且不注入英文催促", async (t) => {
  // 1) review + wantsReceipt + needsTool + tool-memory retry in ja locale
  const model = await fakeModel([
    // review reply
    { chunks: ["振り返り完了。"] },
    // tool-memory retry: user asks to remember something that won't prewrite (contains unsafe keyword "変更"), model skips tool first then replies
    { chunks: ["覚えておきますね。"] },
    { chunks: ["メモしました。"] },
    // wantsReceipt: user asks for a reminder, model promises without calling tool -> follow-up -> model calls tool -> final reply
    { chunks: ["わかりました、10分後に通知しますね。"] },
    {
      tool: "cronjob_manage",
      args: { action: "create", schedule: "in 10m", prompt: "水を飲む" },
    },
    { chunks: ["リマインダーを設定しました。"] },
    // needsTool: model announces trailing action without calling tool -> follow-up -> final answer
    { chunks: ["今から調べてみますね。"] },
    { chunks: ["確認しました。"] },
  ]);
  t.after(model.close);
  const brain = launch(undefined, (method) => {
    if (method === "host.reminder_create") return { id: 42, nextAt: 60000 };
    return { saved: true };
  });
  t.after(brain.close);
  await brain.request("initialize", {
    model: "fixture",
    baseUrl: model.baseUrl,
    apiKey: "fixture",
    locale: "ja",
  });

  // Review turn carries ja turn-language anchor
  await brain.request("review", {
    token: "t1",
    text: "review",
    history: [{ question: "おはよう", answer: "おはよう！", at: Date.now() }],
  });
  const reviewUser = JSON.stringify(model.requests[0].body.messages.at(-1));
  assert.match(reviewUser, /自然な日本語/);

  // tool-memory retry turn carries ja turn-language anchor
  await brain.request("chat", {
    token: "t2",
    text: "覚えておいて、設定を変更したい",
    memoryEnabled: true,
    memorySnapshot: "",
  });
  const memoryRetryMsg = JSON.stringify(model.requests[2].body.messages.at(-1));
  assert.match(memoryRetryMsg, /自然な日本語/);

  // wantsReceipt follow-up carries ja turn-language anchor
  await brain.request("chat", {
    token: "t3",
    text: "10分後に水を飲むようリマインドして",
    remindersEnabled: true,
  });
  const receiptFollowUp = JSON.stringify(model.requests[4].body.messages.at(-1));
  assert.match(receiptFollowUp, /自然な日本語/);

  // needsTool follow-up does NOT inject English instruction and carries ja turn-language anchor
  await brain.request("chat", {
    token: "t4",
    text: "天気を確認して",
    remindersEnabled: true,
  });
  const needsToolFollowUp = JSON.stringify(
    model.requests[7].body.messages.at(-1),
  );
  assert.doesNotMatch(needsToolFollowUp, /Continue the requested action/i);
  assert.match(needsToolFollowUp, /继续用可用工具完成用户原来的请求/);
  assert.match(needsToolFollowUp, /自然な日本語/);
});
