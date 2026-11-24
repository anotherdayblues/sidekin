import { t } from "./i18n.ts";
import { Motion } from "./spring.ts";
import {
  applyTheme,
  resolveTheme,
  THEME_MODES,
  type ThemeMode,
} from "./theme.ts";
import { normalizeSkin } from "./skin.ts";
import { petLight } from "./petLight.ts";
import type { StudioContext } from "./studioContext.ts";

export function mountStudioLighting(
  c: StudioContext,
  shadowTo: (value: number) => void,
) {
  const { $, state, player, darkQuery, save, lcd } = c;
  const windowEl = $("#window");
  // ---------- theme ----------
  function themeMode(): ThemeMode {
    return (state.snapshot.settings.theme as ThemeMode) ?? "system";
  }
  const lights = {
    zones: [$(".rail"), $(".side"), $(".deck")],
    stage: $("#window"),
    lamp: (v: number) =>
      document.documentElement.style.setProperty("--lamp", v.toFixed(3)),
  };
  const rimCanvas = Object.assign(document.createElement("canvas"), {
    width: 384,
    height: 416,
  });
  // The brand mark is a two-tone disc that flips over with the theme.
  const brand = new Motion(
    0,
    (v) => ($(".brand-mark").style.transform = `rotate(${v * 180}deg)`),
    { stiffness: 220, damping: 18 },
  );
  /** Edge pixels facing a light: the pet minus itself shifted toward it. */
  function rimFrom(
    ctx: CanvasRenderingContext2D,
    dx: number,
    dy: number,
    color: string,
  ) {
    const rim = rimCanvas.getContext("2d")!;
    rim.globalCompositeOperation = "copy";
    rim.drawImage(ctx.canvas, 0, 0);
    rim.globalCompositeOperation = "destination-out";
    rim.drawImage(ctx.canvas, dx, dy);
    rim.globalCompositeOperation = "source-in";
    rim.fillStyle = color;
    rim.fillRect(0, 0, 384, 416);
  }
  /**
   * Where the afternoon sun is. Before noon it comes in from the right and
   * lands on the left of the back wall; after noon the other way round.
   * Low sun (morning, evening) is warmer and throws longer shadows.
   */
  let sunHour: number | null = null; // browser preview only
  function sun(now = new Date()) {
    const hour = sunHour ?? now.getHours() + now.getMinutes() / 60;
    const t = Math.max(0, Math.min(1, (hour - 7) / 12));
    const from = (0.5 - t) * 2; // +1 from the right, -1 from the left
    return { t, from, low: Math.abs(from) };
  }
  function syncTheme() {
    const theme = resolveTheme(themeMode(), darkQuery.matches);
    const s = sun();
    const side = s.from >= 0 ? 1 : -1;
    windowEl.style.setProperty("--sun-x", `${22 + s.t * 56}%`);
    windowEl.style.setProperty("--sun-skew", `${s.from * 22}deg`);
    windowEl.style.setProperty("--sun-warm", s.low.toFixed(2));
    // Night: lit from above by the lamp, warm on head and back, the paws
    // falling into shadow. Day: the sun from the window side, a warm edge
    // on the lit flank and a slightly cooler shade on the other.
    // Each skin picks its own colors (petLight.ts); skins without one leave
    // the pet unlit.
    const l = petLight(
      normalizeSkin(state.snapshot.settings.skin),
      theme,
      s.low,
    );
    player.light = !l
      ? null
      : theme === "night"
        ? (ctx) => {
            rimFrom(ctx, 0, 6, l.rim);
            const g = ctx.createLinearGradient(0, 40, 0, 416);
            g.addColorStop(0, l.top);
            g.addColorStop(0.55, l.mid);
            g.addColorStop(1, l.base);
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, 384, 416);
            ctx.globalCompositeOperation = "lighter";
            ctx.globalAlpha = l.glow;
            ctx.drawImage(rimCanvas, 0, 0);
          }
        : (ctx) => {
            rimFrom(ctx, -4 * side, 3, l.rim);
            const lit = side > 0 ? 384 : 0;
            const g = ctx.createLinearGradient(lit, 60, 384 - lit, 416);
            g.addColorStop(0, l.top);
            g.addColorStop(0.6, l.mid);
            g.addColorStop(1, l.base);
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, 384, 416);
            ctx.globalCompositeOperation = "lighter";
            ctx.globalAlpha = l.glow;
            ctx.drawImage(rimCanvas, 0, 0);
          };
    player.repaint();
    // By day the shadow falls away from the sun, longer when it is low.
    if (theme === "day") shadowTo(-side * (8 + 14 * s.low));
    // System mode shows both halves side by side.
    brand.to(
      themeMode() === "system" || themeMode() === "clock"
        ? 0.5
        : theme === "night"
          ? 1
          : 0,
    );
    applyTheme(theme, lights);
  }
  darkQuery.addEventListener("change", syncTheme);
  setInterval(syncTheme, 60_000);

  // Chosen from the appearance key's menu (studioThemeMenu.ts).
  function pickTheme(mode: ThemeMode) {
    if (mode === themeMode()) return;
    save({ theme: mode }).then(
      (ok) =>
        ok &&
        lcd(
          t("studio.themeTitle", {
            mode: THEME_MODES.find((m) => m.mode === mode)!.label,
          }),
          2500,
        ),
    );
  }

  return {
    themeMode,
    pickTheme,
    lights,
    syncTheme,
    setSunHour(hour: number) {
      sunHour = hour;
      syncTheme();
    },
  };
}
