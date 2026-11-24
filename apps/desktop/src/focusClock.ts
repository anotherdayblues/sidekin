// The 番茄钟 clock (plan/19 §9): a small digital clock in the skin's style,
// a light running slowly round its rim, so it is there when you look and
// quiet when you don't. Two homes: its own window beside the desktop pet
// (clockWindow.ts), and over the pet on the 专注 page. In its window it
// rests as a thin glowing bar, so the digits do not pull at a mind at work:
// how far along shows as a soft fill with a small light at its head. With
// the pointer on the pet it opens into the clock (`peek`), and over the
// clock it shows pause and stop (`tools`). TypeScript sets data-* attributes and the measured spots;
// focus-clock.css draws it.
import "./styles/focus-clock.css";
import type { PetShape } from "./animation.ts";
import {
  clock,
  focusChoices,
  progress,
  roundOf,
  timeLeft,
  type FocusCommand,
  type FocusMoment,
  type FocusState,
} from "./focus.ts";
import { t } from "./i18n.ts";

/** The pet's visible top, and the middle of its head (the top fifth of
 * what is visible, so one ear does not pull the clock aside), as shares of
 * its cell. */
export function headOf(shape: PetShape | null) {
  if (!shape) return { top: 0.3, middle: 0.5 };
  const { width: w, height: h } = shape;
  const row = (y: number) => {
    let left = -1,
      right = -1;
    for (let x = 0; x < w; x++)
      if (shape.hit((x + 0.5) / w, (y + 0.5) / h)) {
        if (left < 0) left = x;
        right = x;
      }
    return { left, right };
  };
  let top = 0;
  while (top < h && row(top).left < 0) top++;
  if (top >= h) return { top: 0.3, middle: 0.5 };
  let bottom = top;
  while (bottom < h && row(bottom).left >= 0) bottom++;
  let left = w,
    right = 0;
  for (let y = top; y < top + Math.max(1, (bottom - top) / 5); y++) {
    const r = row(y);
    if (r.left < 0) continue;
    left = Math.min(left, r.left);
    right = Math.max(right, r.right);
  }
  return { top: top / h, middle: (left + right + 1) / 2 / w };
}

/** Which round of the set, as dots: the finished ones full, the running
 *  one marked. For the clock and the 专注 page. */
export function roundDots(s: FocusState) {
  if (s.phase === "idle") return "";
  const { k, n } = roundOf(s);
  const done = s.phase === "focus" ? k - 1 : k;
  return Array.from(
    { length: n },
    (_, i) =>
      `<i${i < done ? " data-done" : ""}${s.phase === "focus" && i === k - 1 ? " data-now" : ""}></i>`,
  ).join("");
}

/** How long the buttons stay after a click with nothing more done. */
const TOOLS_MS = 4000;

