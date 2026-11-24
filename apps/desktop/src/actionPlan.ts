// When a learned action plays (plan/29), read from and written to the
// pet's rules; the same reading as the host's teaching_plan.rs.
// Two kinds of actions, apart from birth:
//   base     the pet's own, each played in fixed situations, never at
//            random or on a schedule; only sleep has a setting (how long
//            untouched before it naps);
//   learned  what the user taught; each can play on a double-click, now
//            and then at random, or at a time each day.
// Rules taught before in other ways ("old" ones) keep running and can only
// be removed.
import { ANIMATIONS } from "./animation.ts";
import type { Layer, Rule } from "./teaching.ts";

export interface Plan {
  double: boolean;
  /** Now and then at random, about this many times an hour. */
  random: number | null;
  clock: { at: string; weekdays: boolean } | null;
}
export const NO_PLAN: Plan = { double: false, random: null, clock: null };
const WEEKDAYS = "1,2,3,4,5";

/** The base actions, in the order the tape shows them. */
export const BASE = [
  "idle",
  "waving",
  "jumping",
  "running",
  "review",
  "waiting",
  "failed",
  "running-right",
  "running-left",
] as const;

/** A learned action: not a base one, and not sleep (every pet has sleep). */
export function isLearned(name: string, layer: Layer) {
  return name !== "sleep" && !(name in ANIMATIONS) && name in layer.actions;
}
export function learnedNames(layer: Layer) {
  return Object.keys(layer.actions).filter((n) => isLearned(n, layer));
}

/** The learned action a plan rule plays, or null when the rule is not one. */
export function planAction(rule: Rule, layer: Layer): string | null {
  if (
    rule.enabled === false ||
    rule.chance !== undefined ||
    rule.cooldownMinutes !== undefined ||
    rule.do.length !== 1
  )
    return null;
  const [step] = rule.do;
  if (
    !step.play ||
    step.wait !== undefined ||
    (step.repeat ?? 1) !== 1 ||
    !isLearned(step.play, layer)
  )
    return null;
  const w = rule.when;
  const ok =
    (w.type === "event" && w.event === "double-click") ||
    w.type === "random" ||
    (w.type === "clock" &&
      !w.at.startsWith("*") &&
      w.windowMinutes === undefined &&
      (!w.days || w.days.join(",") === WEEKDAYS));
  return ok ? step.play : null;
}

export function planOf(name: string, layer: Layer): Plan {
  const plan: Plan = { ...NO_PLAN };
  for (const r of layer.rules) {
    if (planAction(r, layer) !== name) continue;
    const w = r.when;
    if (w.type === "event") plan.double = true;
    else if (w.type === "random") plan.random = w.weight;
    else if (w.type === "clock") plan.clock = { at: w.at, weekdays: !!w.days };
  }
  return plan;
}

/** The learned action on double-click now, if any. */
export function doubleOwner(layer: Layer): string | null {
  for (const r of layer.rules)
    if (r.when.type === "event" && r.when.event === "double-click")
      return planAction(r, layer) ?? "";
  return null;
}

/** Rules taught before plan/29 that the settings cannot show. */
export function oldRules(layer: Layer, name?: string) {
  return layer.rules.filter(
    (r) =>
      planAction(r, layer) === null &&
      (name === undefined || r.do.some((s) => s.play === name)),
  );
}

/** The layer with `name` playing as `plan` says (the browser preview's
 * stand-in for the host's set_action_plan). */
export function applyPlan(layer: Layer, name: string, plan: Plan): Layer {
  const label = layer.actions[name].label;
  let rules = layer.rules.filter((r) => planAction(r, layer) !== name);
  if (plan.double)
    rules = rules.filter(
      (r) => !(r.when.type === "event" && r.when.event === "double-click"),
    );
  const taken = new Set(rules.map((r) => r.id));
  const id = (kind: string) => {
    let out = `${kind}-${name}`;
    for (let n = 2; out.length > 40 || taken.has(out); n++)
      out = `${kind}-${n}`;
    taken.add(out);
    return out;
  };
  const rule = (kind: string, when: Rule["when"]): Rule => ({
    id: id(kind),
    label,
    when,
    do: [{ play: name }],
  });
  if (plan.double)
    rules.push(rule("double", { type: "event", event: "double-click" }));
  if (plan.random)
    rules.push(rule("random", { type: "random", weight: plan.random }));
  if (plan.clock)
    rules.push(
      rule("daily", {
        type: "clock",
        at: plan.clock.at,
        ...(plan.clock.weekdays ? { days: [1, 2, 3, 4, 5] } : {}),
      }),
    );
  return { ...layer, rules };
}

/** How often a random one comes up, in times an hour. */
export const RATES = { rare: 6, some: 20, often: 40 } as const;
export type Rate = keyof typeof RATES;
/** The nearest of the three, for a rate taught or set before. */
export function rateOf(perHour: number): Rate {
  return perHour >= 30 ? "often" : perHour >= 12 ? "some" : "rare";
}
