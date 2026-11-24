// ?clock-preview=focus&size=160&skin=native&theme=night&peek&open: the
// example pet with its lamp light and, above it, its clock as the clock
// window shows it (the same size rule as focus_clock.rs), on a wallpaper so
// the glass has something behind it. It rests as the bar and opens with the
// pointer on the pet (`peek` keeps it open; `open` adds the buttons), in the
// pet's hue (`tint=0` for the accent). For screenshots and judging the look.
import "../styles/demo.css";
import "../styles/focus-light.css";
import * as api from "../bridge.ts";
import { previewFocus, type FocusPhase } from "../focus.ts";
import { headOf, mountClock } from "../focusClock.ts";
import { mountFocusLight } from "../petFocus.ts";
import { petTint, tintColors } from "../petTint.ts";
import { SpritePlayer } from "../player.ts";
import { applySkin, normalizeSkin } from "../skin.ts";

export async function mountClockPreview(
  app: HTMLElement,
  route: URLSearchParams,
) {
  const root = document.documentElement;
  root.dataset.theme = route.get("theme") === "night" ? "night" : "day";
  if (route.get("platform")) root.dataset.platform = route.get("platform")!;
  await applySkin(normalizeSkin(route.get("skin")));
  const size = Number(route.get("size") ?? 160);
  const h = Math.round(Math.min(46, Math.max(30, size * 0.2))),
    w = Math.round(h * 3.4);
  app.className = "clock-preview";
  app.innerHTML = `<div class="clock-preview-window" style="width:${w}px;height:${h}px;--k:${h / 10}px;--bar-w:${Math.round(h * 1.7)}px;--bar-h:${Math.max(8, Math.round(h * 0.29))}px"><div class="clock-preview-glass"></div></div><div class="clock-preview-pet" style="width:${size}px;height:${(size * 208) / 192}px"><canvas></canvas></div>`;
  const box = app.querySelector<HTMLElement>(".clock-preview-pet")!;
  const player = new SpritePlayer(box.querySelector("canvas")!);
  await player.load(await api.sprite(""));
  const head = headOf(player.shape);
  // The window sits just above the head, as focus_clock.rs places it.
  const win = app.querySelector<HTMLElement>(".clock-preview-window")!;
  win.style.marginBottom = `${-h}px`;
  win.style.translate = `0 ${head.top * box.offsetHeight - 4 - h}px`;
  const phase = (route.get("clock-preview") || "focus") as FocusPhase;
  const glass = win.querySelector<HTMLElement>(".clock-preview-glass")!;
  const clock = mountClock(glass, { home: "window", act: () => {} });
  const peek = (open: boolean) => {
    clock.peek(open);
    win.toggleAttribute("data-peek", open);
  };
  const light = mountFocusLight(box);
  const now = Date.now();
  const state = previewFocus({
    phase,
    length: 25 * 60_000,
    endsAt: now + (route.has("last") ? 42_000 : 17 * 60_000 + 42_000),
    round: Number(route.get("round") ?? 1),
    pausedLeft: route.has("paused") ? 9 * 60_000 : null,
  });
  const moment = route.has("cheer") ? "Finished" : null;
  clock.set(state, moment);
  light(state, moment, head.top);
  const found =
    route.get("tint") !== "0" && player.image ? petTint(player.image) : null;
  if (found) {
    for (const [k, v] of Object.entries(tintColors(found)))
      root.style.setProperty(k, v);
    root.toggleAttribute("data-pet-tint", true);
  }
  const keep = route.has("peek") || route.has("open");
  peek(keep);
  if (route.has("open"))
    win.querySelector(".focus-clock")!.setAttribute("data-open", "");
  // As the clock window does: open after a short rest on the pet, close
  // a moment after the pointer leaves pet and clock.
  let timer = 0;
  const hover = (on: boolean) => {
    clearTimeout(timer);
    timer = window.setTimeout(() => peek(on || keep), on ? 130 : 240);
  };
  for (const el of [box, win]) {
    el.addEventListener("pointerenter", () => hover(true));
    el.addEventListener("pointerleave", () => hover(false));
  }
  win.addEventListener("pointerenter", () => clock.tools(true));
  win.addEventListener("pointerleave", () => clock.tools(false));
  player.play(
    phase === "focus" ? "running" : phase === "done" ? "jumping" : "idle",
    phase !== "focus",
  );
}
