// Browser-preview stand-in for the host: a few fixed topics and an answer
// that streams back, so screenshots can show every chat state.
import type { BrainEvent, ChatBackend, Topic, Turn } from "./chatBackend.ts";

const MIN = 60_000;
const base = new Date("2026-11-05T14:00:00").getTime();
export const fixtures: Record<string, Turn[]> = {
  empty: [],
  talk: [
    {
      question: "今天下午要做什么来着？",
      answer: "你上午说下午要整理随伴的界面计划，还有 4 点要给小周回邮件。",
      at: base,
    },
    {
      question: "邮件先帮我起个头",
      answer:
        "可以这样开头：\n\n```\n小周你好，\n界面计划我整理好了，附件是第一版。\n```\n\n要我再写正文吗？",
      at: base + 2 * MIN,
    },
    {
      question: "先这样，谢谢",
      answer: "好，4 点前我再提醒你一次。",
      at: base + 3 * MIN,
    },
  ],
  image: [
    {
      question: "［图片］这是什么花？",
      answer: "看起来是**蓝雪花**，喜欢晒太阳，夏天开得最多。",
      at: base,
    },
    {
      question: "好养吗",
      answer: "好养。要点就两条：\n- 每天晒够 4 小时\n- 土干了再浇透",
      at: base + 12 * MIN,
    },
  ],
};
const topics: Topic[] = [
  { id: 3, title: "今天下午要做什么来着？", lastAt: base + 3 * MIN, turns: 3, pet: "lizi" },
  {
    id: 2,
    title: "［图片］这是什么花？",
    lastAt: base - 26 * 60 * MIN,
    turns: 2,
    pet: "lizi",
  },
  {
    id: 1,
    title: "帮我把这段话翻成英文",
    lastAt: base - 4 * 24 * 60 * MIN,
    turns: 5,
    pet: "tuanzi",
  },
];

export function previewBackend(): ChatBackend & { use(name: string): void } {
  const deleted = new Set<number>();
  let currentId = 3;
  let turns: Turn[] = [...fixtures.talk];
  const listeners: ((e: BrainEvent) => void)[] = [];
  const updated: (() => void)[] = [];
  const timers = new Map<string, number>();
  const stops = new Map<string, (e: Error) => void>();
  return {
    use(name) {
      turns = [...(fixtures[name] ?? [])];
      updated.forEach((f) => f());
    },
    current: async () => ({
      id: turns.length ? currentId : null,
      turns: [...turns],
    }),
    send: (token, text, image, _forceSearch, files) =>
      new Promise((resolve, reject) => {
        const fileMark = files?.length
          ? `［文件：${files.map((f) => f.name).join("、")}］`
          : "";
        const reply = `（预览）收到${image ? "一张图片和" : ""}${files?.length ? `${files.length}个文件和` : ""}：${text.slice(0, 40)}`;
        let i = 0;
        const tick = () => {
          if (i >= reply.length) {
            timers.delete(token);
            stops.delete(token);
            turns.push({
              question: (image ? "［图片］" : "") + fileMark + text,
              answer: reply,
              at: Date.now(),
            });
            resolve(reply);
            return;
          }
          listeners.forEach((f) =>
            f({ method: "chat.delta", params: { token, delta: reply[i++] } }),
          );
          timers.set(token, window.setTimeout(tick, 30));
        };
        timers.set(token, window.setTimeout(tick, 300));
        stops.set(token, reject);
      }),
    cancel: async (token) => {
      clearTimeout(timers.get(token));
      timers.delete(token);
      stops.get(token)?.(new Error("stopped"));
      stops.delete(token);
    },
    newTopic: async () => {
      turns = [];
    },
    topics: async (query) =>
      topics.filter(
        (t) => !deleted.has(t.id) && (!query || t.title.includes(query)),
      ),
    linkedTasks: async () => [],
    deleteTopic: async (id) => {
      deleted.add(id);
      if (currentId === id) turns = [];
      updated.forEach((f) => f());
    },
    reopen: async (id) => {
      currentId = id;
      turns = [...(id === 2 ? fixtures.image : id === 3 ? fixtures.talk : [])];
    },
    listDocuments: async () => [
      { id: 1, name: "项目计划.pdf" },
      { id: 2, name: "读书笔记.md" },
    ],
    importFile: async () => {},
    onEvent: async (fn) => {
      listeners.push(fn);
    },
    onUpdated: async (fn) => {
      updated.push(fn);
    },
  };
}
