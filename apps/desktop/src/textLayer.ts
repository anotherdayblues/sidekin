// Invisible, selectable text laid over a screenshot, so text can be
// dragged-selected right on the picture (like Live Text). Technique after
// pdf.js (src/display/text_layer.js, web/text_layer_builder.*): one
// transparent span per recognized line, sized from the box height and
// stretched with scaleX to the box width; a <br> ends each row so copying
// keeps line breaks; an "end of content" block stops WebKit selections from
// jumping to the whole layer when the pointer crosses empty space.

export interface OcrLine {
  t: string;
  x: number;
  y: number;
  w: number;
  h: number;
  row: number;
}

const OPENING = "([{（【《「『“‘<";
const CLOSING = ")]}）】》」』”’>";
const SUFFIX = ",.:;!?%…‥";
const CJK_PUNCT = "、。・！％，．：；？｡､･";
/** Same rule as the Rust side (ocr.rs `space_between`). */
export function spaceBetween(left: string, right: string) {
  if (!left || !right) return false;
  if (OPENING.includes(left) || CLOSING.includes(right)) return false;
  if (SUFFIX.includes(right)) return false;
  if (CJK_PUNCT.includes(left) || CJK_PUNCT.includes(right)) return false;
  return /[A-Za-z0-9]/.test(left) || /[A-Za-z0-9]/.test(right);
}

/** Text as a reader would copy it: no stray spaces before line ends. */
export function normalizeCopy(text: string) {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

type Placed = { span: HTMLSpanElement; line: OcrLine; core: string };
const placed = new WeakMap<HTMLElement, Placed[]>();
const ends = new WeakMap<HTMLElement, HTMLElement>();

export function renderTextLayer(layer: HTMLElement, lines: OcrLine[]) {
  layer.replaceChildren();
  const items: Placed[] = [];
  lines.forEach((line, i) => {
    const next = lines[i + 1];
    const core = line.t.trim();
    const sameRow = next && next.row === line.row;
    const span = document.createElement("span");
    // A space goes inside the span, never as a loose text node in the layer.
    span.textContent =
      core +
      (sameRow && spaceBetween(core.slice(-1), next.t.trim()[0]) ? " " : "");
    layer.append(span);
    if (!sameRow) {
      const br = document.createElement("br");
      br.setAttribute("role", "presentation");
      layer.append(br);
    }
    items.push({ span, line, core });
  });
  const end = document.createElement("div");
  end.className = "text-layer-end";
  layer.append(end);
  placed.set(layer, items);
  ends.set(layer, end);
}

let canvas: HTMLCanvasElement | null = null;
/** Positions every span for the picture's current on-screen size. */
export function layoutTextLayer(
  layer: HTMLElement,
  width: number,
  height: number,
) {
  const items = placed.get(layer);
  if (!items || !width || !height) return;
  canvas ??= document.createElement("canvas");
  // Measuring with the page's language keeps CJK fallback fonts the same
  // as the ones that render (pdf.js sets canvas.lang for this reason).
  canvas.lang = layer.lang || document.documentElement.lang || "zh-CN";
  const ctx = canvas.getContext("2d")!;
  const family = getComputedStyle(layer).fontFamily || "sans-serif";
  for (const { span, line, core } of items) {
    const boxH = line.h * height;
    const size = Math.max(1, boxH * 0.86);
    const s = span.style;
    s.left = line.x * width + "px";
    s.top = line.y * height + (boxH - size) / 2 + "px";
    s.fontSize = size + "px";
    ctx.font = `${size}px ${family}`;
    const measured = ctx.measureText(core).width;
    s.transform =
      measured > 0 ? `scaleX(${(line.w * width) / measured})` : "none";
  }
}

/** The text selected inside `within`, or "". */
export function selectionIn(within: HTMLElement) {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
  const range = sel.getRangeAt(0);
  if (!within.contains(range.commonAncestorContainer)) return "";
  return normalizeCopy(sel.toString());
}

/** Keeps drag-selection steady and copying clean for one layer. */
export function watchTextLayer(layer: HTMLElement) {
  let previous: Range | null = null;
  const reset = () => {
    const end = ends.get(layer);
    layer.classList.remove("selecting");
    previous = null;
    if (!end) return;
    layer.append(end);
    end.style.width = end.style.height = end.style.userSelect = "";
  };
  layer.addEventListener("mousedown", () => layer.classList.add("selecting"));
  addEventListener("pointerup", reset);
  addEventListener("blur", reset);
  addEventListener("keyup", reset);
  document.addEventListener("selectionchange", () => {
    const sel = document.getSelection();
    const end = ends.get(layer);
    if (!sel || !sel.rangeCount || !end) return;
    const range = sel.getRangeAt(0);
    if (!layer.contains(range.commonAncestorContainer) || sel.isCollapsed)
      return;
    // Put the end block right beside the moving edge of the selection
    // (pdf.js text_layer_builder #enableGlobalSelectionListener).
    const startMoved =
      previous &&
      (range.compareBoundaryPoints(Range.END_TO_END, previous) === 0 ||
        range.compareBoundaryPoints(Range.START_TO_END, previous) === 0);
    let anchor: Node | null = startMoved
      ? range.startContainer
      : range.endContainer;
    if (anchor?.nodeType === Node.TEXT_NODE) anchor = anchor.parentNode;
    if (!startMoved && range.endOffset === 0 && anchor) {
      do {
        while (anchor && !anchor.previousSibling && anchor !== layer)
          anchor = anchor.parentNode;
        anchor = anchor?.previousSibling ?? null;
      } while (anchor && !anchor.childNodes.length);
    }
    if (anchor && anchor.parentElement === layer && anchor !== end) {
      end.style.width = layer.clientWidth + "px";
      end.style.height = layer.clientHeight + "px";
      end.style.userSelect = "text";
      layer.insertBefore(end, startMoved ? anchor : anchor.nextSibling);
    }
    previous = range.cloneRange();
  });
  layer.addEventListener("copy", (e) => {
    const text = selectionIn(layer);
    if (!text) return;
    e.clipboardData?.setData("text/plain", text);
    e.preventDefault();
  });
}
