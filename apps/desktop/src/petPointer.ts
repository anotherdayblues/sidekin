import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { tipsUsed } from "./tips.ts";
import type { Menu } from "@tauri-apps/api/menu";
import { petDragPosition } from "./petDragPosition.ts";
import { GAZE, GAZE_ACTIONS, GazeAttention } from "./animation.ts";
import { resolveGazeAnchor } from "./openpets/runtime.ts";
import type { CodexPetGazeAnchor } from "./openpets/vendor/codex-pets-core.ts";
import type { SpritePlayer } from "./player.ts";
import type { DragMotion } from "./movement.ts";
interface PointerContext {
  canvas: HTMLCanvasElement;
  player: SpritePlayer;
  drag: DragMotion;
  visible: () => boolean;
  paused: () => boolean;
  clickOnly: () => boolean;
  gaze: () => {
    bubbleAt: { x: number; y: number } | null;
    gazeUntil: number;
  };
  gazeAnchor?: () => CodexPetGazeAnchor | undefined;
  hovered: () => boolean;
  sync: () => void;
  touch: () => void;
  input: () => void;
  hover: (inside: boolean) => void;
  begin: () => void;
  release: (clicked: boolean, moved: boolean, wake: boolean) => void;
  double: () => void;
  menu: () => Promise<Menu>;
}
/** How often the page re-checks a cursor that sits still: near the pet its
 * pose changes under it; far away only slow things (attention, the bubble
 * gaze running out) do. No call to the shell is made for these checks. */
export const POINTER_PACE = { near: 50, far: 250 };
/** Margin around the window inside which the cursor counts as near. */
const NEAR_MARGIN = 24;
/** The window's place and scale are pushed on move; this catches a missed
 * one. */
