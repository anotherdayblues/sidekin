import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import "./snip.css";
import { native } from "./bridge.ts";
import { applySkin, type Skin, watchWindowAppearance } from "./skin.ts";

export type SnipMode = "card" | "chat";

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** Clamp a translated selection box inside [0, width] x [0, height], keeping its exact size. */
export function moveBox(
  box: Box,
  dx: number,
  dy: number,
  width: number,
  height: number,
): Box {
  const w = box.right - box.left;
  const h = box.bottom - box.top;
  const left = Math.max(0, Math.min(width - w, box.left + dx));
  const top = Math.max(0, Math.min(height - h, box.top + dy));
  return { left, top, right: left + w, bottom: top + h };
}

export function mountSnip(
  root: HTMLElement,
  generation: number,
  mode: SnipMode = "card",
) {
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
  const hint = mode === "chat" ? t("snip.hintChat") : t("snip.hint");
  root.innerHTML = `<main class="snip-surface"><div class="snip-guide-x" aria-hidden="true"></div><div class="snip-guide-y" aria-hidden="true"></div><span>${hint}<button type="button" class="snip-full" data-full>${t("snip.full")}</button></span><i hidden><b class="c tl"></b><b class="c tr"></b><b class="c bl"></b><b class="c br"></b><em class="snip-size"></em></i></main>`;
  const surface = root.querySelector<HTMLElement>("main")!,
    guideX = surface.querySelector<HTMLElement>(".snip-guide-x")!,
    guideY = surface.querySelector<HTMLElement>(".snip-guide-y")!,
    hintBar = surface.querySelector<HTMLElement>(":scope > span")!,
    box = surface.querySelector("i")!,
    sizeBadge = box.querySelector<HTMLElement>("em")!,
    full = surface.querySelector<HTMLButtonElement>("[data-full]")!;
  // The button sits on the surface; its press must not start a selection.
  full.onpointerdown = (e) => e.stopPropagation();
  hintBar.onpointerenter = () => {
    surface.dataset.overHint = "true";
  };
  hintBar.onpointerleave = () => {
    delete surface.dataset.overHint;
  };
  full.onclick = () => {
    if (native)
      void invoke("finish_snip", {
        generation,
        region: { left: 0, top: 0, right: 1, bottom: 1 },
      }).catch(() => {});
  };
  let start: { x: number; y: number } | null = null;
  let current: { x: number; y: number } | null = null;
  let spaceHeld = false;
  let lastPan: { x: number; y: number } | null = null;
  const clampPoint = (e: PointerEvent) => ({
    x: Math.max(0, Math.min(innerWidth, e.clientX)),
    y: Math.max(0, Math.min(innerHeight, e.clientY)),
  });
  function activeBox(): Box {
    const a = start!;
    const b = current!;
    return {
      left: Math.min(a.x, b.x),
      top: Math.min(a.y, b.y),
      right: Math.max(a.x, b.x),
      bottom: Math.max(a.y, b.y),
    };
  }
  function normalized(b: Box) {
    return {
      left: b.left / innerWidth,
      top: b.top / innerHeight,
      right: b.right / innerWidth,
      bottom: b.bottom / innerHeight,
    };
  }
  function paintBox(b: Box) {
    const w = b.right - b.left;
    const h = b.bottom - b.top;
    box.hidden = false;
    surface.dataset.selecting = "true";
    sizeBadge.textContent = `${Math.round(w)} × ${Math.round(h)}`;
    // Flip size badge inside the box when near the bottom edge so it is never clipped off-screen.
    if (innerHeight - b.bottom < 40) sizeBadge.dataset.inside = "true";
    else delete sizeBadge.dataset.inside;
    Object.assign(box.style, {
      left: (b.left / innerWidth) * 100 + "%",
      top: (b.top / innerHeight) * 100 + "%",
      width: (w / innerWidth) * 100 + "%",
      height: (h / innerHeight) * 100 + "%",
    });
  }
  const cancel = () => {
    start = null;
    current = null;
    spaceHeld = false;
    lastPan = null;
    box.hidden = true;
    delete surface.dataset.selecting;
    if (native) void invoke("cancel_snip", { generation });
  };
  surface.oncontextmenu = (e) => {
    e.preventDefault();
    cancel();
  };
  surface.onpointerdown = (e) => {
    if (e.button === 2) {
      e.preventDefault();
      cancel();
      return;
    }
    if (e.button !== 0) return;
    start = clampPoint(e);
    current = start;
    spaceHeld = false;
    lastPan = null;
    surface.setPointerCapture(e.pointerId);
    box.hidden = true;
  };
  surface.onpointermove = (e) => {
    const p = clampPoint(e);
    if (!start) {
      surface.dataset.aiming = "true";
      guideX.style.transform = `translate3d(0, ${p.y}px, 0)`;
      guideY.style.transform = `translate3d(${p.x}px, 0, 0)`;
      return;
    }
    if (spaceHeld && lastPan && current) {
      const moved = moveBox(
        activeBox(),
        p.x - lastPan.x,
        p.y - lastPan.y,
        innerWidth,
        innerHeight,
      );
      const sx = start.x <= current.x;
      const sy = start.y <= current.y;
      start = {
        x: sx ? moved.left : moved.right,
        y: sy ? moved.top : moved.bottom,
      };
      current = {
        x: sx ? moved.right : moved.left,
        y: sy ? moved.bottom : moved.top,
      };
      lastPan = p;
      paintBox(moved);
      return;
    }
    current = p;
    paintBox(activeBox());
  };
  surface.onpointerup = (e) => {
    if (!start) return;
    if (!spaceHeld) current = clampPoint(e);
    const b = activeBox();
    start = null;
    current = null;
    spaceHeld = false;
    lastPan = null;
    // A click or a sliver (under 3 points either way) is not a selection.
    if (b.right - b.left < 3 || b.bottom - b.top < 3) {
      box.hidden = true;
      delete surface.dataset.selecting;
      return;
    }
    if (native)
      void invoke("finish_snip", {
        generation,
        region: normalized(b),
      }).catch(() => {});
  };
  surface.onpointercancel = cancel;
  window.onkeydown = (e) => {
    if (e.key === "Escape") {
      cancel();
      return;
    }
    if (e.code === "Space" && start && current) {
      e.preventDefault();
      if (!spaceHeld) {
        spaceHeld = true;
        lastPan = current;
      }
    }
  };
  window.onkeyup = (e) => {
    if (e.code === "Space") {
      spaceHeld = false;
      lastPan = null;
    }
  };
}
