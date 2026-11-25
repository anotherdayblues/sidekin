import assert from "node:assert/strict";
import { test } from "node:test";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { WebSocketServer, type WebSocket as Peer } from "ws";
import { spokenFilter, sentences } from "../../apps/brain/src/speech/spoken.ts";
import {
  decode,
  encode,
  Event,
} from "../../apps/brain/src/speech/volcengineFrames.ts";
import { speak, type VoiceConfig } from "../../apps/brain/src/speech/speech.ts";
import { fakeModel } from "./fake-model.ts";
import { launch } from "./client.ts";

const say = (text: string, pieces = 3) => {
  const f = spokenFilter();
  let out = "";
  const step = Math.ceil(text.length / pieces);
  for (let i = 0; i < text.length; i += step)
    out += f.push(text.slice(i, i + step));
  return out + f.flush();
};

test("念之前去掉代码、表格、链接、网址、表情和格式符号，气泡那份不受影响", () => {
  const reply = [
    "## 今天的安排",
    "**先**喝口水 😊，再看[这篇文章](https://example.com/a)。",
    "- 买菜",
    "1. 跑步 3.5 公里",
    "```js",
    "console.log('不念')",
    "```",
    "| 列 | 值 |",
    "| --- | --- |",
    "运行 `npm test` 就行，详情见 https://example.com/b 。",
  ].join("\n");
  const spoken = say(reply, 7);
  assert.equal(
    spoken,
    "今天的安排。先喝口水 ，再看这篇文章。买菜。跑步 3.5 公里。运行 npm test 就行，详情见 。",
  );
  for (const gone of ["console", "|", "http", "*", "😊", "#"])
    assert.ok(!spoken.includes(gone), gone);
});

test("长句写到一半就能念，但不在网址、数字和链接中间断开", () => {
  const f = spokenFilter();
  assert.equal(f.push("好的，我看看"), "好的，");
  assert.equal(f.push("。版本是 3.5"), "我看看。");
  assert.equal(f.push(" 吗？链接 [文"), "版本是 3.5 吗？");
  assert.equal(f.push("章](https://a.cn/x.y) 在这"), "");
  assert.equal(f.flush(), "链接 文章 在这。");
});

test("只收整段的服务：攒够一句才送，太短的并进下一句，太长的在逗号处切", () => {
  const s = sentences(6, 20);
  assert.deepEqual(s.push("好。今天"), []);
  assert.deepEqual(s.push("天气不错。我们出去吧"), ["好。今天天气不错。"]);
  assert.deepEqual(s.push("，去公园散步，再去湖边看看日落和晚霞吧"), [
    "我们出去吧，去公园散步，",
  ]);
  assert.equal(s.flush(), "再去湖边看看日落和晚霞吧");
});