const FRAME_REFRESH = 10_000;
export function petPointer(c: PointerContext) {
  const { canvas, player, drag } = c,
    win = getCurrentWindow(),
    positionDrag = petDragPosition();
  const attention = new GazeAttention(),
    mac = /Mac/.test(navigator.platform || navigator.userAgent);
  // The cursor as the shell's tracker sends it: points on macOS, physical
  // pixels on Windows (file_transfer/tracker.rs).
  let cursor: { x: number; y: number } | null = null,
    origin = { x: 0, y: 0 },
    scale = 1,
    frameAt = 0,
    ignoring = false,
    cursorFar = false,
    near: boolean | null = null,
    running = false,
    again = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let press: {
    id: number;
    grabX: number;
    grabY: number;
    wake: boolean;
  } | null = null;
  const stop = () => clearTimeout(timer);
  void listen<{ x: number; y: number }>("pet-cursor", ({ payload }) => {
    if (cursor && payload.x === cursor.x && payload.y === cursor.y) return;
    cursor = payload;
    c.input();
    if (c.visible()) void check();
  }).catch(() => {});
  void win
    .onMoved(({ payload }) => {
      origin = payload;
    })
    .catch(() => {});
  void win
    .onScaleChanged(({ payload }) => {
      scale = payload.scaleFactor;
    })
    .catch(() => {});
  async function refreshFrame() {
    const [o, s] = await Promise.all([win.outerPosition(), win.scaleFactor()]);
    origin = o;
    scale = s;
    frameAt = Date.now();
  }
  /** Starts checking: called when the pet shows or its state changes. */
  async function poll() {
    stop();
    if (!c.visible()) return;
    try {
      const [x, y] = await invoke<[number, number]>("lab_cursor");
      if (!cursor || cursor.x !== x || cursor.y !== y) cursor = { x, y };
      await refreshFrame();
    } catch (e) {
      console.warn("cursor", e);
    }
    await check();
  }
  // One check at a time; a push that lands during one runs right after it.
  async function check() {
    if (running) {
      again = true;
      return;
    }
    running = true;
    try {
      do {
        again = false;
        await evaluate();
      } while (again && c.visible());
    } finally {
      running = false;
    }
  }
  async function evaluate() {
    stop();
    if (!c.visible() || !cursor) return;
    let fileGesture = false;
    try {
      if (Date.now() - frameAt > FRAME_REFRESH) await refreshFrame();
      const pos = cursor;
      const rect = canvas.getBoundingClientRect();
      const x =
        (mac ? pos.x - origin.x / scale : (pos.x - origin.x) / scale) -
        rect.left;
      const y =
        (mac ? pos.y - origin.y / scale : (pos.y - origin.y) / scale) -
        rect.top;
      const inside =
        x >= 0 &&
        y >= 0 &&
        x < rect.width &&
        y < rect.height &&
        (c.clickOnly()
          ? player.hit(x / rect.width, y / rect.height)
          : (player.shape?.hit(x / rect.width, y / rect.height, c.hovered()) ??
            true));
      const combined = document.documentElement.dataset.petScene === "true";
      const target = combined
        ? document.elementFromPoint(x + rect.left, y + rect.top)
        : null;
      const fileHit =
        target instanceof Element &&
        Boolean(target.closest(".pile-top,.file-panel,.remove"));
      fileGesture =
        combined &&
        Boolean(
          document.body.dataset.filePressed ||
          document.body.dataset.dragging ||
          document.documentElement.dataset.fileDragging === "true",
        );
      // The original current-frame hit test owns pet interaction, including
      // sleeping poses. Merge file controls here; no other writer toggles it.
      const ignore = !(inside || press || fileHit || fileGesture);
      if (ignore !== ignoring) {
        ignoring = ignore;
        await win.setIgnoreCursorEvents(ignore);
      }
      if (!drag.active)
        c.hover(
          inside && document.documentElement.dataset.fileDragging !== "true",
        );
      const anchor = resolveGazeAnchor(
        rect,
        c.gazeAnchor?.(),
        player.flipped,
      );
      const gx = x - anchor.x,
        gy = y - anchor.y,
        look = attention.update(Date.now(), gx, gy);
      cursorFar = Math.hypot(gx, gy) > GAZE.far && !attention.awake;
      const inWindow =
        x + rect.left >= -NEAR_MARGIN &&
        y + rect.top >= -NEAR_MARGIN &&
        x + rect.left <= innerWidth + NEAR_MARGIN &&
        y + rect.top <= innerHeight + NEAR_MARGIN;
      const nowNear = inWindow || !cursorFar;
      if (nowNear !== near) {
        near = nowNear;
        void invoke("lab_cursor_near", { near }).catch(() => {});
      }
      const { bubbleAt, gazeUntil } = c.gaze();
      const toBubble = bubbleAt
        ? {
            x: bubbleAt.x - origin.x / scale - rect.left - anchor.x,
            y: bubbleAt.y - origin.y / scale - rect.top - anchor.y,
          }
        : null;
      const watch = bubbleAt && Date.now() < gazeUntil;
      player.setGaze(
        watch
          ? toBubble
          : GAZE_ACTIONS.includes(player.requestedAction)
            ? look
            : null,
      );
    } catch (e) {
      console.warn("cursor", e);
    }
    const busy = press || drag.active || fileGesture;
    timer = setTimeout(
      check,
      busy || (near && !c.paused()) ? POINTER_PACE.near : POINTER_PACE.far,
    );
  }
  canvas.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || e.ctrlKey) return;
    e.preventDefault();
    const rect = canvas.getBoundingClientRect();
    if (
      c.clickOnly() &&
      !player.hit(
        (e.clientX - rect.left) / rect.width,
        (e.clientY - rect.top) / rect.height,
      )
    )
      return;
    c.touch();
    const wake = c.clickOnly() || player.endSustained();
    canvas.setPointerCapture(e.pointerId);
    press = {
      id: e.pointerId,
      wake,
      grabX: e.clientX - rect.left,
      grabY: e.clientY - rect.top,
    };
    drag.begin(e.screenX, e.screenY);
    if (!wake) c.begin();
  });
  canvas.addEventListener("pointermove", (e) => {
    if (!press || e.pointerId !== press.id) return;
    drag.moved(e.screenX, e.screenY);
    c.sync();
    if (drag.hasMoved) void positionDrag(press.grabX, press.grabY, false);
  });
  /** After a drag the host has moved the window, and a move event may not
   * come for that: read the window's place again and judge the cursor
   * there, or the next press would pass through to the app below. */
  const afterDrag = (moving: Promise<void>) =>
    void moving.then(() => {
      frameAt = 0;
      return check();
    });
  function release(e: PointerEvent, clicked: boolean) {
    if (!press || e.pointerId !== press.id) return;
    if (clicked) drag.moved(e.screenX, e.screenY);
    const wake = press.wake,
      moved = drag.end();
    c.touch();
    if (c.clickOnly()) {
      if (clicked && !moved) player.endSustained();
      press = null;
      if (canvas.hasPointerCapture(e.pointerId))
        canvas.releasePointerCapture(e.pointerId);
      return;
    }
    if (moved) afterDrag(positionDrag(press.grabX, press.grabY, true));
    press = null;
    if (canvas.hasPointerCapture(e.pointerId))
      canvas.releasePointerCapture(e.pointerId);
    c.release(clicked, moved, wake);
  }
  canvas.addEventListener("pointerup", (e) => release(e, true));
  canvas.addEventListener("pointercancel", (e) => release(e, false));
  canvas.addEventListener("lostpointercapture", () => {
    if (!press) return;
    if (drag.end()) afterDrag(positionDrag(press.grabX, press.grabY, true));
    press = null;
    c.release(false, false, false);
  });
  canvas.addEventListener("pointerleave", () => {
    if (!drag.active) c.hover(false);
  });
  canvas.addEventListener("contextmenu", async (e) => {
    e.preventDefault();
    c.touch();
    tipsUsed("menu");
    (await c.menu())
      .popup(new LogicalPosition(e.clientX, e.clientY), win)
      .catch(console.error);
  });
  canvas.addEventListener("dblclick", () => {
    if (c.clickOnly()) return;
    attention.wake(Date.now());
    c.double();
  });
  return { poll, stop };
}