export function mountClock(
  host: HTMLElement,
  o: { home: "window" | "page"; act?: (cmd: FocusCommand) => void },
) {
  const el = document.createElement("div");
  el.className = "focus-clock";
  el.dataset.home = o.home;
  el.dataset.phase = "idle";
  el.innerHTML = `<i class="clock-flow"></i><i class="clock-glow"><i class="glow-fill"></i><i class="glow-lane"><i class="glow-orb"></i></i></i><span class="clock-face"><span class="clock-read"><span class="clock-line"><em class="clock-tag" aria-hidden="true">${t("focus.breakBadge")}</em><b class="clock-digits"></b></span><i class="clock-progress"></i><small class="clock-round"></small></span><span class="clock-tools"></span></span>`;
  host.append(el);
  const digits = el.querySelector<HTMLElement>(".clock-digits")!;
  const round = el.querySelector<HTMLElement>(".clock-round")!;
  const bar = el.querySelector<HTMLElement>(".clock-progress")!;
  const tools = el.querySelector<HTMLElement>(".clock-tools")!;
  const glow = el.querySelector<HTMLElement>(".clock-glow")!;
  let state: FocusState | null = null;
  // In its window the clock starts as the bar; on the page it is open.
  let peeked = o.home === "page";
  let glowAt = -1;
  // Resting bar is ~51-78px wide (~102-156 physical px at 2x DPR); stepping at
  // 0.01 (~1 physical pixel) stays visually continuous while avoiding sub-pixel
  // CSS custom-property restyles and 600ms transitions every ~1.5s.
  const RESTING_STEP = 0.01;

  // On the page its size follows the pet's, which is measured, not styled.
  const size = new ResizeObserver(() =>
    el.style.setProperty("--u", `${host.clientWidth / 100}px`),
  );
  if (o.home === "page") size.observe(host);

  const paint = () => {
    if (!state || state.phase === "idle") return;
    const running = state.phase === "focus" || state.phase === "break";
    const p = running ? progress(state) : 1;
    // Resting bar updates once per physical pixel (~0.01); peeked/reset/done update at once.
    if (
      peeked ||
      p < glowAt ||
      Math.abs(p - glowAt) >= RESTING_STEP ||
      (p === 1) !== (glowAt === 1)
    ) {
      glowAt = p;
      glow.style.setProperty("--p", String(p));
    }
    // Closed, the digits are not seen: leave them be.
    if (!peeked) return;
    const text = running
      ? clock(timeLeft(state))
      : state.phase === "done"
        ? "✓"
        : "0:00";
    // Twice a second, but the digits change once: unchanged text is not
    // set again, so nothing is laid out or painted for it.
    if (digits.textContent !== text) digits.textContent = text;
    // On the line itself, so only it is restyled.
    bar.style.setProperty("--p", String(p));
    el.toggleAttribute(
      "data-last",
      running && state.pausedLeft === null && timeLeft(state) < 60_000,
    );
  };
  let timer = 0;
  const syncTimer = () => {
    const active = Boolean(state && state.phase !== "idle");
    if (active && !timer) timer = window.setInterval(paint, 500);
    else if (!active && timer) {
      clearInterval(timer);
      timer = 0;
    }
  };

  // A click shows what can be done now: pause or resume, and stop. The
  // first choice for these phases is what a click on the clock means.
  let hideTools = 0;
  if (o.act) {
    const act = o.act;
    el.onclick = (e) => {
      const cmd = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-focus-act]",
      )?.dataset.focusAct;
      if (cmd) act(cmd as FocusCommand);
      el.toggleAttribute("data-open", !cmd || el.hasAttribute("data-open"));
      clearTimeout(hideTools);
      hideTools = window.setTimeout(
        () => el.removeAttribute("data-open"),
        TOOLS_MS,
      );
    };
  }

  return {
    /** In its window: open into the clock, or rest as the bar. */
    peek(open: boolean) {
      if (open === peeked) return;
      peeked = open;
      el.toggleAttribute("data-peek", open);
      if (!open) el.removeAttribute("data-tools");
      paint();
    },
    /** In its window: show pause and stop while the pointer is over it. */
    tools(on: boolean) {
      el.toggleAttribute("data-tools", on && peeked);
    },
    /** On the page: puts the clock just above the pet's head. */
    place(head: { top: number; middle: number }) {
      el.style.setProperty("--head", String(head.top));
      el.style.setProperty("--middle", String(head.middle));
    },
    set(next: FocusState, moment: FocusMoment = null) {
      state = next;
      el.dataset.phase = next.phase;
      el.toggleAttribute("data-paused", next.pausedLeft !== null);
      round.innerHTML = roundDots(next);
      if (next.phase === "idle") round.removeAttribute("aria-label");
      else round.setAttribute("aria-label", t("focus.round", roundOf(next)));
      const pick = (cmd: FocusCommand) =>
        next.phase === "done"
          ? cmd === "rest" || cmd === "stop"
          : next.phase === "rested"
            ? cmd === "start" || cmd === "stop"
            : cmd !== "start" && cmd !== "rest";
      tools.innerHTML = focusChoices(next)
        .filter(([cmd]) => pick(cmd))
        .map(
          ([cmd, label]) =>
            `<button type="button" class="clock-tool" data-focus-act="${cmd}" aria-label="${t(label)}" title="${t(label)}"></button>`,
        )
        .join("");
      if (moment === "Finished") {
        el.dataset.cheer = "";
        window.setTimeout(() => delete el.dataset.cheer, 900);
      }
      syncTimer();
      paint();
    },
    destroy() {
      clearInterval(timer);
      timer = 0;
      clearTimeout(hideTools);
      size.disconnect();
      el.remove();
    },
  };
}
