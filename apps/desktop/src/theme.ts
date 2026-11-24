import { t } from "./i18n.ts";
import { decay } from "./spring.ts";

export type ThemeMode = "system" | "day" | "night" | "clock";
export type Theme = "day" | "night";
export const THEME_MODES: { mode: ThemeMode; label: string }[] = [
  { mode: "system", label: t("theme.system") },
  { mode: "day", label: t("theme.day") },
  { mode: "night", label: t("theme.night") },
  { mode: "clock", label: t("theme.clock") },
];
/** Night between 19:00 and 07:00 when following the clock. */
export function resolveTheme(
  mode: ThemeMode,
  systemDark: boolean,
  now = new Date(),
): Theme {
  if (mode === "day" || mode === "night") return mode;
  if (mode === "clock") {
    const h = now.getHours();
    return h >= 19 || h < 7 ? "night" : "day";
  }
  return systemDark ? "night" : "day";
}

export interface Lights {
  /** Panels lit by the room lights, in switching order. */
  zones: HTMLElement[];
  /** The display window, lit by its own lamp. */
  stage: HTMLElement;
  /** Spotlight brightness, 0–1. */
  lamp: (value: number) => void;
}
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const reduced = () => matchMedia("(prefers-reduced-motion: reduce)").matches;
const dim = (zone: HTMLElement) => (v: number) =>
  zone.style.setProperty("--dim", v.toFixed(3));

/** Keep the room's darkness off the display window inside a panel. */
function spare(zone: HTMLElement, stage: HTMLElement, on: boolean) {
  if (!on || !zone.contains(stage)) {
    zone.style.removeProperty("--hole");
    return;
  }
  const z = zone.getBoundingClientRect(),
    r = stage.getBoundingClientRect();
  const [x1, y1, x2, y2] = [
    r.left - z.left,
    r.top - z.top,
    r.right - z.left,
    r.bottom - z.top,
  ].map((v) => `${Math.round(v)}px`);
  zone.style.setProperty(
    "--hole",
    `polygon(evenodd, 0 0, 100% 0, 100% 100%, 0 100%, 0 0, ${x1} ${y1}, ${x1} ${y2}, ${x2} ${y2}, ${x2} ${y1}, ${x1} ${y1})`,
  );
}

let current: Theme | null = null;
let switching: Promise<void> = Promise.resolve();
/**
 * Day → night: the room lights go out zone by zone, a beat of darkness,
 * then the spotlight's filament strikes (dim, a flicker, full) and spill
 * light reaches the panels one after another, nearest first.
 * Night → day: everything goes dark, then the ceiling tubes flicker on
 * zone by zone.
 */
export function applyTheme(theme: Theme, lights: Lights) {
  if (theme === current) return switching;
  const first = current === null;
  current = theme;
  const root = document.documentElement;
  if (first || reduced()) {
    root.dataset.theme = theme;
    lights.lamp(1);
    return switching;
  }
  // 系统原生: the whole window crossfades, as macOS does; the room lights
  // below belong to 精密玩具.
  if (root.dataset.skin === "native") {
    const swap = () => {
      root.dataset.theme = theme;
      lights.lamp(1);
    };
    const doc = document as Document & {
      startViewTransition?: (update: () => void) => unknown;
    };
    switching = switching.then(() => {
      if (doc.startViewTransition) doc.startViewTransition(swap);
      else swap();
    });
    return switching;
  }
  const { zones, stage, lamp } = lights;
  switching = switching.then(async () => {
    if (theme === "night") {
      for (const z of zones) {
        await decay(0, 0.94, 0.025, dim(z));
        await wait(40);
      }
      root.dataset.theme = "night";
      lamp(0);
      for (const z of zones) spare(z, stage, true);
      await wait(180);
      await decay(0, 0.45, 0.03, lamp);
      lamp(0.2);
      await wait(50);
      await decay(0.2, 1, 0.07, lamp);
      // Spill reaches the panel holding the stage first, then the others.
      const order = [...zones].sort(
        (a, b) => Number(b.contains(stage)) - Number(a.contains(stage)),
      );
      await Promise.all(
        order.map(async (z, i) => {
          await wait(i * 140);
          await decay(0.94, 0, 0.22, dim(z));
          spare(z, stage, false);
        }),
      );
    } else {
      await Promise.all([
        decay(1, 0, 0.04, lamp),
        ...zones.map((z) => decay(0, 0.94, 0.04, dim(z))),
      ]);
      root.dataset.theme = "day";
      lamp(1);
      await wait(120);
      await Promise.all(
        zones.map(async (z, i) => {
          await wait(i * 90);
          const d = dim(z);
          d(0.5);
          await wait(35);
          d(0.94);
          await wait(60);
          await decay(0.94, 0, 0.08, d);
        }),
      );
    }
  });
  return switching;
}