test("多语言断句与标题停顿：支持英文/韩文句点、小数、网址、省略号、日文顿号与空格回退", () => {
  // English & Korean headings/lists use ASCII period (with space between lines), while Han/Kana use 。
  assert.equal(
    say(["## Today's Plan", "- Buy milk", "1. Run 3.5 km"].join("\n"), 4),
    "Today's Plan. Buy milk. Run 3.5 km.",
  );
  assert.equal(
    say(["## 오늘의 일정", "- 커피 마시기", "- 산책하기"].join("\n"), 3),
    "오늘의 일정. 커피 마시기. 산책하기.",
  );
  assert.equal(
    say(["## 今日の予定", "- 買い物", "- カタカナ"].join("\n"), 3),
    "今日の予定。買い物。カタカナ。",
  );

  // English sentences split on ASCII '.' followed by whitespace or EOS, keeping decimals, URLs, and ellipses intact
  const en = sentences(6, 200);
  assert.deepEqual(
    en.push(
      "Version 3.5 is out. Visit example.com today. Wait... let me check.",
    ),
    ["Version 3.5 is out.", "Visit example.com today.", "Wait... let me check."],
  );
  assert.equal(en.flush(), "");

  // Decimals right before sentence end and ellipses mid-stream
  const en2 = sentences(6, 200);
  assert.deepEqual(en2.push("It costs $3.5. "), ["It costs $3.5."]);
  assert.deepEqual(en2.push("Wait... "), []);
  assert.deepEqual(en2.push("really?"), ["Wait... really?"]);

  // Korean sentences split on ASCII '.'
  const ko = sentences(6, 200);
  assert.deepEqual(ko.push("안녕하세요. 반갑습니다."), [
    "안녕하세요.",
    "반갑습니다.",
  ]);
  assert.equal(ko.flush(), "");

  // Japanese long run without 。 cuts at 、
  const ja = sentences(6, 20);
  assert.deepEqual(
    ja.push("今日は朝からとても良い天気で、近くの公園まで歩いて行きました"),
    ["今日は朝からとても良い天気で、"],
  );
  assert.equal(ja.flush(), "近くの公園まで歩いて行きました");

  // Long English & Korean runs without commas cut at whitespace instead of splitting words
  const longEn = sentences(6, 24);
  assert.deepEqual(
    longEn.push("This is a very long sentence without any punctuation at all"),
    ["This is a very long", "sentence without any"],
  );
  assert.equal(longEn.flush(), "punctuation at all");

  const longKo = sentences(6, 20);
  assert.deepEqual(
    longKo.push("오늘은 날씨가 정말 좋아서 공원에 산책하러 가고 싶어요"),
    ["오늘은 날씨가 정말 좋아서 공원에"],
  );
  assert.equal(longKo.flush(), "산책하러 가고 싶어요");
});

test("火山引擎二进制帧：请求带事件号和会话号，服务端的音频和事件能读出来", () => {
  const start = encode(Event.StartSession, { a: 1 }, "s1");
  assert.deepEqual([...start.subarray(0, 4)], [0x11, 0x14, 0x10, 0x00]);
  const view = new DataView(start.buffer);
  assert.equal(view.getInt32(4), 100);
  assert.equal(view.getUint32(8), 2);
  assert.equal(new TextDecoder().decode(start.subarray(12, 14)), "s1");
  assert.deepEqual(JSON.parse(new TextDecoder().decode(start.subarray(18))), {
    a: 1,
  });
  // A client connection event has no id.
  assert.equal(encode(Event.StartConnection, {}).length, 4 + 4 + 4 + 2);

  const audio = serverFrame(
    0b1011,
    Event.TTSResponse,
    "s1",
    Uint8Array.of(1, 2, 3, 4),
  );
  assert.deepEqual([...decode(audio).audio!], [1, 2, 3, 4]);
  const started = serverFrame(
    0b1001,
    Event.ConnectionStarted,
    "conn",
    json({}),
  );
  assert.equal(decode(started).event, Event.ConnectionStarted);
  const failed = serverFrame(
    0b1001,
    Event.SessionFailed,
    "s1",
    json({ status_code: 55000001 }),
  );
  assert.deepEqual(decode(failed).json, { status_code: 55000001 });
});

function json(v: object) {
  return new TextEncoder().encode(JSON.stringify(v));
}
function serverFrame(
  type: number,
  event: number,
  id: string,
  payload: Uint8Array,
) {
  const idBytes = new TextEncoder().encode(id);
  const out = new Uint8Array(4 + 4 + 4 + idBytes.length + 4 + payload.length);
  const view = new DataView(out.buffer);
  out.set([0x11, (type << 4) | 0b0100, type === 0b1011 ? 0 : 0x10, 0]);
  view.setInt32(4, event);
  view.setUint32(8, idBytes.length);
  out.set(idBytes, 12);
  view.setUint32(12 + idBytes.length, payload.length);
  out.set(payload, 16 + idBytes.length);
  return out;
}

/** Runs a reply through `speak` and collects what the pet window would get. */
async function speakReply(config: VoiceConfig, pieces: string[]) {
  const events: { method: string; data: any }[] = [];
  const done = new Promise<void>((ok) => {
    const s = speak(config, (method, data) => {
      events.push({ method, data });
      if (method === "speech.end") ok();
    });
    for (const p of pieces) s.push(p);
    s.end();
  });
  await done;
  const audio = events
    .filter((e) => e.method === "speech.audio")
    .flatMap((e) => [...Buffer.from(e.data.audio, "base64")]);
  return {
    events,
    audio,
    end: events.find((e) => e.method === "speech.end")!.data,
  };
}

