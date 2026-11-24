// The desktop pet during a tomato (plan/19 §9): while it runs the pet plays
// its 专心工作 action and keeps quiet, and a soft light pools at its feet
// like a desk lamp. Nothing is put on the pet itself. Its clock has a window
// of its own (focus_clock.rs); this window tells the host where the head is.
// The one-off reactions (jump, droop, wave) can be replaced by actions the
// user taught for 开始专注, 完成一个 and 开始休息 (teaching-contract.json).
import "./styles/focus-light.css";
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import type { PetShape } from "./animation.ts";
import { native } from "./bridge.ts";
import { burst } from "./confetti.ts";
import {
  focusState,
  onFocus,
  type FocusMoment,
  type FocusState,
} from "./focus.ts";
import { headOf } from "./focusClock.ts";
import { ambience, chime } from "./focusSound.ts";
import { petTint, tintColors } from "./petTint.ts";
import type { PetEvent } from "./teaching.ts";

/** What the pet does at each moment, and the taught event that replaces it. */
const REACTIONS: Partial<
  Record<NonNullable<FocusMoment>, [PetEvent | null, string | null]>
> = {
  Started: ["focus-start", null],
  Finished: ["focus-done", "jumping"],
  GaveUp: [null, "failed"],
  Paused: [null, "waiting"],
  BreakStarted: ["break-start", null],
  BreakOver: [null, "waving"],
};

/** The light at the pet's feet: on while a timer runs, a ring on a finish. */
export function mountFocusLight(host: HTMLElement) {
  const el = document.createElement("div");
  el.className = "focus-light";
  el.dataset.phase = "idle";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = `<i class="focus-pool"></i><i class="focus-ring"></i>`;
  host.prepend(el);
  return (s: FocusState, moment: FocusMoment, head = 0.3) => {
    el.dataset.phase = s.phase;
    el.toggleAttribute("data-paused", s.pausedLeft !== null);
    // The lamp clicks on at a start; restarting the animation needs a frame.
    if (moment === "Started") {
      delete el.dataset.lit;
      requestAnimationFrame(() => (el.dataset.lit = ""));
    }
    if (moment === "Finished") {
      el.dataset.cheer = "";
      window.setTimeout(() => delete el.dataset.cheer, 1400);
      // The confetti's canvas is there only while it flies, so the pet's own
      // canvas stays the only one beside it.
      const confetti = document.createElement("canvas");
      confetti.className = "focus-confetti";
      host.append(confetti);
      burst(confetti, { x: 0.5, y: Math.max(0.12, head) });
      window.setTimeout(() => confetti.remove(), 1800);
    }
  };
}

export async function petFocus(
  root: HTMLElement,
  pet: {
    /** The action the pet goes back to while nothing else plays; null for idle. */
    setBase(action: string | null): void;
    shape(): PetShape | null;
    /** The decoded sheet, for the clock to take the pet's hue from. */
    image(): HTMLImageElement | null;
    /** Runs the taught rule for `event` if there is one, else plays `action`. */
    react(event: PetEvent | null, action: string | null): void;
  },
) {
  const light = mountFocusLight(root);
  let head = headOf(pet.shape());
  const tell = () =>
    native && void invoke("focus_clock_head", head).catch(() => {});
  tell();
  // The clock's own window opens while the pointer rests on the pet and
  // takes the pet's hue. Both are sent again when the clock window starts.
  let hovered = false;
  let colors: Record<string, string> | null = null;
  const tint = () => {
    const image = pet.image();
    const found = image ? petTint(image) : null;
    colors = found && tintColors(found);
  };
  const toClock = (event: string, payload: unknown) =>
    native && void emitTo("clock", event, payload).catch(() => {});
  const sendTint = () => toClock("focus-clock-tint", colors);
  tint();
  root.addEventListener("pet-shape", (e) => {
    head = headOf((e as CustomEvent<PetShape | null>).detail);
    tell();
    tint();
    sendTint();
  });
  root.addEventListener("pet-hover", (e) => {
    hovered = (e as CustomEvent<boolean>).detail;
    toClock("focus-clock-peek", hovered);
  });
  if (native)
    void listen("focus-clock-hello", () => {
      sendTint();
      toClock("focus-clock-peek", hovered);
    }).catch(() => {});
  let state: FocusState = await focusState();
  const background = ambience();
  const apply = () => {
    const working = state.phase === "focus" && state.pausedLeft === null;
    const resting = state.phase === "break" && state.pausedLeft === null;
    const waiting = state.phase === "rested";
    pet.setBase(
      working ? "running" : resting ? "sleep" : waiting ? "waiting" : null,
    );
    // The background sound only while a tomato runs.
    background.set(
      working ? state.settings.ambient : "",
      state.settings.volume,
    );
  };
  light(state, null);
  apply();
  await onFocus((next, moment) => {
    state = next;
    light(next, moment, head.top);
    if (next.settings.chime) {
      if (moment === "Finished") chime(next.settings.volume, "done");
      else if (moment === "BreakOver") chime(next.settings.volume, "rested");
    }
    const reaction = moment && REACTIONS[moment];
    if (reaction) pet.react(...reaction);
    apply();
  });
  return { state: () => state };
}
