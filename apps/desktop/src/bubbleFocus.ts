// 番茄钟 in the bubble (plan/19): when a tomato is done or a break is over,
// the pet asks what comes next. Under what the bubble shows, or the whole
// bubble when it opened just for this.
import {
  focusChoices,
  focusCommand,
  focusState,
  onFocus,
  type FocusCommand,
} from "./focus.ts";
import { t, type Key } from "./i18n.ts";
import { focusTodoLine } from "./todo/bubble.ts";

/** What the host asks about: a tomato done (while away, or not), a break
 *  over, or a short heads-up when an auto step already moved on. */
export type FocusAsk =
  | "done"
  | "done-away"
  | "rested"
  | "auto-break"
  | "auto-next";

/** How long a non-blocking auto-step heads-up stays before closing. */
const AUTO_NOTE_MS = 8_000;

const DONE_LINES: Key[] = [
  "focus.done",
  "focus.done2",
  "focus.done3",
  "focus.done4",
];
const RESTED_LINES: Key[] = [
  "focus.rested",
  "focus.rested2",
  "focus.rested3",
  "focus.rested4",
];
const pickLine = (lines: Key[]) =>
  lines[Math.floor(Math.random() * lines.length)];

export function bubbleFocus(
  el: HTMLElement,
  o: { card: HTMLElement; hide(): void; arm?: () => void },
) {
  const text = el.querySelector<HTMLElement>("[data-focus-text]")!;
  const choices = el.querySelector<HTMLElement>("[data-focus-choices]")!;
  // 待办 (plan/27): the to-do the tomato was on, and whether it is done.
  const todoLine = el.querySelector<HTMLElement>("[data-focus-todo]")!;
  let timer = 0;
  let waiting: "done" | "rested" | null = null;
  const setWaiting = (phase: "done" | "rested" | null) => {
    waiting = phase;
    o.card.toggleAttribute("data-focus-waiting", phase !== null);
  };
  const clear = () => {
    clearTimeout(timer);
    setWaiting(null);
    el.hidden = true;
  };
  const done = () => {
    const alone = o.card.dataset.state === "focus";
    clear();
    if (alone) o.hide();
    else o.arm?.();
  };
  // If the user explicitly moved the timer on from the clock or pet menu
  // while the confirmation bubble is open, dismiss the stale prompt.
  void onFocus((s) => {
    if (waiting && s.phase !== waiting) done();
  });
  async function sync() {
    const s = await focusState();
    if (s.phase === "done" || s.phase === "rested") {
      if (waiting !== s.phase || el.hidden) await ask(s.phase);
    } else if (waiting) {
      done();
    }
  }
  async function ask(asked: FocusAsk) {
    const s = await focusState();
    clearTimeout(timer);
    if (asked === "auto-break" || asked === "auto-next") {
      setWaiting(null);
      text.textContent =
        asked === "auto-break"
          ? t("focus.autoBreakNote", {
              n: s.longBreak
                ? s.settings.longBreakMinutes
                : s.settings.breakMinutes,
            })
          : t("focus.autoNextNote");
      choices.innerHTML = "";
      choices.hidden = true;
      todoLine.hidden = true;
      el.hidden = false;
      timer = window.setTimeout(done, AUTO_NOTE_MS);
      return;
    }
    const phase = asked === "rested" ? "rested" : "done",
      away = asked === "done-away";
    setWaiting(phase);
    const long = s.round > 0 && s.round % s.settings.longEvery === 0;
    text.textContent =
      phase === "rested"
        ? t(pickLine(RESTED_LINES))
        : long
          ? t("focus.doneLong", {
              round: s.round,
              n: s.settings.longBreakMinutes,
            })
          : t(away ? "focus.doneAway" : pickLine(DONE_LINES), {
              n: s.settings.breakMinutes,
            });
    // The host may have moved on since; ask about the phase it asked about.
    choices.innerHTML = focusChoices({ ...s, phase, pausedLeft: null })
      .map(
        ([cmd, label]) =>
          `<button type="button" data-focus-act="${cmd}">${t(label)}</button>`,
      )
      .join("");
    choices.hidden = false;
    if (phase === "done") void focusTodoLine(todoLine);
    else todoLine.hidden = true;
    el.hidden = false;
  }
  choices.onclick = (e) => {
    const cmd = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-focus-act]",
    )?.dataset.focusAct;
    if (!cmd) return;
    done();
    void focusCommand(cmd as FocusCommand);
  };
  return {
    ask,
    sync,
    clear,
    any: () => !el.hidden,
    waiting: () => waiting !== null && !el.hidden,
  };
}