async function wsServer(
  onConnect: (peer: Peer, headers: Record<string, unknown>) => void,
) {
  const server = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(server, "listening");
  server.on("connection", (peer, req) => onConnect(peer, req.headers));
  const { port } = server.address() as AddressInfo;
  return { url: `ws://127.0.0.1:${port}`, close: () => server.close() };
}

test("OpenAI 兼容：每句一个请求，PCM 半个采样也能拼回来", async (t) => {
  const bodies: any[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    bodies.push({
      auth: req.headers.authorization,
      path: req.url,
      ...JSON.parse(body),
    });
    res.writeHead(200, { "Content-Type": "audio/pcm" });
    res.write(Uint8Array.of(1, 2, 3));
    await new Promise((r) => setTimeout(r, 5));
    res.end(Uint8Array.of(4));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => server.close());
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  const r = await speakReply(
    { provider: "openai", apiKey: "k", voice: "alloy", baseUrl: base },
    ["今天天气不错。", "我们出去走走吧"],
  );
  assert.equal(r.end.error, undefined);
  assert.deepEqual(
    bodies.map((b) => [b.path, b.auth, b.input, b.response_format, b.voice]),
    [
      ["/v1/audio/speech", "Bearer k", "今天天气不错。", "pcm", "alloy"],
      ["/v1/audio/speech", "Bearer k", "我们出去走走吧。", "pcm", "alloy"],
    ],
  );
  assert.deepEqual(r.audio, [1, 2, 3, 4, 1, 2, 3, 4]);
  assert.equal(r.events[0].data.rate, 24000);
});

test("阿里百炼：run-task 后才送文字，结束发 finish-task，二进制帧就是音频", async (t) => {
  const seen: any[] = [];
  let auth: unknown;
  const server = await wsServer((peer, headers) => {
    auth = headers.authorization;
    peer.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      seen.push([
        m.header.action,
        m.payload.input?.text ?? m.payload.parameters?.format,
      ]);
      if (m.header.action === "run-task")
        setTimeout(
          () =>
            peer.send(JSON.stringify({ header: { event: "task-started" } })),
          10,
        );
      if (m.header.action === "continue-task") peer.send(Buffer.from([7, 8]));
      if (m.header.action === "finish-task")
        peer.send(JSON.stringify({ header: { event: "task-finished" } }));
    });
  });
  t.after(server.close);
  const r = await speakReply(
    {
      provider: "aliyun",
      apiKey: "k",
      voice: "longanyang",
      baseUrl: server.url,
    },
    ["你好，", "很高兴见到你。"],
  );
  assert.equal(auth, "bearer k");
  assert.deepEqual(seen, [
    ["run-task", "pcm"],
    // Each piece goes on as it comes; the service joins sentences.
    ["continue-task", "你好，"],
    ["continue-task", "很高兴见到你。"],
    ["finish-task", undefined],
  ]);
  assert.deepEqual(r.audio, [7, 8, 7, 8]);
  assert.equal(r.end.error, undefined);
});

test("MiniMax：连上后 task_start，十六进制音频，最后一条的整段重复音频不再播", async (t) => {
  const seen: string[] = [];
  const server = await wsServer((peer) => {
    peer.send(
      JSON.stringify({
        event: "connected_success",
        base_resp: { status_code: 0 },
      }),
    );
    peer.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      seen.push(m.event + (m.text ?? m.audio_setting?.format ?? ""));
      if (m.event === "task_start")
        peer.send(JSON.stringify({ event: "task_started" }));
      if (m.event === "task_continue")
        peer.send(
          JSON.stringify({
            event: "task_continued",
            data: { audio: "0a0b" },
            is_final: false,
          }),
        );
      if (m.event === "task_finish") {
        peer.send(
          JSON.stringify({
            event: "task_continued",
            data: { audio: "0a0b" },
            is_final: true,
          }),
        );
        peer.send(JSON.stringify({ event: "task_finished" }));
      }
    });
  });
  t.after(server.close);
  const r = await speakReply(
    {
      provider: "minimax",
      apiKey: "k",
      voice: "male-qn-qingse",
      baseUrl: server.url,
    },
    ["好呀！"],
  );
  assert.deepEqual(seen, [
    "task_startpcm",
    "task_continue好呀！",
    "task_finish",
  ]);
  assert.deepEqual(r.audio, [10, 11]);
});

