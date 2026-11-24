// The settings key on an action tile (plan/29), opened as a small panel
// beside it. A learned action: when it plays (double-click, at random, a
// time each day), redraw, delete. Sleep: how long untouched before it
// naps. Other base actions have no key. Also the words under the window
// saying when a learned action plays, and the rules taught before.
import { t } from "./i18n.ts";
import {
  doubleOwner,
  oldRules,
  planOf,
  RATES,
  rateOf,
  type Plan,
  type Rate,
} from "./actionPlan.ts";
import { actionLabel, canEditAction, type Layer } from "./teaching.ts";
import { showSkillPrompt } from "./skillPromptPopup.ts";
import { ruleRow } from "./studioDrafts.ts";
import { el } from "./studioDom.ts";
import * as api from "./bridge.ts";
import "./styles/actions.css";
import type { Behavior } from "./animation.ts";
import type { Key } from "./i18n.ts";
import type { StudioContext } from "./studioContext.ts";
import type { mountStudioPopovers } from "./studioPopovers.ts";
import type { mountStudioStage } from "./studioStage.ts";

type Menus = ReturnType<typeof mountStudioPopovers>;
type Stage = ReturnType<typeof mountStudioStage>;

/** One on/off line: a name, maybe a note under it, a switch. */
function switchRow(label: string, on: boolean, change: (on: boolean) => void) {
  const row = el("label", "act-row");
  const name = el("span", "act-name", label);
  const input = el("input", "slide-switch");
  input.type = "checkbox";
  input.setAttribute("role", "switch");
  input.checked = on;
  input.onchange = () => change(input.checked);
  row.append(name, input);
  return { row, input };
}

