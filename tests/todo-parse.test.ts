// 一行字认出日期、时间和重复 (plan/27).
import assert from "node:assert/strict";
import test from "node:test";
import { loadParser, parseQuick } from "../apps/desktop/src/todo/parse.ts";

await loadParser();

// Monday 16 November 2026, 10:00 local time.
const NOW = new Date(2026, 10, 16, 10, 0);
const p = (s: string) => {
  const { title, day, time, repeat } = parseQuick(s, NOW);
  return { title, day, time, repeat };
};

test("中文：哪天、几点、重复", () => {
  assert.deepEqual(p("明天下午3点交报告"), {
    title: "交报告",
    day: "2026-11-17",
    time: "15:00",
    repeat: undefined,
  });
  assert.deepEqual(p("交报告 后天"), {
    title: "交报告",
    day: "2026-11-18",
    time: undefined,
    repeat: undefined,
  });
  assert.deepEqual(p("周五晚上8点半 看电影"), {
    title: "看电影",
    day: "2026-11-20",
    time: "20:30",
    repeat: undefined,
  });
  assert.deepEqual(p("下周一 9:15 例会"), {
    title: "例会",
    day: "2026-11-23",
    time: "09:15",
    repeat: undefined,
  });
  assert.deepEqual(p("每天9点喝水"), {
    title: "喝水",
    day: "2026-11-16",
    time: "09:00",
    repeat: "daily",
  });
  assert.deepEqual(p("工作日早上八点打卡"), {
    title: "打卡",
    day: "2026-11-16",
    time: "08:00",
    repeat: "weekdays",
  });
  assert.deepEqual(p("每周三交周报"), {
    title: "交周报",
    day: "2026-11-18",
    time: undefined,
    repeat: "weekly",
  });
  assert.deepEqual(p("12月3号还书"), {
    title: "还书",
    day: "2026-12-03",
    time: undefined,
    repeat: undefined,
  });
  assert.deepEqual(
    p("3点开会"),
    { title: "开会", day: "2026-11-16", time: "15:00", repeat: undefined },
    "1–6 点没说上午算下午",
  );
  assert.deepEqual(
    p("明天下午3点前交报告").title,
    "交报告",
    "时间后的“前”一起去掉",
  );
  assert.deepEqual(
    p("明天前端代码评审").title,
    "前端代码评审",
    "“前端”不是“之前”",
  );
  assert.deepEqual(p("今晚十点 洗衣服"), {
    title: "洗衣服",
    day: "2026-11-16",
    time: "22:00",
    repeat: undefined,
  });
});

test("chrono 读得到、我们补上的说法", () => {
  assert.deepEqual(p("三天后交报告"), {
    title: "交报告",
    day: "2026-11-19",
    time: undefined,
    repeat: undefined,
  });
  assert.deepEqual(p("一周后交报告"), {
    title: "交报告",
    day: "2026-11-23",
    time: undefined,
    repeat: undefined,
  });
  assert.deepEqual(p("下个月5号还款"), {
    title: "还款",
    day: "2026-12-05",
    time: undefined,
    repeat: undefined,
  });
  assert.deepEqual(p("两小时后开会"), {
    title: "开会",
    day: "2026-11-16",
    time: "12:00",
    repeat: undefined,
  });
  assert.deepEqual(p("后天上午10点 体检"), {
    title: "体检",
    day: "2026-11-18",
    time: "10:00",
    repeat: undefined,
  });
  assert.deepEqual(p("report in 3 days"), {
    title: "report",
    day: "2026-11-19",
    time: undefined,
    repeat: undefined,
  });
  assert.deepEqual(
    p("明天晚上 看书"),
    {
      title: "看书",
      day: "2026-11-17",
      time: undefined,
      repeat: undefined,
    },
    "只说晚上不猜几点",
  );
});

test("英文", () => {
  assert.deepEqual(p("call mom tomorrow at 3pm"), {
    title: "call mom",
    day: "2026-11-17",
    time: "15:00",
    repeat: undefined,
  });
  assert.deepEqual(p("dentist on friday"), {
    title: "dentist",
    day: "2026-11-20",
    time: undefined,
    repeat: undefined,
  });
  assert.deepEqual(p("stand-up every weekday 9:30"), {
    title: "stand-up",
    day: "2026-11-16",
    time: "09:30",
    repeat: "weekdays",
  });
});

test("没说时间就原样，认出的位置可以高亮", () => {
  assert.deepEqual(p("整理照片"), {
    title: "整理照片",
    day: undefined,
    time: undefined,
    repeat: undefined,
  });
  const q = parseQuick("明天下午3点交报告", NOW);
  assert.deepEqual(q.spans, [[0, 6]]);
  // Only date words: the line itself stays the title.
  assert.equal(parseQuick("明天", NOW).title, "明天");
});