test("MiniMax：Key 不对时报 auth", async (t) => {
  const server = await wsServer((peer) =>
    peer.send(
      JSON.stringify({
        event: "task_failed",
        base_resp: { status_code: 1004 },
      }),
    ),
  );
  t.after(server.close);
  const r = await speakReply(
    { provider: "minimax", apiKey: "bad", voice: "v", baseUrl: server.url },
    ["你好。"],
  );
  assert.equal(r.end.error, "auth");
});

test("火山引擎：连接、会话、逐段 TaskRequest、结束会话，新版用 X-Api-Key", async (t) => {
  const seen: number[] = [];
  let headers: Record<string, unknown> = {};
  const texts: string[] = [];
  const server = await wsServer((peer, h) => {
    headers = h;
    peer.on("message", (raw) => {
      const bytes = new Uint8Array(raw as Buffer);
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const event = view.getInt32(4);
      seen.push(event);
      const reply = (type: number, e: number, payload: Uint8Array) =>
        peer.send(serverFrame(type, e, "x", payload));
      if (event === Event.StartConnection)
        reply(0b1001, Event.ConnectionStarted, json({}));
      if (event === Event.StartSession)
        reply(0b1001, Event.SessionStarted, json({}));
      if (event === Event.TaskRequest) {
        const idLen = view.getUint32(8);
        const body = JSON.parse(
          new TextDecoder().decode(bytes.subarray(16 + idLen)),
        );
        texts.push(body.req_params.text);
        reply(0b1011, Event.TTSResponse, Uint8Array.of(5, 6));
      }
      if (event === Event.FinishSession)
        reply(0b1001, Event.SessionFinished, json({}));
    });
  });
  t.after(server.close);
  const r = await speakReply(
    {
      provider: "volcengine",
      apiKey: "k",
      voice: "zh_female_test",
      baseUrl: server.url,
    },
    ["你好，", "今天也加油。"],
  );
  assert.equal(headers["x-api-key"], "k");
  assert.equal(headers["x-api-resource-id"], "seed-tts-2.0");
  assert.deepEqual(seen.slice(0, 5), [1, 100, 200, 200, 102]);
  assert.deepEqual(texts, ["你好，", "今天也加油。"]);
  assert.deepEqual(r.audio, [5, 6, 5, 6]);
  assert.equal(r.end.error, undefined);
});

test("火山引擎旧版控制台：App ID 加 Access Key", async (t) => {
  let headers: Record<string, unknown> = {};
  const server = await wsServer((peer, h) => {
    headers = h;
    peer.send(
      serverFrame(
        0b1001,
        Event.ConnectionFailed,
        "c",
        json({ status_code: 45000000 }),
      ),
    );
  });
  t.after(server.close);
  const r = await speakReply(
    {
      provider: "volcengine",
      apiKey: "access",
      appId: "123",
      voice: "v",
      baseUrl: server.url,
    },
    ["你好。"],
  );
  assert.equal(headers["x-api-app-id"], "123");
  assert.equal(headers["x-api-access-key"], "access");
  assert.equal(headers["x-api-key"], undefined);
  assert.equal(r.end.error, "auth");
});

test("ElevenLabs：先送空格开场，空文字结束，base64 音频", async (t) => {
  const seen: string[] = [];
  const server = await wsServer((peer) => {
    peer.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      seen.push(m.text);
      if (m.text && m.text.trim())
        peer.send(
          JSON.stringify({ audio: Buffer.from([9]).toString("base64") }),
        );
      if (m.text === "")
        peer.send(JSON.stringify({ audio: null, isFinal: true }));
    });
  });
  t.after(server.close);
  const r = await speakReply(
    { provider: "elevenlabs", apiKey: "k", voice: "v1", baseUrl: server.url },
    ["Hello there."],
  );
  assert.deepEqual(seen, [" ", "Hello there.", ""]);
  assert.deepEqual(r.audio, [9]);
});

