import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";

interface Exchange {
  question: string;
  answer: string;
}

interface Page {
  topic: number | null;
  before: number | null;
  turns: Exchange[];
}

function messages(turns: Exchange[]) {
  return turns.flatMap(({ question, answer }) =>
    [question, answer].map((text, i) => {
      const p = document.createElement("p");
      p.className = "bubble-msg";
      p.dataset.who = i === 0 ? "mine" : "theirs";
      p.textContent = text;
      return p;
    }),
  );
}

export function bubbleThread(el: HTMLElement, viewport: HTMLElement) {
  let topic: number | null = null;
  let before: number | null = null;
  let epoch = 0;
  let loading = false;
  const older = document.createElement("button");
  older.type = "button";
  older.textContent = t("bubble.older");

  function reset() {
    epoch++;
    loading = false;
    topic = before = null;
    older.hidden = true;
    el.replaceChildren(older);
    el.hidden = true;
  }

  async function load(initial: boolean) {
    if (loading || (!initial && before === null)) return;
    const version = epoch;
    loading = true;
    try {
      const page = await invoke<Page>("bubble_history_page", { topic, before });
      if (version !== epoch || !page) return;
      if (initial && topic !== null && topic !== page.topic) return;
      const anchor = older.nextElementSibling;
      const offset = anchor?.getBoundingClientRect().top;
      older.after(...messages(page.turns));
      topic = page.topic;
      before = page.before;
      older.textContent = t("bubble.older");
      older.hidden = before === null;
      el.hidden = !older.nextElementSibling;
      if (initial) viewport.scrollTop = viewport.scrollHeight;
      else if (anchor && offset !== undefined)
        viewport.scrollTop += anchor.getBoundingClientRect().top - offset;
    } catch {
      if (version === epoch) {
        older.textContent = t("bubble.olderRetry");
        older.hidden = el.hidden = false;
      }
    } finally {
      if (version === epoch) loading = false;
    }
  }

  older.onclick = () => void load(before === null);
  const nearTop = () =>
    !el.hidden && el.getClientRects().length && viewport.scrollTop <= 2;
  viewport.addEventListener(
    "wheel",
    (e) => {
      if (e.deltaY < 0 && nearTop()) void load(false);
    },
    { passive: true },
  );
  viewport.addEventListener("scroll", () => {
    if (nearTop()) void load(false);
  });
  reset();
  return {
    reset,
    open(id: number | null = null, beforeTurn: number | null = null) {
      reset();
      topic = id;
      before = beforeTurn;
      older.textContent = t("bubble.older");
      void load(true);
    },
    continued(id: number) {
      if (topic !== null && topic !== id) reset();
      topic = id;
    },
    append(turn: Exchange) {
      el.append(...messages([turn]));
      el.hidden = false;
    },
  };
}
