import test from "node:test";
import assert from "node:assert/strict";
import { parseSchedule } from "../../apps/brain/src/scheduleString.ts";
test("一次性延时和重复间隔有不同的执行次数", () => {
  for (const [input, seconds] of [
    ["in 20s", 20],
    ["in 1 hour", 3600],
    ["in 30m", 1800],
    ["in 2h", 7200],
  ] as const)
    assert.deepEqual(parseSchedule(input), {
      kind: "once",
      after_seconds: seconds,
    });
  for (const [input, seconds] of [
    ["30m", 1800],
    ["every 2h", 7200],
    ["every hour", 3600],
  ] as const)
    assert.deepEqual(parseSchedule(input), { kind: "interval", seconds });
});
test("日历日程保留明确时区，绝对时刻保留同一瞬间", () => {
  const daily = { kind: "daily", hour: 9, minute: 0, zone: "Asia/Shanghai" };
  for (const s of ["every day at 9am Asia/Shanghai", "0 9 * * * Asia/Shanghai"])
    assert.deepEqual(parseSchedule(s), daily);
  assert.deepEqual(parseSchedule("every monday 12am"), {
    kind: "weekly",
    hour: 0,
    minute: 0,
    weekdays: [1],
    zone: "local",
  });
  assert.deepEqual(parseSchedule("weekdays at 12pm"), {
    kind: "weekly",
    hour: 12,
    minute: 0,
    weekdays: [1, 2, 3, 4, 5],
    zone: "local",
  });
  assert.deepEqual(parseSchedule("2027-01-01T12:00:00+08:00"), {
    kind: "once",
    at: "2027-01-01T04:00:00.000Z",
  });
  for (const s of [
    "in 0s",
    "in -1h",
    "every day at 25:99",
    "20 nonsense",
    "0 9 * * 3-1",
    "every day at 9am Invalid/Zone",
  ])
    assert.throws(() => parseSchedule(s));
});