test("停止：取消后不再有声音，也告诉服务端", async (t) => {
  const seen: string[] = [];
  const server = await wsServer((peer) => {
    peer.send(JSON.stringify({ event: "connected_success" }));
    peer.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      seen.push(m.event);
      if (m.event === "task_start")
        peer.send(JSON.stringify({ event: "task_started" }));
    });
  });
  t.after(server.close);
  const events: string[] = [];
  const s = speak(
    { provider: "minimax", apiKey: "k", voice: "v", baseUrl: server.url },
    (method) => events.push(method),
  );
  s.push("第一句话。");
  await new Promise((r) => setTimeout(r, 100));
  s.cancel();
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(seen, ["task_start", "task_continue", "task_cancel"]);
  assert.deepEqual(events, ["speech.end", "speech.stop"]);
});

test("回答被改写：已经念过的不重念，换了内容就从头念新的", async (t) => {
  const sent: string[] = [];
  const server = await wsServer((peer) => {
    peer.send(JSON.stringify({ event: "connected_success" }));
    peer.on("message", (raw) => {
      const m = JSON.parse(String(raw));
      if (m.event === "task_start")
        peer.send(JSON.stringify({ event: "task_started" }));
      if (m.event === "task_continue") sent.push(m.text);
    });
  });
  t.after(server.close);
  const s = speak(
    { provider: "minimax", apiKey: "k", voice: "v", baseUrl: server.url },
    () => {},
  );
  s.push("你好。");
  await new Promise((r) => setTimeout(r, 100));
  s.rewind("你好。今天");
  s.rewind("没设好。");
  await new Promise((r) => setTimeout(r, 150));
  s.cancel();
  assert.deepEqual(sent, ["你好。", "没设好。"]);
});

test("大脑：朗读保持聊天原文，speech_stop 能随时调用", async (t) => {
  const model = await fakeModel([{ chunks: ["好的，", "马上。"] }]);
  t.after(model.close);
  const brain = launch();
  t.after(brain.close);
  await brain.request("initialize", {
    apiKey: "fixture",
    model: "fixture",
    baseUrl: model.baseUrl,
  });
  const reply = await brain.request("chat", {
    text: "你好",
    timeNote: "［现在 12:00。］",
    speak: {
      provider: "openai",
      apiKey: "k",
      voice: "alloy",
      baseUrl: "http://127.0.0.1:9/v1",
    },
  });
  assert.equal(reply.result.text, "好的，马上。");
  assert.equal((await brain.request("speech_stop")).result, true);
  // Voice output must not add instructions to the chat model's messages.
  assert.doesNotMatch(
    JSON.stringify(model.requests[0].body.messages),
    /这次的回答会被念出来/,
  );
  // A line on its own (a reminder, 试听) needs a complete voice.
  const line = await brain.request("speak", {
    text: "该喝水啦",
    speak: {
      provider: "openai",
      apiKey: "k",
      voice: "alloy",
      baseUrl: "http://127.0.0.1:9/v1",
    },
  });
  assert.equal(line.result, true);
  assert.ok((await brain.request("speak", { text: "x", speak: {} })).error);
  // An incomplete voice config is ignored, not an error.
  const model2 = await fakeModel([{ chunks: ["嗯"] }]);
  t.after(model2.close);
  await brain.request("configure", {
    apiKey: "fixture",
    model: "fixture",
    baseUrl: model2.baseUrl,
  });
  const plain = await brain.request("chat", {
    text: "你好",
    timeNote: "［现在 12:00。］",
    speak: { provider: "openai" },
  });
  assert.equal(plain.result.text, "嗯");
  assert.doesNotMatch(
    JSON.stringify(model2.requests[0].body.messages),
    /念出来/,
  );
  assert.deepEqual(
    model.requests[0].body.messages,
    model2.requests[0].body.messages,
  );
});
