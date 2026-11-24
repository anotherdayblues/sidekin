// The 翻译 / 解释 / 润色 / 总结 tabs on a selection: shown only for a
// selection with its original text, and a click runs the same text again.
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import type { BubbleView, SelectionAction } from "./bubbleView.ts";

export function bubbleSelection(
  tabs: HTMLElement,
  o: {
    view: BubbleView;
    card: HTMLElement;
    original: HTMLDetailsElement;
    originalText: HTMLElement;
    submit: (message: string, operation: "translate") => Promise<void>;
  },
) {
  const { view } = o;
  function sync() {
    tabs.hidden = view.mode !== "translate" || o.original.hidden || view.typed;
    for (const btn of tabs.querySelectorAll<HTMLButtonElement>(
      "[data-selection-action]",
    ))
      btn.setAttribute(
        "aria-pressed",
        String(btn.dataset.selectionAction === view.selectionAction),
      );
  }
  tabs.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>(
      "[data-selection-action]",
    );
    if (!btn) return;
    const next = btn.dataset.selectionAction as SelectionAction;
    // The same tab again does nothing while it runs or once it has answered.
    if (
      next === view.selectionAction &&
      (view.token || o.card.dataset.state === "answer")
    )
      return;
    if (view.token) {
      if (native) void invoke("cancel_chat", { token: view.token });
      view.token = "";
    }
    view.selectionAction = next;
    sync();
    const source = o.originalText.textContent || view.last;
    if (source.trim()) void o.submit(source, "translate");
  });
  return { sync };
}
