// What goes to the voice: the reply as it streams, without the things a
// person would not read aloud (plan/10 §9.2). The bubble keeps the full text;
// only this copy is cleaned. Rules after Pipecat's MarkdownTextFilter.

const SENTENCE_END = /[。！？；…!?;]|(?<!\.)\.(?=\s|$)/;
/** A line ending in any of these already has its pause. */
const PAUSE = /[。！？；，、：…!?;.,:]$/;
/** Scripts whose headings/list items take a fullwidth stop instead of an ASCII period. */
const CJK_STOP_SCRIPT = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u;
/** Where a partial line may be cut: after CJK punctuation, or after ASCII
 * punctuation followed by a space (so "3.5", "example.com" and "..." stay whole). */
const BREAK = /[。！？；，、…]|(?<!\.)\.(?=\s)|[!?;,](?=\s)/g;

function inline(text: string) {
  return text
    .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/https?:\/\/\S+/g, "")
    .replace(/<[^>]+>/g, "")
    .replace(/\p{Extended_Pictographic}️?/gu, "")
    .replace(/[*~]+/g, "")
    .replace(/(^|\s)_+|_+(?=\s|$)/g, "$1")
    .replace(/[ \t]+/g, " ");
}

/** One complete line of markdown as spoken text, or "" for none. */
function line(text: string) {
  if (/^\s*\|/.test(text) || /^\s*([-*_])(\s*\1){2,}\s*$/.test(text)) return "";
  const body = inline(
    text.replace(/^\s*(#{1,6}\s+|>\s*|[-*+]\s+|\d+[.)]\s+)/, ""),
  ).trim();
  if (!body) return "";
  // A heading or list item has no full stop; give it one matching its script so it is a pause.
  if (PAUSE.test(body)) return body;
  return body + (CJK_STOP_SCRIPT.test(body) ? "。" : ".");
}

/** Feeds the streaming reply in, returns what can be spoken so far. */
export function spokenFilter() {
  let pending = "",
    fence = false,
    needsSpace = false;
  const join = (piece: string) => {
    if (!piece) return "";
    const prefix = needsSpace && !/^\s/.test(piece) ? " " : "";
    needsSpace = /[.!?;,:]$/.test(piece);
    return prefix + piece;
  };
  const whole = (text: string) => {
    if (/^\s*```/.test(text)) {
      fence = !fence;
      return "";
    }
    return fence ? "" : join(line(text));
  };
  return {
    push(delta: string) {
      pending += delta;
      let out = "";
      for (let i; (i = pending.indexOf("\n")) >= 0;) {
        out += whole(pending.slice(0, i));
        pending = pending.slice(i + 1);
      }
      // Speak a long line before it ends, at a safe break: not in code, a
      // table or a heading, and not inside an unfinished link or code span.
      if (fence || /^\s*(\||`|#)/.test(pending)) return out;
      const listPrefix =
        pending.match(/^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+)/)?.[0].length ?? 0;
      let cut = 0;
      for (const m of pending.matchAll(BREAK)) {
        if (m.index < listPrefix) continue;
        const head = pending.slice(0, m.index + m[0].length);
        const open =
          (head.match(/`/g)?.length ?? 0) % 2 ||
          head.lastIndexOf("[") > head.lastIndexOf(")") ||
          /https?:\/\/\S*$/.test(head);
        if (!open) cut = m.index + m[0].length;
      }
      if (cut) {
        out += join(
          inline(pending.slice(0, cut)).replace(
            /^\s*(?:>\s*|[-*+]\s+|\d+[.)]\s+)/,
            "",
          ),
        );
        pending = pending.slice(cut);
      }
      return out;
    },
    flush() {
      const rest = whole(pending);
      pending = "";
      return rest;
    },
  };
}

/** Last whitespace boundary inside `window` that still leaves non-empty text before it. */
function lastWordBreak(window: string): number {
  for (let i = window.length - 1; i > 0; i--) {
    if (/\s/.test(window[i]) && window.slice(0, i).trim().length > 0) {
      return i + 1;
    }
  }
  return -1;
}

/**
 * For voices that take a whole text per request: gathers the spoken text
 * into sentences, after Hermes. A sentence goes out at its end punctuation
 * once it has `min` characters; a long run without one is cut at a comma
 * (or whitespace for space-delimited scripts).
 */
export function sentences(min = 6, max = 200) {
  let text = "";
  const take = (n: number) => {
    const s = text.slice(0, n).trim();
    text = text.slice(n);
    return s;
  };
  return {
    push(piece: string) {
      text += piece;
      const out: string[] = [];
      for (;;) {
        let end = -1;
        for (const m of text.matchAll(new RegExp(SENTENCE_END, "g")))
          if (
            Array.from(text.slice(0, m.index + m[0].length).trim()).length >=
            min
          ) {
            end = m.index + m[0].length;
            break;
          }
        if (end < 0 && Array.from(text).length > max) {
          const window = Array.from(text).slice(0, max).join("");
          const comma = Math.max(
            window.lastIndexOf("，"),
            window.lastIndexOf("、"),
            window.lastIndexOf(","),
          );
          if (comma > 0) {
            end = comma + 1;
          } else {
            const space = lastWordBreak(window);
            end = space > 0 ? space : window.length;
          }
        }
        if (end < 0) return out;
        const s = take(end);
        if (s) out.push(s);
      }
    },
    flush() {
      return take(text.length);
    },
  };
}
