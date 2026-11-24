// Tell the desktop pet where to look while you type: the text caret in the
// bubble, chat panel, clipboard search, or to-do inputs. Positions go out in
// screen points, taken from the window's real position (window.screenX is not
// reliable in these webviews).
import { isTauri } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

export type CaretField = HTMLTextAreaElement | HTMLInputElement;

const clamp = (v: number, min: number, max: number) =>
  Math.min(max, Math.max(min, v));

/** The rendered caret position in a textarea or single-line input, in window CSS pixels. */
export function caretPoint(input: CaretField) {
  const style = getComputedStyle(input);
  const box = input.getBoundingClientRect();
  const singleLine = input instanceof HTMLInputElement;
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "fixed",
    left: "0",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    width: singleLine ? "auto" : style.width,
    minWidth: singleLine ? style.width : "",
    boxSizing: style.boxSizing,
    border: style.border,
    padding: style.padding,
    font: style.font,
    letterSpacing: style.letterSpacing,
    wordSpacing: style.wordSpacing,
    lineHeight: style.lineHeight,
    whiteSpace: singleLine ? "pre" : style.whiteSpace,
    overflowWrap: singleLine ? "normal" : style.overflowWrap,
    wordBreak: singleLine ? "normal" : style.wordBreak,
    textAlign: style.textAlign,
    textIndent: style.textIndent,
    textTransform: style.textTransform,
    direction: style.direction,
    tabSize: style.tabSize,
  });
  const end =
    input.selectionDirection === "backward"
      ? input.selectionStart
      : input.selectionEnd;
  mirror.textContent = input.value.slice(0, end ?? input.value.length);
  const marker = document.createElement("span");
  marker.textContent = "\u200b";
  mirror.append(marker);
  document.body.append(mirror);
  const origin = mirror.getBoundingClientRect();
  const caret = marker.getBoundingClientRect();
  mirror.remove();
  const scaleX = input.offsetWidth ? box.width / input.offsetWidth : 1;
  const scaleY = input.offsetHeight ? box.height / input.offsetHeight : 1;
  const rawX = box.left + (caret.left - origin.left - input.scrollLeft) * scaleX;
  const rawY = singleLine
    ? box.top + box.height / 2
    : box.top +
      (caret.top - origin.top + caret.height / 2 - input.scrollTop) * scaleY;
  return {
    x: clamp(rawX, box.left, box.right),
    y: clamp(rawY, box.top, box.bottom),
  };
}

let generation = 0;
let windowBlurBound = false;

export function clearLook() {
  generation++;
  if (!isTauri()) return;
  void emit("bubble-look-clear", getCurrentWindow().label).catch(() => {});
}

export async function lookAt(point: { x: number; y: number }, typing: boolean) {
  const current = ++generation;
  if (!isTauri()) return;
  const win = getCurrentWindow();
  const [pos, scale] = await Promise.all([
    win.outerPosition(),
    win.scaleFactor(),
  ]);
  if (current !== generation || document.hidden) return;
  await emit("bubble-look", {
    source: win.label,
    x: pos.x / scale + point.x,
    y: pos.y / scale + point.y,
    typing,
  });
}

/** Keep the pet looking at this field's caret while you type in it. */
export function watchCaret(input: CaretField) {
  if (!windowBlurBound) {
    windowBlurBound = true;
    window.addEventListener("blur", clearLook);
  }
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (
        document.activeElement === input &&
        document.hasFocus() &&
        input.getClientRects().length
      )
        void lookAt(caretPoint(input), true).catch(() => {});
    });
  };
  input.addEventListener("blur", clearLook);
  for (const ev of [
    "input",
    "compositionupdate",
    "keyup",
    "click",
    "focus",
    "scroll",
  ])
    input.addEventListener(ev, update);
}
