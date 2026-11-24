import { t } from "./i18n.ts";
import contract from "../../../skills/teach-desktop-pet/references/teaching-contract.json";
import { ANIMATIONS, type Action } from "./animation.ts";

export interface CustomAction {
  label: string;
  image: string;
  durations: number[];
  /** One-based, inclusive range of the moving hold section. */
  loopFrames?: [number, number];
}
export type Trigger =
  | { type: "clock"; at: string; days?: number[]; windowMinutes?: number }
  | { type: "every"; minutes: number }
  | { type: "random"; weight: number }
  | { type: "event"; event: PetEvent }
  | { type: "pet-idle"; minutes: number; includeDefaultSleep?: boolean }
  | { type: "idle"; minutes: number }
  | { type: "active"; minutes: number };
export type PetEvent = keyof typeof contract.events;
export interface Step {
  play?: string;
  repeat?: number;
  wait?: number;
}
export interface Rule {
  id: string;
  label: string;
  enabled?: boolean;
  when: Trigger;
  do: Step[];
  chance?: number;
  cooldownMinutes?: number;
}
export interface Layer {
  actions: Record<string, CustomAction>;
  rules: Rule[];
}
export const EMPTY_LAYER: Layer = { actions: {}, rules: [] };
/** Which actions can be redrawn (plan/29): every learned one, keeping its
 * timing and loop; base actions only when the contract opens them (none
 * for now); never sleep. Shared with the host and the maker. */
export function canEditAction(name: string, layer: Layer): boolean {
  if (name === "sleep") return false;
  if (name in ANIMATIONS)
    return (contract.redrawableBaseActions as string[]).includes(name);
  return !!layer.actions[name];
}

const MINUTE = 60_000;

export function actionLabel(name: string, layer: Layer = EMPTY_LAYER) {
  return (
    layer.actions[name]?.label ?? ANIMATIONS[name as Action]?.label ?? name
  );
}
const EVENT_WORDS: Record<PetEvent, string> = {
  click: t("rule.click"),
  "double-click": t("rule.doubleClick"),
  hover: t("rule.hover"),
  drag: t("rule.drag"),
  drop: t("rule.drop"),
  appear: t("rule.appear"),
  "focus-start": t("rule.focusStart"),
  "focus-done": t("rule.focusDone"),
  "break-start": t("rule.breakStart"),
};
/** Short words for common day sets: 工作日, 周末, else the days listed. */
function dayWords(days?: number[]) {
  if (!days || days.length >= 7) return "";
  const key = [...days].sort().join("");
  if (key === "12345") return t("rule.weekdays");
  if (key === "06") return t("rule.weekend");
  return t("rule.days", {
    days: days
      .map((d) => t("rule.dayNames").split(",")[d])
      .join(t("reminders.dayJoiner")),
  });
}
/** One plain sentence, the same wording the studio shows before accepting. */
export function describeRule(rule: Rule, layer: Layer = EMPTY_LAYER) {
  const w = rule.when;
  const when =
    w.type === "clock"
      ? (w.at === "*:00"
          ? t("rule.everyHour")
          : w.at.startsWith("*")
            ? t("rule.hourlyAt", { m: Number(w.at.slice(2)) })
            : t("rule.dailyAt", { at: w.at })) + dayWords(w.days)
      : w.type === "every"
        ? t("rule.everyMinutes", { n: w.minutes })
        : w.type === "random"
          ? t("rule.random", { weight: w.weight })
          : w.type === "event"
            ? (EVENT_WORDS[w.event] ?? w.event)
            : w.type === "pet-idle"
              ? t("rule.afterPetIdle", { n: w.minutes })
              : w.type === "idle"
                ? t("rule.afterIdle", { n: w.minutes })
                : t("rule.afterActive", { n: w.minutes });
  const chance =
    rule.chance !== undefined && rule.chance < 1
      ? t("rule.chance", { p: Math.round(rule.chance * 100) })
      : "";
  const steps = rule.do
    .map((s) =>
      s.wait
        ? t("rule.wait", { n: s.wait / 1000 })
        : actionLabel(s.play!, layer) +
          (s.repeat && s.repeat > 1 ? ` ×${s.repeat}` : ""),
    )
    .join(" → ");
  return t("rule.sentence", { when, chance, steps });
}

