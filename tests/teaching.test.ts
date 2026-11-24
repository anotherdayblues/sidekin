import assert from "node:assert/strict";
import test from "node:test";
import {
  ActivityTracker,
  RuleClock,
  describeRule,
  lastClockInstant,
  type Rule,
} from "../apps/desktop/src/teaching.ts";
import {
  RandomBehavior,
  normalizeBehavior,
  stepPlan,
  clipPlan,
} from "../apps/desktop/src/animation.ts";

const MIN = 60_000;
const at = (h: number, m = 0, day = 4) =>
  new Date(2026, 10, day, h, m).getTime();
const rule = (when: Rule["when"], extra: Partial<Rule> = {}): Rule => ({
  id: "r",
  label: "测试",
  when,
  do: [{ play: "waving" }],
  ...extra,
});
const calm = { idleMs: 0, activeMs: 0 };

test("daily clock fires once inside its window and catches up after sleep", () => {
  const c = new RuleClock([rule({ type: "clock", at: "23:00" })], {}, at(8));
  assert.equal(c.due(at(22, 59), calm), null);
  assert.equal(c.due(at(23, 10), calm)?.id, "r");
  assert.equal(c.due(at(23, 20), calm), null, "only once per day");
  assert.equal(c.due(at(23, 40), calm), null);
  // Computer asleep at 23:00 the next day, awake at 23:25: still inside 30 min.
  assert.equal(c.due(at(23, 25, 5), calm)?.id, "r");
  // Past the window the reminder is skipped instead of firing late.
  assert.equal(c.due(at(23, 45, 6), calm), null);
});

test("hourly clock uses * for the hour", () => {
  assert.equal(
    lastClockInstant("*:00", new Date(at(14, 35))).getTime(),
    at(14, 0),
  );
  assert.equal(
    lastClockInstant("23:00", new Date(at(1, 0))).getTime(),
    at(23, 0, 3),
  );
  const c = new RuleClock([rule({ type: "clock", at: "*:00" })], {}, at(8));
  assert.ok(c.due(at(9, 1), calm));
  assert.equal(c.due(at(9, 30), calm), null);
  assert.ok(c.due(at(10, 2), calm));
});

test("weekday filter and chance are rolled once per occurrence", () => {
  const weekend = new RuleClock(
    [rule({ type: "clock", at: "09:00", days: [0, 6] })],
    {},
    at(0),
  );
  assert.equal(weekend.due(at(9, 5, 4), calm), null, "Wednesday");
  assert.ok(weekend.due(at(9, 5, 7), calm), "Saturday");
  const unlucky = new RuleClock(
    [rule({ type: "clock", at: "09:00" }, { chance: 0.3 })],
    {},
    at(0),
    () => 0.9,
  );
  assert.equal(unlucky.due(at(9, 1), calm), null);
  assert.equal(
    unlucky.memory.r,
    at(9, 1),
    "a miss still counts as today's turn",
  );
});

test("every, idle and active triggers", () => {
  const every = new RuleClock([rule({ type: "every", minutes: 60 })], {}, 0);
  assert.equal(every.due(59 * MIN, calm), null);
  assert.ok(every.due(60 * MIN, calm));
  assert.equal(every.due(100 * MIN, calm), null);
  assert.ok(every.due(120 * MIN, calm));

  const idle = new RuleClock([rule({ type: "idle", minutes: 10 })], {}, 0);
  assert.equal(idle.due(100 * MIN, { idleMs: 9 * MIN, activeMs: 0 }), null);
  assert.ok(idle.due(100 * MIN, { idleMs: 10 * MIN, activeMs: 0 }));
  assert.equal(idle.due(105 * MIN, { idleMs: 15 * MIN, activeMs: 0 }), null);

  const tracker = new ActivityTracker(),
    active = new RuleClock([rule({ type: "active", minutes: 60 })], {}, 0);
  for (let t = 0; t <= 62; t++) {
    const use = tracker.update(t * MIN, 10_000);
    const hit = active.due(t * MIN, use);
    assert.equal(!!hit, t === 60, `minute ${t}`);
  }
  // A break of five minutes or more restarts the count.
  tracker.update(70 * MIN, 6 * MIN);
  assert.equal(tracker.update(71 * MIN, 0).activeMs, 0);
});

test("event rules replace defaults and respect cooldown", () => {
  const c = new RuleClock(
    [rule({ type: "event", event: "click" }, { cooldownMinutes: 1 })],
    {},
    0,
  );
  assert.ok(c.find("click"));
  assert.equal(c.find("drop"), undefined);
  assert.ok(c.event("click", 0));
  assert.equal(c.event("click", 30_000), null);
  assert.ok(c.event("click", 61_000));
  const off = new RuleClock([
    rule({ type: "event", event: "click" }, { enabled: false }),
  ]);
  assert.equal(off.find("click"), undefined);
});

test("random rules make up the random pool, weighted by times an hour", () => {
  const c = new RuleClock([rule({ type: "random", weight: 6 })]);
  const r = new RandomBehavior(() => 0.5),
    b = normalizeBehavior({ weights: { waving: 1 } });
  r.next(0, b, false, c.randomWeights());
  // 6 an hour: about every 10 minutes; base actions never join.
  assert.equal(r.deadline, 600_000);
  assert.equal(r.next(600_000, b, false, c.randomWeights()), "rule:r");
});

test("steps play exact repetitions; taught clicks settle into idle", () => {
  const clip = { durations: [100, 200] };
  const steps = stepPlan("yawn", 3, clip);
  assert.equal(steps.frames.length, 6);
  assert.equal(steps.loopStart, null);
  assert.equal(steps.frames[0].sheet, "yawn");
  assert.equal(stepPlan("waving", 2).frames.length, 8);
  const once = clipPlan("yawn", clip);
  assert.equal(once.loopStart, 2);
  assert.equal(once.frames[2].row, 0);
  assert.equal(once.frames[2].sheet, undefined);
});

test("rules are described in plain words", () => {
  const layer = {
    actions: { pillow: { label: "抱着枕头出来", image: "", durations: [100] } },
    rules: [],
  };
  assert.equal(
    describeRule(
      {
        id: "n",
        label: "晚安",
        when: { type: "clock", at: "23:00" },
        do: [{ play: "pillow" }, { wait: 1500 }, { play: "waving", repeat: 2 }],
        chance: 0.5,
      },
      layer,
    ),
    "每天 23:00 · 50% 的机会：抱着枕头出来 → 停 1.5 秒 → 打招呼 ×2",
  );
  assert.equal(
    describeRule(rule({ type: "event", event: "drag" })),
    "拖动它的时候：打招呼",
  );
  // 番茄钟's moments can be taught too (plan/19 §9.8).
  assert.equal(
    describeRule(rule({ type: "event", event: "focus-done" })),
    "专注完成时：打招呼",
  );
});