export function mountActionSettings(
  c: StudioContext,
  menus: Menus,
  stage: Stage,
) {
  const { custom, behavior, lcd, attempt } = c;

  /** For a learned action, what it was given: "双击时、随机（有时）、每天 09:00". */
  function note(name: string, layer: Layer) {
    const plan = planOf(name, layer);
    const parts = [
      plan.double && t("act.planDouble"),
      plan.random &&
        t("act.planRandom", {
          rate: t(`act.rate.${rateOf(plan.random)}` as Key),
        }),
      plan.clock &&
        t(plan.clock.weekdays ? "act.planWeekdays" : "act.planDaily", {
          at: plan.clock.at,
        }),
      oldRules(layer, name).length > 0 && t("act.planOld"),
    ].filter(Boolean);
    return parts.length ? parts.join(t("act.joiner")) : t("act.planNone");
  }

  function saveBehavior(p: api.Pet, patch: Partial<Behavior>) {
    return c.save((s) => ({
      behaviors: {
        ...s.behaviors,
        [p.id]: { ...(s.behaviors[p.id] ?? p.behavior), ...patch },
      },
    }));
  }

  function open(anchor: HTMLElement, content: HTMLElement[]) {
    menus.openPop(anchor, content);
    document.querySelector<HTMLElement>("#pop")!.dataset.kind = "action";
  }

  /** Old rules, each with a try and a ×; empty when there are none. */
  function oldList(p: api.Pet, layer: Layer, name?: string) {
    const rules = oldRules(layer, name);
    if (!rules.length) return [];
    const box = el("div", "act-old");
    box.append(el("p", "act-old-head", t("act.old")));
    for (const rule of rules) {
      const row = ruleRow(rule, layer, () => {
        stage.playSteps(rule.do);
        attempt(() => api.previewOnDesktop({ petId: p.id, steps: rule.do }));
      });
      const x = el("button", "forget-key pop-anchor", "×");
      x.setAttribute("aria-label", t("studio.dropRule", { label: rule.label }));
      x.title = t("studio.dropThisRule");
      x.onclick = () => menus.confirmForget(p, x, { rule });
      row.append(x);
      box.append(row);
    }
    return [box];
  }

  function learned(p: api.Pet, name: string, anchor: HTMLElement) {
    const layer = custom(p).layer;
    const label = actionLabel(name, layer);
    let plan: Plan = planOf(name, layer);
    const save = () =>
      attempt(async () => {
        await api.setActionPlan(p.id, name, plan);
        lcd(t("act.saved", { label }), 2500);
      });

    const double = switchRow(t("act.double"), plan.double, (on) => {
      plan = { ...plan, double: on };
      void save();
    });
    const owner = doubleOwner(layer);
    if (owner !== null && owner !== name)
      double.row.append(
        el(
          "small",
          "act-hint",
          owner
            ? t("act.doubleTaken", { label: actionLabel(owner, layer) })
            : t("act.doubleOld"),
        ),
      );
    // Now and then: the switch, then how often under it.
    const random = switchRow(t("act.random"), !!plan.random, (on) => {
      plan = { ...plan, random: on ? RATES[picked] : null };
      rates.hidden = !on;
      void save();
    });
    let picked: Rate = plan.random ? rateOf(plan.random) : "some";
    const rates = el("div", "act-rates");
    rates.setAttribute("role", "group");
    rates.setAttribute("aria-label", t("act.rate"));
    const hint = el("small", "act-hint");
    const keys = (Object.keys(RATES) as Rate[]).map((rate) => {
      const key = el("button", "act-rate", t(`act.rate.${rate}` as Key));
      key.type = "button";
      key.dataset.rate = rate;
      key.onclick = () => {
        picked = rate;
        plan = { ...plan, random: RATES[rate] };
        show();
        void save();
      };
      return key;
    });
    const show = () => {
      for (const k of keys)
        k.setAttribute("aria-pressed", String(k.dataset.rate === picked));
      hint.textContent = t(`act.rateHint.${picked}` as Key);
    };
    show();
    const choices = el("div", "act-rate-keys");
    choices.append(...keys);
    rates.append(choices, hint);
    rates.hidden = !plan.random;

    // A time each day: the switch, then the time and 只在工作日 under it.
    const daily = switchRow(t("act.daily"), !!plan.clock, (on) => {
      plan = {
        ...plan,
        clock: on
          ? { at: time.value || "09:00", weekdays: weekdays.checked }
          : null,
      };
      when.hidden = !on;
      void save();
    });
    const when = el("div", "act-when");
    const time = el("input", "act-time");
    time.type = "time";
    time.value = plan.clock?.at ?? "09:00";
    time.setAttribute("aria-label", t("act.daily"));
    time.onchange = () => {
      if (!time.value || !plan.clock) return;
      plan = { ...plan, clock: { ...plan.clock, at: time.value } };
      void save();
    };
    const wd = el("label", "act-check");
    const weekdays = el("input");
    weekdays.type = "checkbox";
    weekdays.checked = !!plan.clock?.weekdays;
    weekdays.onchange = () => {
      if (!plan.clock) return;
      plan = { ...plan, clock: { ...plan.clock, weekdays: weekdays.checked } };
      void save();
    };
    wd.append(weekdays, document.createTextNode(t("act.weekdaysOnly")));
    when.append(time, wd);
    when.hidden = !plan.clock;

    const foot = el("div", "act-foot");
    if (canEditAction(name, layer)) {
      const redraw = el("button", "text-key pop-anchor", t("act.redraw"));
      redraw.type = "button";
      redraw.onclick = () =>
        showSkillPrompt(
          redraw,
          t("studio.editTitle", { name: p.displayName, label }),
          "teach-desktop-pet",
          t("studio.editAsk", {
            name: p.displayName,
            id: p.id,
            action: name,
            label,
          }),
          t("studio.editHint"),
          menus,
          lcd,
        );
      foot.append(redraw);
    }
    const drop = el("button", "text-key danger pop-anchor", t("act.delete"));
    drop.type = "button";
    drop.onclick = () => menus.confirmForget(p, drop, { action: name });
    foot.append(drop);

    open(anchor, [
      el("strong", "pop-title", label),
      el("p", "act-lead", t("act.ask")),
      double.row,
      random.row,
      rates,
      daily.row,
      when,
      ...oldList(p, layer, name),
      foot,
    ]);
  }

  function sleep(p: api.Pet, anchor: HTMLElement) {
    const row = el("label", "act-row");
    const minutes = el("input", "act-minutes");
    minutes.type = "number";
    minutes.min = "1";
    minutes.max = "1440";
    minutes.step = "1";
    minutes.value = String(behavior(p).napMinutes ?? 10);
    minutes.onchange = () => {
      const n = Math.round(Number(minutes.value));
      if (!(n >= 1 && n <= 1440)) {
        minutes.value = String(behavior(p).napMinutes ?? 10);
        return;
      }
      void saveBehavior(p, { napMinutes: n }).then((ok) => {
        if (ok) lcd(t("act.saved", { label: t("pet.sleep") }), 2500);
      });
    };
    const unit = el("span", "act-unit", t("act.minutes"));
    const field = el("span", "act-field");
    field.append(minutes, unit);
    row.append(el("span", "act-name", t("act.sleepAfter")), field);
    open(anchor, [
      el("strong", "pop-title", t("pet.sleep")),
      el("p", "act-lead", t("act.sleepLead")),
      row,
    ]);
  }

  function old(p: api.Pet, anchor: HTMLElement) {
    const layer = custom(p).layer;
    open(anchor, [
      el("strong", "pop-title", t("act.oldTitle")),
      el("p", "act-lead", t("act.oldLead")),
      ...oldList(p, layer),
    ]);
  }

  return { note, learned, sleep, old };
}
