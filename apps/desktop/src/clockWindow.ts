// The 番茄钟 clock's own window (focus_clock.rs places it beside the pet).
// It follows the skin and the theme like the bubble; with 系统原生 the
// window itself wears the system's glass (window_material.rs). It rests as
// a thin glowing bar and lets clicks through; with the pointer on the pet
// (the pet window says so) or on the bar it opens into the clock, and over
// the clock it shows pause and stop. Opening and closing change the
// window's own size (focus_clock_peek), so the glass grows with it. The
// shell's cursor tracker tells where the pointer is, since a window that
// is not in front cannot see it.
import { invoke } from "@tauri-apps/api/core";
import { emitTo, listen } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { native } from "./bridge.ts";
import { focusCommand, focusState, onFocus } from "./focus.ts";
import { mountClock } from "./focusClock.ts";
import { watchWindowAppearance } from "./skin.ts";

/** How long the pointer rests on the pet before the clock opens: passing
 *  over it on the way elsewhere does not. */
const OPEN_MS = 130;
/** How long the clock stays after the pointer leaves pet and clock, so it
 *  can travel from one to the other. */
const CLOSE_MS = 240;
/** Room around the resting bar that still counts as on it. */
const BAR_SLACK = 6;

export async function mountClockWindow(app: HTMLElement) {
  const root = document.documentElement;
  root.classList.add("clock-window");
  if (native) await watchWindowAppearance();
  const clock = mountClock(app, {
    home: "window",
    act: (cmd) => void focusCommand(cmd),
  });
  if (!native) {
    clock.peek(true);
    clock.set(await focusState());
    await onFocus((s, moment) => clock.set(s, moment));
    return;
  }

  // Everything inside is sized from the open clock's height, not from the
  // window's, which changes as it opens.
  const sizeFrom = (h: number) =>
    root.style.setProperty("--clock-k", `${h / 10}px`);
  sizeFrom(await invoke<number>("focus_clock_full").catch(() => 38));
  await listen<number>("focus-clock-size", ({ payload }) => sizeFrom(payload));

  const win = getCurrentWindow();
  const mac = /Mac/.test(navigator.platform || navigator.userAgent);
  let [origin, scale] = await Promise.all([
    win.outerPosition(),
    win.scaleFactor(),
  ]);
  void win.onMoved(({ payload }) => (origin = payload));
  void win.onScaleChanged(({ payload }) => (scale = payload.scaleFactor));

  let onPet = false,
    overClock = false,
    onBar = false,
    open = false,
    passThrough: boolean | null = null,
    timer = 0;
  const show = (next: boolean) => {
    if (next !== open) void invoke("focus_clock_peek", { open: next });
    open = next;
    clock.peek(next);
    clock.tools(next && overClock);
    // Resting, the window lets clicks reach whatever is under it.
    if (passThrough !== !next) {
      passThrough = !next;
      void win.setIgnoreCursorEvents(passThrough).catch(() => {});
    }
  };
  const settle = () => {
    const want = onPet || (open ? overClock : onBar);
    clearTimeout(timer);
    if (want !== open)
      timer = window.setTimeout(() => show(want), want ? OPEN_MS : CLOSE_MS);
  };
  show(false);

  // Cursor as the tracker sends it: points on macOS, physical pixels on
  // Windows (file_transfer/tracker.rs), as for the pet (petPointer.ts).
  await listen<{ x: number; y: number }>("pet-cursor", ({ payload: p }) => {
    const x = mac ? p.x - origin.x / scale : (p.x - origin.x) / scale;
    const y = mac ? p.y - origin.y / scale : (p.y - origin.y) / scale;
    overClock = x >= 0 && y >= 0 && x < innerWidth && y < innerHeight;
    // Resting, the window is the bar: a little room around it counts too.
    onBar =
      x >= -BAR_SLACK &&
      y >= -BAR_SLACK &&
      x < innerWidth + BAR_SLACK &&
      y < innerHeight + BAR_SLACK;
    clock.tools(open && overClock);
    settle();
  });
  await listen<boolean>("focus-clock-peek", ({ payload }) => {
    onPet = payload;
    settle();
  });
  // The pet's hue for the light (系统原生 skin), unless turned off in the
  // timer's settings; none keeps the accent.
  let colors: Record<string, string> | null = null,
    follow = true,
    tinted: string[] = [];
  const paintTint = () => {
    const use = follow ? colors : null;
    for (const k of tinted) root.style.removeProperty(k);
    tinted = use ? Object.keys(use) : [];
    for (const k of tinted) root.style.setProperty(k, use![k]);
    root.toggleAttribute("data-pet-tint", !!use);
  };
  await listen<Record<string, string> | null>(
    "focus-clock-tint",
    ({ payload }) => {
      colors = payload;
      paintTint();
    },
  );

  const first = await focusState();
  follow = first.settings.petTint !== false;
  clock.set(first);
  await onFocus((s, moment) => {
    if (follow !== (s.settings.petTint !== false)) {
      follow = !follow;
      paintTint();
    }
    // A timer that ends leaves the bar for the next one.
    if (s.phase === "idle") {
      clearTimeout(timer);
      onPet = false;
      show(false);
    }
    clock.set(s, moment);
  });
  // The pet window answers with its hue and whether it is hovered.
  void emitTo("pet", "focus-clock-hello").catch(() => {});
}
