// The studio is let go after a while hidden (studio_window.rs). Before
// that the host asks this page, and it agrees only if nothing would be
// lost: no field typed into and not left as it was, no dialog open, no
// work still running.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

/** Whether anything here would be lost if the page went away now. */
export function holdsUnsaved(root: ParentNode, running: number) {
  if (running > 0) return true;
  if (root.querySelector("dialog[open], [aria-busy='true']")) return true;
  for (const [field, before] of typed)
    if (field.isConnected && field.value !== before) return true;
  return false;
}

// Each field the user typed into, with its value from before.
const typed = new Map<HTMLInputElement | HTMLTextAreaElement, string>();
// Search boxes are transient filters, never unsaved user data.
const TEXT =
  "textarea, input:not([type]), input[type=text], input[type=url], input[type=password], input[type=email], input[type=number]";

export function keepStudio() {
  let running = 0;
  const before = new WeakMap<Element, string>();
  document.addEventListener("focusin", (e) => {
    const f = e.target as HTMLInputElement;
    if (f.matches?.(TEXT) && !typed.has(f)) before.set(f, f.value);
  });
  document.addEventListener("input", (e) => {
    const f = e.target as HTMLInputElement;
    if (f.matches?.(TEXT) && !typed.has(f))
      typed.set(f, before.get(f) ?? f.defaultValue);
  });
  // Submitting a form commits its fields, so they no longer block release.
  document.addEventListener("submit", (e) => {
    const form = e.target;
    if (!(form instanceof HTMLFormElement)) return;
    for (const f of [...typed.keys()]) {
      if (form.contains(f)) {
        typed.delete(f);
        before.set(f, f.value);
      }
    }
  });
  void listen("studio-release-check", () => {
    for (const f of [...typed.keys()]) if (!f.isConnected) typed.delete(f);
    if (!holdsUnsaved(document, running)) void invoke("studio_release");
  });
  return {
    /** Counts `work` as running until it settles. */
    track<T>(work: Promise<T>) {
      running++;
      return work.finally(() => running--);
    },
    /** The page listens now: the host shows it and sends what waited. */
    ready() {
      void invoke("studio_ready").catch(() => {});
    },
  };
}
