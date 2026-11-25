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
/** Loads chrono-node (Simplified/Traditional Chinese, English, Japanese) once;
 * until then only the rules below are read. */
export function loadParser() {
  loading ??= Promise.all([
    import("chrono-node/zh"),
    import("chrono-node/en"),
    import("chrono-node/ja"),
  ]).then(([zh, en, ja]) => {
    readers = [
      (t, r, o) => zh.hans.parse(t, r, o),
      (t, r, o) => zh.hant.parse(t, r, o),
      (t, r, o) => en.parse(t, r, o),
      (t, r, o) => ja.parse(t, r, o),
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
  兩: 2,
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
const N = "(\\d{1,2}|[零〇一二两兩三四五六七八九十]{1,3})";
const WEEKDAY: Record<string, number> = {
  一: 1,
  二: 2,
  三: 3,
  四: 4,
  五: 5,
  六: 6,
  日: 7,
  天: 7,
  月: 1,
  火: 2,
  水: 3,
  木: 4,
  金: 5,
  土: 6,
  월: 1,
  화: 2,
  수: 3,
  목: 4,
  금: 5,
  토: 6,
  일: 7,
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
function timeText(d: Date) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
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
/** Weekday `w` (Monday 1 … Sunday 7) of next calendar week. */
function nextWeek(now: Date, w: number) {
  const today = ((now.getDay() + 6) % 7) + 1;
  return plus(now, 7 - today + w);
}
/** Apply meridiem and the 1–6 afternoon heuristic to an hour. */
function applyMeridiem(hour: number, meridiem?: string): number | null {
  if (hour < 0 || hour > 23) return null;
  if (meridiem) {
    if (/^(?:午前|朝|深夜|오전|아침)$/.test(meridiem)) {
      return hour === 12 ? 0 : hour;
    }
    if (/^(?:午後|昼|夕方|夜|今夜|오후|낮|저녁|밤|오늘\s*밤)$/.test(meridiem)) {
      return hour >= 1 && hour < 12 ? hour + 12 : hour;
    }
  }
  if (hour >= 1 && hour <= 6) return hour + 12;
  return hour;
}

type Rule = {
  re: RegExp;
  apply(m: RegExpExecArray, q: Quick, now: Date): boolean;
};
/** What chrono does not read (repeats across all 5 locales, Traditional Chinese /
 * Japanese / Korean relative dates & times). Repeats come first, so that
 * 每周三 / 每週三 / 毎週水曜日 / 매주 수요일 is a weekly to-do and not just Wednesday. */
const RULES: Rule[] = [
  {
    re: /每(?:[个個])?(?:天|日)|毎日|まいにち|매일|every\s*day|daily/i,
    apply: (_, q) => ((q.repeat = "daily"), true),
  },
  {
    re: /(?:每[个個])?工作日|(?:周|週)一(?:到|至)(?:周|週)五|(?:毎週)?平日|月曜(?:日)?(?:から|〜|~|-)金曜(?:日)?|(?:매주\s*)?(?:평일|주중)|월(?:요일)?\s*[-~～]\s*금(?:요일)?|weekdays|every\s*weekday/i,
    apply: (_, q) => ((q.repeat = "weekdays"), true),
  },
  {
    re: /每(?:[个個])?(?:周|週|星期|礼拜|禮拜)([一二三四五六日天])?|毎週(?:([月火水木金土日])曜(?:日)?)?|매주(?:\s*([월화수목금토일])(?:요일)?)?|every\s*(mon|tue|wed|thu|fri|sat|sun)[a-z]*|weekly|every\s*week/i,
    apply: (m, q, now) => {
      q.repeat = "weekly";
      const w = m[1] ?? m[2] ?? m[3] ?? m[4];
      if (w && !q.day) q.day = dayText(coming(now, WEEKDAY[w.toLowerCase()]));
      return true;
    },
  },
  // Relative weeks (zh / zh-TW / ja / ko)
  {
    re: new RegExp(
      `(?:${N}\\s*(?:[个個]?(?:周|週|星期|礼拜|禮拜)(?:后|以后|之后|後|以後|之後)|週間(?:後|あと))|(\\d{1,2})\\s*주(?:일)?\\s*(?:후|뒤))`,
    ),
    apply: (m, q, now) => {
      if (q.day) return false;
      const count = num(m[1] ?? m[2]);
      if (!Number.isFinite(count)) return false;
      q.day = dayText(plus(now, 7 * count));
      return true;
    },
  },
  // Relative days (ja / ko)
  {
    re: new RegExp(`(?:${N}\\s*日(?:後|あと)|(\\d{1,2})\\s*일\\s*(?:후|뒤))`),
    apply: (m, q, now) => {
      if (q.day) return false;
      const count = num(m[1] ?? m[2]);
      if (!Number.isFinite(count)) return false;
      q.day = dayText(plus(now, count));
      return true;
    },
  },
  // Relative hours (ja / ko) — prevents chrono-ja reading "2時間後" as "2時"
  {
    re: new RegExp(`(?:${N}\\s*時間(?:後|あと)|(\\d{1,2})\\s*시간\\s*(?:후|뒤))`),
    apply: (m, q, now) => {
      if (q.day && q.time) return false;
      const count = num(m[1] ?? m[2]);
      if (!Number.isFinite(count)) return false;
      const target = new Date(now.getTime() + count * 3_600_000);
      if (!q.day) q.day = dayText(target);
      if (!q.time) q.time = timeText(target);
      return true;
    },
  },
  // Relative minutes (ja / ko)
  {
    re: new RegExp(`(?:${N}\\s*分(?:後|あと)|(\\d{1,2})\\s*분\\s*(?:후|뒤))`),
    apply: (m, q, now) => {
      if (q.day && q.time) return false;
      const count = num(m[1] ?? m[2]);
      if (!Number.isFinite(count)) return false;
      const target = new Date(now.getTime() + count * 60_000);
      if (!q.day) q.day = dayText(target);
      if (!q.time) q.time = timeText(target);
      return true;
    },
  },
  // Next month Nth day (zh / zh-TW / ja / ko)
  {
    re: new RegExp(
      `(?:(?:下[个個]?月\\s*${N}\\s*(?:号|號|日))|(?:来月\\s*${N}\\s*日)|(?:다음\\s*달\\s*(\\d{1,2})\\s*일))`,
    ),
    apply: (m, q, now) => {
      if (q.day) return false;
      const date = num(m[1] ?? m[2] ?? m[3]);
      if (!Number.isFinite(date)) return false;
      const d = new Date(now.getFullYear(), now.getMonth() + 1, date);
      if (d.getDate() !== date) return false;
      q.day = dayText(d);
      return true;
    },
  },
  // Japanese relative day words (runs before zh chrono can steal "後日" from "明後日")
  {
    re: /明後日|あさって|明日|あした|今日|きょう/,
    apply: (m, q, now) => {
      if (q.day) return false;
      const w = m[0];
      const offset =
        w === "明後日" || w === "あさって"
          ? 2
          : w === "明日" || w === "あした"
            ? 1
            : 0;
      q.day = dayText(plus(now, offset));
      return true;
    },
  },
  // Japanese weekday (来週月曜, 金曜, 水曜日)
  {
    re: /(来週|今週)?([月火水木金土日])曜(?:日)?/,
    apply: (m, q, now) => {
      if (q.day) return false;
      const w = WEEKDAY[m[2]];
      q.day = dayText(m[1] === "来週" ? nextWeek(now, w) : coming(now, w));
      return true;
    },
  },
  // Japanese time with optional meridiem (午前10時, 午後3時, 朝8時, 夜8時半, 9時30分)
  {
    re: /(午前|午後|朝|昼|夕方|夜|今夜|深夜)?\s*(\d{1,2})\s*時(?:\s*(\d{1,2})\s*分|\s*(半))?/,
    apply: (m, q, now) => {
      if (q.time) return false;
      const h = applyMeridiem(Number(m[2]), m[1]);
      if (h === null) return false;
      const min = m[4] ? 30 : m[3] ? Number(m[3]) : 0;
      if (min < 0 || min > 59) return false;
      if (m[1] === "今夜" && !q.day) q.day = dayText(now);
      q.time = `${pad(h)}:${pad(min)}`;
      return true;
    },
  },
  // Korean relative day words (오늘, 내일, 모레, 글피)
  {
    re: /글피|모레|내일|오늘/,
    apply: (m, q, now) => {
      if (q.day) return false;
      const offset =
        m[0] === "글피" ? 3 : m[0] === "모레" ? 2 : m[0] === "내일" ? 1 : 0;
      q.day = dayText(plus(now, offset));
      return true;
    },
  },
  // Korean explicit month & day (12월 3일)
  {
    re: /(\d{1,2})\s*월\s*(\d{1,2})\s*일/,
    apply: (m, q, now) => {
      if (q.day) return false;
      const month = Number(m[1]);
      const date = Number(m[2]);
      if (month < 1 || month > 12 || date < 1 || date > 31) return false;
      let year = now.getFullYear();
      let d = new Date(year, month - 1, date);
      if (d.getMonth() !== month - 1 || d.getDate() !== date) return false;
      const startOfToday = new Date(year, now.getMonth(), now.getDate());
      if (d < startOfToday) {
        year += 1;
        d = new Date(year, month - 1, date);
        if (d.getMonth() !== month - 1 || d.getDate() !== date) return false;
      }
      q.day = dayText(d);
      return true;
    },
  },
  // Korean weekday (다음 주 월요일, 이번 주 금요일, 수요일)
  {
    re: /(다음\s*주|이번\s*주)?\s*([월화수목금토일])요일/,
    apply: (m, q, now) => {
      if (q.day) return false;
      const w = WEEKDAY[m[2]];
      const isNext = Boolean(m[1] && /^다음/.test(m[1]));
      q.day = dayText(isNext ? nextWeek(now, w) : coming(now, w));
      return true;
    },
  },
  // Korean time with colon & meridiem (오후 3:30, 오전 9:15)
  {
    re: /(오전|오후|아침|낮|저녁|밤)\s*(\d{1,2}):(\d{2})/,
    apply: (m, q) => {
      if (q.time) return false;
      const h = applyMeridiem(Number(m[2]), m[1]);
      const min = Number(m[3]);
      if (h === null || min < 0 || min > 59) return false;
      q.time = `${pad(h)}:${pad(min)}`;
      return true;
    },
  },
  // Korean time with 시/분/반 (오후 3시, 아침 8시 30분, 저녁 8시 반, 9시)
  {
    re: /(오늘\s*밤|오전|오후|아침|낮|저녁|밤)?\s*(\d{1,2})\s*시(?:\s*(\d{1,2})\s*분|\s*(반))?/,
    apply: (m, q, now) => {
      if (q.time) return false;
      const h = applyMeridiem(Number(m[2]), m[1]);
      if (h === null) return false;
      const min = m[4] ? 30 : m[3] ? Number(m[3]) : 0;
      if (min < 0 || min > 59) return false;
      if (m[1] && /^오늘/.test(m[1]) && !q.day) q.day = dayText(now);
      q.time = `${pad(h)}:${pad(min)}`;
      return true;
    },
  },
];

/** A day and time read by chrono, as a to-do takes them. */
function fromChrono(r: ParsedResult, q: Quick) {
  const c = r.start;
  // "两小时后", "兩小時後", "in 2 hours": the moment itself, its day included.
  const relative =
    /(?:后|以后|之后|後|以後|之後|あと)\s*$|^in\s|later|from now/i.test(
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
      const lead = m[0].length - m[0].trimStart().length;
      const start = m.index! + lead,
        end = m.index! + m[0].trimEnd().length;
      if (end <= start || taken.slice(start, end).some(Boolean)) continue;
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
    .sort(
      (a, b) =>
        a.index - b.index || b.text.trim().length - a.text.trim().length,
    );
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
  // "明天下午3点前交报告" / "明日午後3時までにレポート提出" / "내일 오후 3시까지 보고서 제출":
  // deadline/time particles right after a matched span go with it.
  for (const [, end] of [...q.spans]) {
    const after =
      /^(?:之前|以前|前(?![端面台后後途景])|までに|まで|に(?=\s|$|\p{Script=Hiragana}|\p{Script=Katakana}|\p{Script=Han})|까지|\s*전에(?=\s|$)|에(?=\s|$))/u.exec(
        text.slice(end),
      );
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
