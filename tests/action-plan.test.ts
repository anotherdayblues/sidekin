// When a learned action plays (plan/29): double-click, at random, a time
// each day. The same reading as the host's teaching_plan.rs.
import assert from "node:assert/strict";
import test from "node:test";
import {
  applyPlan,
  doubleOwner,
  isLearned,
  learnedNames,
  NO_PLAN,
  oldRules,
  planOf,
  RATES,
  rateOf,
} from "../apps/desktop/src/actionPlan.ts";
import type { Layer } from "../apps/desktop/src/teaching.ts";

const action = (label: string) => ({
  label,
  image: "a.png",
  durations: [100, 100, 200],
});
const layer: Layer = {
  actions: {
    spin: action("转圈"),
    yawn: action("打哈欠"),
    sleep: { ...action("打盹"), loopFrames: [2, 3] },
    waving: action("重画过的打招呼"),
  },
  rules: [
    {
      id: "old-click",
      label: "单击转圈",
      when: { type: "event", event: "click" },
      do: [{ play: "spin" }],
    },
    {
      id: "old-morning",
      label: "早上打招呼",
      when: { type: "clock", at: "08:30" },
      do: [{ play: "waving" }],
    },
  ],
};

test("only what the user taught is learned: not base actions, not sleep", () => {
  assert.deepEqual(learnedNames(layer), ["spin", "yawn"]);
  assert.equal(isLearned("waving", layer), false);
  assert.equal(isLearned("sleep", layer), false);
});

test("double-click, random and a daily time are read back as set", () => {
  let l = applyPlan(layer, "spin", {
    double: true,
    random: RATES.some,
    clock: { at: "09:00", weekdays: true },
  });
  assert.deepEqual(planOf("spin", l), {
    double: true,
    random: 20,
    clock: { at: "09:00", weekdays: true },
  });
  assert.equal(doubleOwner(l), "spin");
  // Set again: replaced, never piled up; other rules untouched.
  l = applyPlan(l, "spin", { ...NO_PLAN, random: RATES.often });
  assert.deepEqual(planOf("spin", l), { ...NO_PLAN, random: 40 });
  assert.deepEqual(
    oldRules(l).map((r) => r.id),
    ["old-click", "old-morning"],
  );
});

test("double-click moves to the last learned action given it", () => {
  let l = applyPlan(layer, "spin", { ...NO_PLAN, double: true });
  l = applyPlan(l, "yawn", { ...NO_PLAN, double: true });
  assert.equal(planOf("spin", l).double, false);
  assert.equal(doubleOwner(l), "yawn");
});

test("rules taught in other ways are old: shown apart, only removable", () => {
  assert.deepEqual(planOf("spin", layer), NO_PLAN);
  assert.deepEqual(
    oldRules(layer, "spin").map((r) => r.id),
    ["old-click"],
  );
  // A double-click held by an old rule reads as taken, but by no action.
  const held: Layer = {
    ...layer,
    rules: [
      {
        id: "old-double",
        label: "双击挥手",
        when: { type: "event", event: "double-click" },
        do: [{ play: "spin" }, { play: "waving" }],
      },
    ],
  };
  assert.equal(doubleOwner(held), "");
  assert.equal(doubleOwner(layer), null);
});

test("a rate taught before reads as the nearest of 偶尔、有时、常常", () => {
  assert.equal(rateOf(1.5), "rare");
  assert.equal(rateOf(RATES.rare), "rare");
  assert.equal(rateOf(RATES.some), "some");
  assert.equal(rateOf(RATES.often), "often");
  assert.equal(rateOf(100), "often");
});
