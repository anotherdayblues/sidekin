// 待办 (plan/27, an experiment): the host's to-dos, for every window. The
// host (src-tauri/src/todo) owns them; outside the app (previews) a few
// samples stand in.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "../bridge.ts";
import { t, dateLocale, type Key } from "../i18n.ts";

/** 今天 and 以后 (plan/30); one from an earlier day carries on in 今天. */
export type Group = "today" | "later" | "done";
/** What the bubble answers an alert with (plan/30: four snoozes). */
export type Answer =
  "done" | "snooze10" | "snooze60" | "tonight" | "tomorrow" | "dismiss";
export type Repeat = "daily" | "weekdays" | "weekly";
export interface Todo {
  id: number;
  title: string;
  /** YYYY-MM-DD, or none. */
  day: string | null;
  /** HH:MM: only when to remind, never the order. */
  time: string | null;
  repeat: Repeat | null;
  doneAt: number | null;
  tomatoes: number;
  /** Its alert went off and waits for an answer. */
  due: boolean;
  group: Group;
  /** Open, from an earlier day: it carries on in 今天 (昨天的). */
  carried: boolean;
}
/** A new to-do, or what to change: "" clears a day, time or repeat. */
export interface Fields {
  title?: string;
  day?: string;
  time?: string;
  repeat?: Repeat | "";
}
/** What 伙伴大脑 drafted (plan/31): to add once the user has picked. */
export interface Draft {
  title: string;
  day?: string;
  time?: string;
  /** For a step: what done looks like. Shown, not kept. */
  note?: string;
}
export interface FocusOn {
  current: Todo | null;
  candidates: Todo[];
}

export const REPEATS: [Repeat | "", Key][] = [
  ["", "todo.repeatNone"],
  ["daily", "todo.daily"],
  ["weekdays", "todo.weekdays"],
  ["weekly", "todo.weekly"],
];

/** A local day as the host writes it. */
export function dayText(d: Date) {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
export function today(offset = 0) {
  const d = new Date();
  d.setDate(d.getDate() + offset);
  return dayText(d);
}
/** "11月18日 周三", or "今天" / "明天". */
export function dayLabel(day: string) {
  if (day === today()) return t("todo.today");
  if (day === today(1)) return t("todo.tomorrow");
  const [y, m, d] = day.split("-").map(Number);
  return new Date(y, m - 1, d).toLocaleDateString(dateLocale, {
    month: "short",
    day: "numeric",
    weekday: "short",
  });
}
/** "昨天的", or "11月14日 周六的", for one carried on into 今天. */
export function carriedLabel(day: string) {
  return day === today(-1)
    ? t("todo.carriedYesterday")
    : t("todo.carriedFrom", { day: dayLabel(day) });
}
/** The snoozes an alert offers, each with the time it rings again (as iOS
 * 26.5 writes it): 今晚 only before 19:30. */
export function snoozes(now = new Date()): [Answer, Key, string][] {
  const clock = (d: Date) =>
    d.toLocaleTimeString(dateLocale, { hour: "numeric", minute: "2-digit" });
  const after = (min: number) => new Date(now.getTime() + min * 60_000);
  const at = (days: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() + days);
    d.setHours(hour, 0, 0, 0);
    return d;
  };
  const out: [Answer, Key, string][] = [
    ["snooze10", "todo.in10", clock(after(10))],
    ["snooze60", "todo.in60", clock(after(60))],
  ];
  if (now.getHours() * 60 + now.getMinutes() < 19 * 60 + 30)
    out.push(["tonight", "todo.tonight", clock(at(0, 20))]);
  out.push(["tomorrow", "todo.tomorrowMorning", clock(at(1, 9))]);
  return out;
}
export function repeatLabel(r: Repeat | null) {
  const found = REPEATS.find(([v]) => v === r);
  return r && found ? t(found[1]) : "";
}

// ---------- outside the app: samples ----------
let samples: Todo[] = [];
function sample(): Todo[] {
  if (samples.length) return samples;
  const base = {
    doneAt: null,
    tomatoes: 0,
    due: false,
    repeat: null,
    carried: false,
  };
  samples = [
    {
      ...base,
      id: 1,
      title: "回复设计稿的意见",
      day: today(-1),
      time: null,
      group: "today",
      carried: true,
    },
    {
      ...base,
      id: 2,
      title: "写周报",
      day: today(),
      time: null,
      tomatoes: 2,
      group: "today",
    },
    {
      ...base,
      id: 3,
      title: "开会",
      day: today(),
      time: "15:00",
      group: "today",
    },
    {
      ...base,
      id: 4,
      title: "喝水",
      day: today(),
      time: "16:30",
      repeat: "daily",
      group: "today",
    },
    {
      ...base,
      id: 5,
      title: "交报告",
      day: today(2),
      time: null,
      group: "later",
    },
    {
      ...base,
      id: 6,
      title: "整理照片",
      day: null,
      time: null,
      group: "later",
    },
    {
      ...base,
      id: 7,
      title: "订机票",
      day: today(),
      time: null,
      doneAt: Date.now(),
      group: "done",
    },
  ];
  return samples;
}
const previewListeners = new Set<() => void>();
function previewChange() {
  for (const cb of previewListeners) cb();
}

