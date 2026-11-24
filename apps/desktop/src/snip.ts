import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import "./snip.css";
import { native } from "./bridge.ts";
import { applySkin, type Skin, watchWindowAppearance } from "./skin.ts";
export function mountSnip(root: HTMLElement, generation: number) {
  document.documentElement.classList.add("snip-window");
  if (native) void watchWindowAppearance();
  else
    Object.assign(window, {
      __studio: {
        snip: async (skin: Skin, theme: string) => {
          await applySkin(skin);
          document.documentElement.dataset.theme = theme;
        },
      },
    });
  root.innerHTML = `<main class="snip-surface"><span>${t("snip.hint")}<button type="button" class="snip-full" data-full>${t("snip.full")}</button></span><i hidden><b class="c tl"></b><b class="c tr"></b><b class="c bl"></b><b class="c br"></b><em class="snip-size"></em></i></main>`;
  const surface = root.querySelector<HTMLElement>("main")!,
    box = surface.querySelector("i")!,
    full = surface.querySelector<HTMLButtonElement>("[data-full]")!;
  // The button sits on the surface; its press must not start a selection.
  full.onpointerdown = (e) => e.stopPropagation();
  full.onclick = () => {
    if (native)
      void invoke("finish_snip", {
        generation,
        region: { left: 0, top: 0, right: 1, bottom: 1 },
      }).catch(() => {});
  };
  let start: { x: number; y: number } | null = null;
  const point = (e: PointerEvent) => ({
    x: Math.max(0, Math.min(innerWidth, e.clientX)),
    y: Math.max(0, Math.min(innerHeight, e.clientY)),
  });
  function region(p: { x: number; y: number }) {
    return {
      left: Math.min(start!.x, p.x) / innerWidth,
      top: Math.min(start!.y, p.y) / innerHeight,
      right: Math.max(start!.x, p.x) / innerWidth,
      bottom: Math.max(start!.y, p.y) / innerHeight,
    };
  }
  const cancel = () => {
    start = null;
    box.hidden = true;
    delete surface.dataset.selecting;
    if (native) void invoke("cancel_snip", { generation });
  };
  surface.onpointerdown = (e) => {
    if (e.button !== 0) return;
    start = point(e);
    surface.setPointerCapture(e.pointerId);
    box.hidden = true;
  };
  surface.onpointermove = (e) => {
    if (!start) return;
    const r = region(point(e));
    box.hidden = false;
    surface.dataset.selecting = "true";
    box.querySelector("em")!.textContent =
      `${Math.round((r.right - r.left) * innerWidth)} × ${Math.round((r.bottom - r.top) * innerHeight)}`;
    Object.assign(box.style, {
      left: r.left * 100 + "%",
      top: r.top * 100 + "%",
      width: (r.right - r.left) * 100 + "%",
      height: (r.bottom - r.top) * 100 + "%",
    });
  };
  surface.onpointerup = (e) => {
    if (!start) return;
    const r = region(point(e));
    start = null;
    // A click or a sliver (under 3 points either way) is not a selection.
    if (
      (r.right - r.left) * innerWidth < 3 ||
      (r.bottom - r.top) * innerHeight < 3
    ) {
      box.hidden = true;
      delete surface.dataset.selecting;
      return;
    }
    if (native)
      void invoke("finish_snip", { generation, region: r }).catch(() => {});
  };
  surface.onpointercancel = cancel;
  window.onkeydown = (e) => {
    if (e.key === "Escape") cancel();
  };
}
