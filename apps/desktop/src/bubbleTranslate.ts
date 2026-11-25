// Translation in the bubble (plan/41): the bar with 对方语言 and 语气, typing
// a sentence to translate, which language the result is in, and 替换为译文
// for a selection. bubble.ts calls this; this file calls none of the bubble.
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import { t } from "./i18n.ts";
import { readClipboardText, translateBar } from "./translateBar.ts";
import { formatIntoLang } from "./translateLang.ts";
import type { BubbleView } from "./bubbleView.ts";

export function bubbleTranslate(
  root: HTMLElement,
  o: {
    view: BubbleView;
    card: HTMLElement;
    input: HTMLTextAreaElement;
    original: HTMLDetailsElement;
    originalText: HTMLElement;
    copy: HTMLElement;
    /** Runs the text on screen again, after a change of 对方语言 or 语气. */
    rerun(): void;
    /** The translation as shown. */
    result(): string;
    hide(): void;
  },
) {
  const { view } = o;
  const pick = <T extends HTMLElement>(q: string) => root.querySelector<T>(q)!;
  const bar = translateBar();
  bar.el.hidden = true;
  pick("[data-selection-tabs]").before(bar.el);
  const into = pick("[data-into]");
  const replace = pick("[data-replace]");
  const paste = pick<HTMLButtonElement>("[data-paste]");
  let emptyHintTimer = 0;
  bar.onChange(() => {
    if (view.mode === "translate" && view.selectionAction === "translate")
      o.rerun();
  });

  /** Shows what fits the bubble's state; bubble.ts calls it on each change. */
  function sync(state: string) {
    const translating = view.mode === "translate";
    const plain = translating && view.selectionAction === "translate";
    bar.el.hidden =
      !plain ||
      !["input", "thinking", "streaming", "answer", "error"].includes(state);
    paste.hidden = !translating;
    into.hidden = !plain || state !== "answer" || !view.into;
    into.textContent = view.into
      ? t("translate.into", { lang: formatIntoLang(view.into, t) })
      : "";
    // Only a selection has a place to go back to.
    replace.hidden = o.copy.hidden || !view.replaceTarget || view.typed;
    if (translating && !o.copy.dataset.done)
      o.copy.textContent = t(
        view.selectionAction === "translate"
          ? "translations.copy"
          : "common.copy",
      );
    if (translating) o.input.placeholder = t("translate.placeholder");
  }
  paste.onclick = async () => {
    const text = (await readClipboardText()).trim();
    if (!text) {
      clearTimeout(emptyHintTimer);
      o.input.placeholder = t("translate.clipboardEmpty");
      emptyHintTimer = window.setTimeout(() => {
        if (view.mode === "translate")
          o.input.placeholder = t("translate.placeholder");
      }, 1800);
      return;
    }
    if (native) void invoke("focus_bubble");
    o.input.value = text;
    o.input.dispatchEvent(new Event("input"));
    o.input.focus();
    o.input.setSelectionRange(text.length, text.length);
  };
  replace.onclick = async () => {
    const text = o.result();
    if (!text) return;
    try {
      await invoke("replace_with_translation", {
        text,
        target: view.replaceTarget,
      });
      o.hide();
    } catch {
      // Not possible there: copy instead, and say so.
      await invoke("copy_translation", { text }).catch(() => {});
      replace.hidden = true;
      o.copy.dataset.done = "1";
      o.copy.textContent = t("translate.copiedInstead");
    }
  };
  // A translation bubble opens without the keyboard, so the selection's app
  // keeps it; typing here takes it.
  o.input.addEventListener("pointerdown", () => {
    if (native && view.mode === "translate") void invoke("focus_bubble");
  });

  return {
    sync,
    tone: () => bar.tone(),
    /** A selection arrived; `target` is where it came from. */
    selected(target?: number) {
      view.typed = false;
      view.replaceTarget = target ?? 0;
    },
    /** The user typed this to translate: it shows as the original. */
    typed(text: string) {
      view.typed = true;
      view.replaceTarget = 0;
      view.selectionAction = "translate";
      o.originalText.textContent = text;
      o.original.open = Array.from(text).length <= 72;
    },
    /** The language the result went into, when the brain knows it. */
    done(language?: string) {
      view.into = language ?? "";
    },
    clear() {
      view.into = "";
      delete o.copy.dataset.done;
    },
  };
}
