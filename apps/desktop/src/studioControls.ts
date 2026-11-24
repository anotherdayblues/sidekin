import { Motion } from "./spring.ts";
import type { StudioContext } from "./studioContext.ts";

export function mountStudioControls(c: StudioContext, closePop: () => void) {
  const { $, state, save } = c;
  // ---------- switches and knob ----------
  function bindSwitch(id: string, change: (checked: boolean) => void) {
    const input = $<HTMLInputElement>(id);
    // Preserve dragging on the physical controls. A plain click or Space uses
    // the checkbox's native activation and accessibility behavior.
    let startX = 0;
    input.onpointerdown = (event) => {
      startX = event.clientX;
      input.setPointerCapture(event.pointerId);
    };
    input.onclick = (event) => {
      if (event.detail && Math.abs(event.clientX - startX) > 3) {
        const rect = input.getBoundingClientRect();
        input.checked = event.clientX > rect.left + rect.width / 2;
      }
    };
    input.onchange = () => change(input.checked);
    return input;
  }
  const desk = bindSwitch("#desk", (visible) => save({ visible }));
  const motionSwitch = bindSwitch("#motion", (playing) =>
    save({ paused: !playing }),
  );

  /**
   * Rotary knob with a detent every 20. Drag in any direction (right or up
   * turns it up), scroll over it, or click its left or right half for one
   * step. Arrow keys work when it has focus.
   */
  const knob = $("#size");
  // 系统原生 shows a plain slider in place of the knob; both set the size.
  const sizeRange = $<HTMLInputElement>("#size-range");
  const knobCap = knob.querySelector<HTMLElement>(".knob-cap")!;
  const toAngle = (v: number) => -135 + ((v - 80) / 200) * 270;
  const knobMotion = new Motion(
    160,
    (v) => {
      knobCap.style.transform = `rotate(${toAngle(v)}deg)`;
      $("#size-value").textContent = `${Math.round(v / 20) * 20}px`;
      sizeRange.value = String(Math.round(v / 20) * 20);
    },
    { stiffness: 700, damping: 32 },
  );
  let knobDrag: { x: number; y: number; from: number; moved: boolean } | null =
    null;
  let sizeTimer: ReturnType<typeof setTimeout> | undefined;
  const settleKnob = (value: number) => {
    const v = Math.max(80, Math.min(280, Math.round(value / 20) * 20));
    knobMotion.to(v);
    knob.setAttribute("aria-valuenow", String(v));
    // Resizing the desktop pet once the knob rests, not on every notch.
    clearTimeout(sizeTimer);
    sizeTimer = setTimeout(() => {
      if (v !== state.snapshot.settings.size) save({ size: v });
    }, 250);
  };
  sizeRange.oninput = () => settleKnob(Number(sizeRange.value));
  knob.addEventListener("pointerdown", (e) => {
    // Keep the browser from starting a text selection next to the knob.
    e.preventDefault();
    knob.focus();
    knob.setPointerCapture(e.pointerId);
    document.body.classList.add("turning");
    knobDrag = {
      x: e.clientX,
      y: e.clientY,
      from: knobMotion.value,
      moved: false,
    };
  });
  knob.addEventListener("pointermove", (e) => {
    if (!knobDrag) return;
    const dx = e.clientX - knobDrag.x,
      dy = e.clientY - knobDrag.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) knobDrag.moved = true;
    if (!knobDrag.moved) return;
    const raw = knobDrag.from + (dx - dy) * 1.2;
    const clamped = Math.max(80, Math.min(280, raw));
    // Between detents the knob feels pulled toward the nearest notch.
    const notch = Math.round(clamped / 20) * 20;
    knobMotion.set(notch + (clamped - notch) * 0.55);
  });
  const endKnob = (e: PointerEvent) => {
    if (!knobDrag) return;
    const drag = knobDrag;
    knobDrag = null;
    document.body.classList.remove("turning");
    if (drag.moved) return settleKnob(knobMotion.value);
    // A plain click: one notch toward the side that was clicked.
    const r = knob.getBoundingClientRect();
    if (e.type === "pointerup")
      settleKnob(
        knobMotion.spring.target +
          (e.clientX < r.left + r.width / 2 ? -20 : 20),
      );
  };
  knob.addEventListener("pointerup", endKnob);
  knob.addEventListener("pointercancel", endKnob);
  let wheel = 0;
  knob.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      // Trackpads send many small deltas; one notch per 40 px of scroll.
      wheel += e.deltaX - e.deltaY;
      const steps = Math.trunc(wheel / 40);
      if (steps) {
        wheel -= steps * 40;
        settleKnob(knobMotion.spring.target + steps * 20);
      }
    },
    { passive: false },
  );
  knob.addEventListener("keydown", (e) => {
    const step = {
      ArrowUp: 20,
      ArrowRight: 20,
      ArrowDown: -20,
      ArrowLeft: -20,
    }[e.key];
    if (step) {
      e.preventDefault();
      settleKnob(knobMotion.spring.target + step);
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") closePop();
  });

  return {
    desk,
    motionSwitch,
    knob,
    knobMotion,
  };
}
