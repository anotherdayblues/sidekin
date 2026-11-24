// 一行字认出日期、时间和重复 (plan/27): "明天下午3点交报告" is 交报告,
// tomorrow, 15:00. Days and times are read by chrono-node (the library
// Super Productivity's add bar uses), loaded the first time a line is
// used. On top of it, what a to-do needs and chrono does not do:
//   repeats      每天, 工作日, 每周三, every day / weekday / monday;
//   a few days   一周后, 下个月5号 (chrono has 一个星期后, not these);
//   3点 alone    is 15:00: a to-do at three in the night is rare (chrono
//                reads it as 03:00).
// As in TickTick, Todoist and Super Productivity, what was understood is
// shown and can be dropped (quick.ts).
import type { ParsedResult, ParsingOption } from "chrono-node";
import type { Repeat } from "./api.ts";

export interface Quick {
  title: string;
  day?: string;
  time?: string;
  repeat?: Repeat;
  /** Where the words were, [start, end) in the text, for highlighting. */
  spans: [number, number][];
}

type Parse = (
  text: string,
  ref: Date,
  option?: ParsingOption,
) => ParsedResult[];
let readers: Parse[] | null = null;
let loading: Promise<void> | null = null;
/** Loads chrono-node (Chinese and English) once; until then only the
 * rules below are read. */
export function loadParser() {
  loading ??= Promise.all([
    import("chrono-node/zh"),
    import("chrono-node/en"),
  ]).then(([zh, en]) => {
    readers = [
      (t, r, o) => zh.hans.parse(t, r, o),
      (t, r, o) => en.parse(t, r, o),
    ];
  });
  return loading;
}

const DIGIT: Record<string, number> = {
  零: 0,
  〇: 0,
  一: 1,
  二: 2,
  两: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  七: 7,
  八: 8,
  九: 9,
};
/** "3", "十二", "二十三" → 3, 12, 23. */
function num(s: string): number {
  if (/^\d+$/.test(s)) return Number(s);
  if (s === "十") return 10;
  const [tens, ones] = s.split("十");
  if (s.includes("十"))
    return (tens ? DIGIT[tens] : 1) * 10 + (ones ? DIGIT[ones] : 0);
  return DIGIT[s] ?? NaN;
}
const N = "(\\d{1,2}|[零〇一二两三四五六七八九十]{1,3})";
const WEEKDAY: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
  mon: 1,
  tue: 2,
  wed: 3,
  thu: 4,
  fri: 5,
  sat: 6,
  sun: 7,
};
const pad = (n: number) => String(n).padStart(2, "0");
function dayText(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function plus(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  return x;
}
/** The coming `weekday` (today counts). Monday 1 … Sunday 7. */
function coming(now: Date, w: number) {
  const today = ((now.getDay() + 6) % 7) + 1;
  return plus(now, (w - today + 7) % 7);
}

type Rule = {
  re: RegExp;
  apply(m: RegExpExecArray, q: Quick, now: Date): boolean;
};
/** What chrono does not read. Repeats come first, so that 每周三 is a
 * weekly to-do and not just Wednesday. */
const RULES: Rule[] = [
  {
    re: /每(?:个)?(?:天|日)|every\s*day|daily/i,
    apply: (_, q) => ((q.repeat = "daily"), true),
  },
  {
    re: /(?:每个)?工作日|周一到周五|weekdays|every\s*weekday/i,
    apply: (_, q) => ((q.repeat = "weekdays"), true),
  },
  {
    re: /每(?:个)?(?:周|星期|礼拜)([一二三四五六日天])?|every\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*|weekly|every\s*week/i,
    apply: (m, q, now) => {
      q.repeat = "weekly";
      const w = m[1] ?? m[2];
      if (w && !q.day) q.day = dayText(coming(now, WEEKDAY[w.toLowerCase()]));
      return true;
    },
  },
  {
    re: new RegExp(`${N}\\s*个?(?:周|星期|礼拜)(?:后|以后|之后)`),
    apply: (m, q, now) => {
      if (q.day) return false;
      q.day = dayText(plus(now, 7 * num(m[1])));
      return true;
    },
  },
  {
    re: new RegExp(`下个?月\\s*${N}\\s*(?:号|日)`),
    apply: (m, q, now) => {
      if (q.day) return false;
      const date = num(m[1]);
      const d = new Date(now.getFullYear(), now.getMonth() + 1, date);
      if (d.getDate() !== date) return false;
      q.day = dayText(d);
      return true;
    },
  },
];

/** A day and time read by chrono, as a to-do takes them. */
function fromChrono(r: ParsedResult, q: Quick) {
  const c = r.start;
  // "两小时后", "in 2 hours": the moment itself, its day included.
  const relative = /(?:后|以后|之后)\s*$|^in\s|later|from now/i.test(
    r.text.trim(),
  );
  const date = c.date();
  let took = false;
  if (!q.day && (c.isCertain("day") || c.isCertain("weekday") || relative)) {
    q.day = dayText(date);
    took = true;
  }
  if (!q.time && c.isCertain("hour")) {
    let h = c.get("hour") ?? 0;
    // 3点 with no part of the day is the afternoon.
    if (!relative && !c.isCertain("meridiem") && h >= 1 && h <= 6) h += 12;
    q.time = `${pad(h)}:${pad(c.get("minute") ?? 0)}`;
    took = true;
  }
  return took;
}

/** What a line says: the title left once the day, time and repeat words
 * are taken out. */
export function parseQuick(text: string, now = new Date()): Quick {
  const q: Quick = { title: text, spans: [] };
  const taken = text.split("").map(() => false);
  const take = (start: number, end: number) => {
    for (let i = start; i < end; i++) taken[i] = true;
    q.spans.push([start, end]);
  };
  for (const rule of RULES) {
    const re = new RegExp(rule.re.source, rule.re.flags + "g");
    for (const m of text.matchAll(re)) {
      const start = m.index!,
        end = start + m[0].trimEnd().length;
      if (taken.slice(start, end).some(Boolean)) continue;
      if (!rule.apply(m as RegExpExecArray, q, now)) continue;
      take(start, end);
      break;
    }
  }
  // chrono reads the rest, with what was taken blanked out.
  const rest = text
    .split("")
    .map((ch, i) => (taken[i] ? " " : ch))
    .join("");
  const found = (readers ?? [])
    .flatMap((read) => read(rest, now, { forwardDate: true }))
    .sort((a, b) => a.index - b.index);
  for (const r of found) {
    if (q.day && q.time) break;
    // chrono's match can start with the blanks left by what was taken.
    const start = r.index + (r.text.length - r.text.trimStart().length),
      end = start + r.text.trim().length;
    if (end <= start || taken.slice(start, end).some(Boolean)) continue;
    if (fromChrono(r, q)) take(start, end);
  }
  q.spans.sort((a, b) => a[0] - b[0]);
  // A time with no day is today (as the host does too).
  if (q.time && !q.day) q.day = dayText(now);
  // "明天下午3点前交报告": a 前 or 之前 right after the time goes with it.
  for (const [, end] of [...q.spans]) {
    const after = /^(之前|以前|前(?![端面台后途景]))/.exec(text.slice(end));
    if (after)
      for (let i = end; i < end + after[0].length; i++) taken[i] = true;
  }
  q.title = text
    .split("")
    .filter((_, i) => !taken[i])
    .join("")
    .replace(/\s+/g, " ")
    .replace(/^[\s,，、。:：]+|[\s,，、:：]+$/g, "")
    .replace(/(?:\s+(?:on|at|by|in))+$/i, "")
    .trim();
  if (!q.title) q.title = text.trim();
  return q;
}