/** Tracks continuous computer use from the time since the last input. */
export class ActivityTracker {
  private activeSince: number | null = null;
  update(now: number, idleMs: number) {
    if (idleMs >= contract.activityBreakMinutes * MINUTE)
      this.activeSince = null;
    else this.activeSince ??= now - idleMs;
    return {
      idleMs,
      activeMs: this.activeSince === null ? 0 : now - this.activeSince - idleMs,
    };
  }
}

/** Last scheduled instant of a clock trigger at or before `now`. */
export function lastClockInstant(at: string, now: Date): Date {
  const [h, m] = at.split(":");
  const d = new Date(now);
  d.setSeconds(0, 0);
  d.setMinutes(Number(m));
  if (h === "*") {
    if (d > now) d.setHours(d.getHours() - 1);
  } else {
    d.setHours(Number(h));
    if (d > now) d.setDate(d.getDate() - 1);
  }
  return d;
}

/**
 * Decides which rule runs. `memory` holds the last time each rule was
 * considered (fired or skipped by chance) and is saved by the caller.
 */
export class RuleClock {
  constructor(
    public rules: Rule[],
    public memory: Record<string, number> = {},
    private startedAt = Date.now(),
    private random = () => Math.random(),
  ) {}
  private ready(rule: Rule, now: number) {
    const last = this.memory[rule.id];
    return (
      rule.enabled !== false &&
      (last === undefined || now - last >= (rule.cooldownMinutes ?? 0) * MINUTE)
    );
  }
  /** Consider each rule only once per stretch without a direct pet interaction. */
  petIdle(now: number, touchedAt: number) {
    let latest = -1;
    let choices: Rule[] = [];
    for (const rule of this.rules) {
      const w = rule.when;
      if (
        w.type !== "pet-idle" ||
        !this.ready(rule, now) ||
        now - touchedAt < w.minutes * MINUTE ||
        (this.memory[rule.id] ?? -Infinity) >= touchedAt
      )
        continue;
      const eligible = this.take(rule, now);
      if (w.minutes > latest) {
        latest = w.minutes;
        choices = [];
      }
      if (eligible && w.minutes === latest) choices.push(rule);
    }
    return choices.length
      ? choices[Math.floor(this.random() * choices.length)]
      : null;
  }
  /** Marks the rule as considered and rolls its chance. */
  private take(rule: Rule, now: number) {
    this.memory[rule.id] = now;
    return this.random() < (rule.chance ?? 1);
  }
  due(now: number, activity: { idleMs: number; activeMs: number }) {
    for (const rule of this.rules) {
      if (!this.ready(rule, now)) continue;
      const w = rule.when,
        last = this.memory[rule.id] ?? -Infinity;
      let hit = false;
      if (w.type === "clock") {
        const at = lastClockInstant(w.at, new Date(now)).getTime();
        hit =
          last < at &&
          now - at < (w.windowMinutes ?? 30) * MINUTE &&
          (!w.days || w.days.includes(new Date(at).getDay()));
      } else if (w.type === "every")
        hit = now - Math.max(last, this.startedAt) >= w.minutes * MINUTE;
      else if (w.type === "idle")
        hit =
          activity.idleMs >= w.minutes * MINUTE && last < now - activity.idleMs;
      else if (w.type === "active")
        hit =
          activity.activeMs >= w.minutes * MINUTE &&
          last < now - activity.activeMs - activity.idleMs;
      if (hit && this.take(rule, now)) return rule;
    }
    return null;
  }
  event(name: PetEvent, now = Date.now()) {
    const rule = this.find(name);
    return rule && this.ready(rule, now) && this.take(rule, now) ? rule : null;
  }
  /** The enabled rule for an event, regardless of chance or cooldown. */
  find(name: PetEvent) {
    return this.rules.find(
      (r) =>
        r.enabled !== false && r.when.type === "event" && r.when.event === name,
    );
  }
  randomWeights() {
    return Object.fromEntries(
      this.rules
        .filter((r) => r.enabled !== false && r.when.type === "random")
        .map((r) => ["rule:" + r.id, (r.when as { weight: number }).weight]),
    );
  }
  byId(id: string) {
    return this.rules.find((r) => r.id === id) ?? null;
  }
}