async function call<T>(
  cmd: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (native) return invoke<T>(cmd, args);
  const list = sample();
  const find = (id: unknown) => list.find((x) => x.id === id)!;
  let out: unknown = null;
  if (cmd === "todo_list") out = list;
  if (cmd === "todo_spent") out = [];
  if (cmd === "todo_focus_state")
    out = {
      current: null,
      candidates: list.filter((x) => x.group === "today"),
    };
  if (cmd === "todo_complete") {
    const x = find(args.id);
    Object.assign(x, { doneAt: Date.now(), group: "done" });
    out = x;
  }
  if (cmd === "todo_reopen") {
    const x = find(args.id);
    Object.assign(x, { doneAt: null, group: "today" });
    out = x;
  }
  if (cmd === "todo_remove") samples = list.filter((x) => x.id !== args.id);
  if (cmd === "todo_add") {
    const f = args.fields as Fields;
    const x: Todo = {
      id: Date.now(),
      title: f.title ?? "",
      day: f.day || null,
      time: f.time || null,
      repeat: (f.repeat || null) as Repeat | null,
      doneAt: null,
      tomatoes: 0,
      due: false,
      group: f.day === today() ? "today" : "later",
      carried: false,
    };
    list.push(x);
    out = x;
  }
  if (cmd === "todo_move") {
    const x = find(args.id);
    const rest = list.filter((y) => y !== x);
    const into = args.today ? "today" : "later";
    if (x.group !== into || (into === "today" && x.carried)) {
      x.group = into;
      x.carried = false;
      x.day = into === "today" ? today() : null;
      if (into === "later") x.time = null;
    }
    const at = rest.findIndex((y) => y.id === args.before);
    rest.splice(at < 0 ? rest.length : at, 0, x);
    samples = rest;
    out = x;
  }
  if (cmd === "todo_ai_ready") out = true;
  if (cmd === "todo_plan") {
    // Outside the app: each sentence a to-do, or three plain steps.
    const text = String(args.text);
    out =
      args.mode === "break"
        ? [1, 2, 3].map((n) => ({ title: `${text} · ${n}` }))
        : text
            .split(/[。！？；;!?]/)
            .map((s) => s.trim())
            .filter(Boolean)
            .map((title) => ({ title }));
  }
  if (cmd === "todo_update") {
    const f = args.fields as Fields;
    const x = find(args.id);
    Object.assign(x, {
      title: f.title ?? x.title,
      day: f.day === undefined ? x.day : f.day || null,
      time: f.time === undefined ? x.time : f.time || null,
      repeat: f.repeat === undefined ? x.repeat : f.repeat || null,
    });
    out = x;
  }
  if (
    ![
      "todo_list",
      "todo_focus_state",
      "todo_spent",
      "todo_ai_ready",
      "todo_plan",
    ].includes(cmd)
  )
    previewChange();
  return out as T;
}

export const todos = {
  list: () => call<Todo[]>("todo_list"),
  add: (fields: Fields, source = "app") =>
    call<Todo>("todo_add", { fields, source }),
  update: (id: number, fields: Fields) =>
    call<Todo>("todo_update", { id, fields }),
  complete: (id: number) => call<Todo>("todo_complete", { id }),
  reopen: (id: number) => call<Todo>("todo_reopen", { id }),
  remove: (id: number) => call<void>("todo_remove", { id }),
  /** 伙伴大脑 is on: the helpers of plan/31 show only then. */
  aiReady: () => call<boolean>("todo_ai_ready").catch(() => false),
  /** 伙伴大脑 drafts: "split" a pasted paragraph, "break" one to-do. */
  plan: (text: string, mode: "split" | "break") =>
    call<Draft[]>("todo_plan", { text, mode }),
  /** Dragged into 今天 or 以后, before `before` or last. */
  move: (id: number, today: boolean, before: number | null) =>
    call<Todo>("todo_move", { id, today, before }),
  pending: () => (native ? call<Todo[]>("todo_pending") : Promise.resolve([])),
  answer: (ids: number[], action: Answer) =>
    call<Todo[]>("todo_answer", { ids, action }),
  focusState: () => call<FocusOn>("todo_focus_state"),
  /** Starts a tomato on `id`, or on nothing. */
  focus: (id: number | null) => call<unknown>("todo_focus", { id }),
  /** The running tomato is on `id` from now on. */
  focusOn: (id: number | null) => call<void>("todo_focus_set", { id }),
  /** What the focus sessions begun since `from` (ms) were spent on. */
  spent: (from: number) =>
    call<{ at: number; title: string }[]>("todo_spent", { from }),
};

/** Every change, from any window. */
export async function onTodos(cb: () => void) {
  if (!native) {
    previewListeners.add(cb);
    return () => previewListeners.delete(cb);
  }
  return listen("todos-changed", () => cb());
}
