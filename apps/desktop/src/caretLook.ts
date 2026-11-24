// Tell the desktop pet where to look while you type: the text caret in the
// bubble or the chat panel. Positions go out in screen points, taken from the
// window's real position (window.screenX is not reliable in these webviews).
import { emit } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";

/** The rendered caret position in a textarea, in the window's CSS pixels. */
export function caretPoint(input: HTMLTextAreaElement) {
  const style = getComputedStyle(input);
  const box = input.getBoundingClientRect();
  const mirror = document.createElement("div");
  Object.assign(mirror.style, {
    position: "fixed",
    left: "0",
    top: "0",
    visibility: "hidden",
    pointerEvents: "none",
    width: style.width,
    boxSizing: style.boxSizing,
    border: style.border,
    padding: style.padding,
    font: style.font,
    letterSpacing: style.letterSpacing,
    wordSpacing: style.wordSpacing,
    lineHeight: style.lineHeight,
    whiteSpace: style.whiteSpace,
    overflowWrap: style.overflowWrap,
    wordBreak: style.wordBreak,
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
  return {
    x: box.left + (caret.left - origin.left - input.scrollLeft) * scaleX,
    y:
      box.top +
      (caret.top - origin.top + caret.height / 2 - input.scrollTop) * scaleY,
  };
}

let generation = 0;
export function clearLook() {
  generation++;
  void emit("bubble-look-clear", getCurrentWindow().label).catch(() => {});
}

export async function lookAt(point: { x: number; y: number }, typing: boolean) {
  const current = ++generation;
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
export function watchCaret(input: HTMLTextAreaElement) {
  let frame = 0;
  const update = () => {
    cancelAnimationFrame(frame);
    frame = requestAnimationFrame(() => {
      if (document.activeElement === input && document.hasFocus() && input.getClientRects().length)
        void lookAt(caretPoint(input), true).catch(() => {});
    });
  };
  input.addEventListener("blur", clearLook);
  window.addEventListener("blur", clearLook);
  for (const ev of ["input", "keyup", "click", "focus", "scroll"])
    input.addEventListener(ev, update);
}
