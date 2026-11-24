// 记忆 (plan/29): one page for what the pet keeps, as the memory pages of
// nanoMuse, Pi and ChatGPT gather it: 关于你 (what you wrote), 它记住的
// (what it noted down itself) and 资料库 (the files it can look up). A
// column on the left also opens the existing clipboard history. Chats and
// translations are looked back on in the chat panel, not here.
import "./styles/memory-page.css";
import { t } from "./i18n.ts";

export type MemoryView = "about" | "remembered" | "library" | "clipboard";

export function mountMemoryPage(
  block: HTMLElement,
  existing: Record<Exclude<MemoryView, "clipboard">, HTMLElement>,
) {
  const clipboard = document.createElement("section");
  const parts = { ...existing, clipboard };
  // Load clipboard data only while its own pane is on screen.
  let revision = 0,
    visible = false,
    dispose: (() => void) | undefined;
  const sync = () => {
    const turn = ++revision;
    if (!visible || document.hidden) {
      dispose?.();
      dispose = undefined;
      return;
    }
    if (!dispose)
      void import("./clipboardMemory.ts").then(({ mountClipboardMemory }) => {
        if (turn === revision) dispose = mountClipboardMemory(clipboard);
      });
  };
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    sync();
  });
  observer.observe(clipboard);
  document.addEventListener("visibilitychange", sync);
  const layout = document.createElement("div");
  layout.className = "memory-layout";
  const nav = document.createElement("nav");
  nav.className = "memory-nav";
  nav.setAttribute("aria-label", t("memory.title"));
  const pane = document.createElement("div");
  pane.className = "memory-pane";
  const labels: Record<MemoryView, string> = {
    about: t("memory.aboutYou"),
    remembered: t("memory.itRemembers"),
    library: t("library.title"),
    clipboard: t("clip.memoryPage"),
  };
  const keys = (Object.keys(labels) as MemoryView[]).map((view) => {
    const b = document.createElement("button");
    b.type = "button";
    b.dataset.view = view;
    b.textContent = labels[view];
    b.onclick = () => show(view);
    nav.append(b);
    parts[view].dataset.memoryView = view;
    pane.append(parts[view]);
    return b;
  });
  layout.append(nav, pane);
  block.append(layout);
  const note = block.querySelector<HTMLElement>(".block-head > .silk");
  const memoryNote = note?.textContent ?? "";
  function show(view: MemoryView) {
    if (note)
      note.textContent =
        view === "clipboard" ? t("clip.memoryNote") : memoryNote;
    block.dataset.memoryView = view;
    for (const b of keys)
      b.setAttribute("aria-current", String(b.dataset.view === view));
    for (const [id, el] of Object.entries(parts)) el.hidden = id !== view;
  }
  show("about");
  return { show };
}
