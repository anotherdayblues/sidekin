// The bubble's frame: header buttons with their icons and names, the input
// that grows with its text, and where the pet looks while the bubble works.
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import { companionIcons as icons, glyphs } from "./icons.ts";
import { t } from "./i18n.ts";
import { lookAt, watchCaret } from "./caretLook.ts";

export function bubbleChrome(
  root: HTMLElement,
  o: {
    shell: HTMLElement;
    card: HTMLElement;
    input: HTMLTextAreaElement;
    /** True for a selection; 展开 then opens 翻译记录. */
    translating: () => boolean;
  },
) {
  const pick = (q: string) => root.querySelector<HTMLElement>(q)!;
  const label = (el: HTMLElement, glyph: string, name: string) => {
    el.innerHTML = glyph;
    el.setAttribute("aria-label", name);
    el.title = name;
  };
  const copy = pick("[data-copy]");
  const resetCopy = () => (copy.textContent = icons.copy);
  resetCopy();
  label(pick("[data-paste]"), glyphs.paste, t("translate.pasteClipboard"));
  label(pick("[data-snip]"), glyphs.snip, t("chat.snip"));
  label(pick("[data-send]"), glyphs.arrow, icons.send);
  pick("[data-stop]").textContent = icons.stop;
  const expand = pick("[data-expand]");
  label(expand, glyphs.expand, icons.expand);
  label(pick("[data-pin]"), glyphs.pin, icons.pin);
  label(pick("[data-close]"), glyphs.close, icons.close);
  // The window continues this topic; a reply still streaming finishes there.
  expand.onclick = () => {
    if (native)
      void invoke(o.translating() ? "open_translations" : "open_chat_window");
  };

  // The field grows with the text, up to about five lines, then scrolls.
  const grow = () => {
    o.input.style.height = "auto";
    o.input.style.height = Math.min(o.input.scrollHeight, 112) + "px";
  };
  o.input.addEventListener("input", grow);

  // Tell the pet where to look: the caret while typing, the card otherwise.
  if (native) watchCaret(o.input);
  let lastCardLook = 0;
  const lookAtCard = () => {
    if (
      !native ||
      document.hidden ||
      root.hidden ||
      o.shell.hasAttribute("data-closing") ||
      o.card.dataset.state !== "streaming" ||
      Date.now() - lastCardLook < 400
    )
      return;
    lastCardLook = Date.now();
    const r = o.card.getBoundingClientRect();
    void lookAt(
      { x: r.left + r.width / 2, y: r.top + r.height / 2 },
      false,
    ).catch(() => {});
  };
  return { grow, lookAtCard, resetCopy };
}
