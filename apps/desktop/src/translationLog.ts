// 翻译记录 in the side panel: every translation's original and result,
// newest first. Apart from chat: no context, no replies. On top, a sentence
// can be typed to translate (plan/41); the records can be searched, and a
// click puts one's original back there. One can be deleted, or all of them,
// each after a yes.
import { t, dateLocale } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import { renderText } from "./richText.ts";
import { translateBar } from "./translateBar.ts";

export interface TranslationRecord {
  id: number;
  source: string;
  result: string;
  at: number;
  /** The language it went into; absent on older records. */
  into?: string | null;
}
const LONG = 160;

function when(at: number) {
  const d = new Date(at),
    today = new Date();
  const clock = d.toLocaleTimeString(dateLocale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  return d.toDateString() === today.toDateString()
    ? t("chat.todayAt", { clock })
    : d.toLocaleDateString(dateLocale, { month: "numeric", day: "numeric" }) +
        " " +
        clock;
}

export function translationLog(
  shell: HTMLElement,
  onVisibilityChange?: (shown: boolean) => void,
) {
  const page = document.createElement("section");
  page.className = "chat-translation";
  page.hidden = true;
  page.setAttribute("aria-label", t("chat.translations"));
  page.innerHTML = `<header><button type="button" data-tr-back>← ${t("translations.back")}</button><strong>${t("chat.translations")}</strong><button type="button" data-tr-clear>${t("translations.clearAll")}</button></header><form class="tr-compose"><textarea rows="2" placeholder="${t("translate.placeholder")}" aria-label="${t("translate.placeholder")}"></textarea><div class="tr-compose-foot"><output role="status"></output><button type="submit" data-tr-send>${t("selection.translate")}</button></div></form><input type="search" class="tr-search" placeholder="${t("translations.search")}" aria-label="${t("translations.search")}"><div class="tr-scroll"></div>`;
  shell.append(page);
  const scroll = page.querySelector<HTMLElement>(".tr-scroll")!;
  const compose = page.querySelector<HTMLFormElement>(".tr-compose")!;
  const box = compose.querySelector("textarea")!;
  const status = compose.querySelector("output")!;
  const search = page.querySelector<HTMLInputElement>(".tr-search")!;
  const bar = translateBar();
  compose.prepend(bar.el);
  let token = "";
  /** Translates what is typed; the new record then shows at the top. */
  async function translate() {
    const text = box.value.trim();
    if (!text || token) return;
    const mine = (token = crypto.randomUUID());
    status.textContent = t("translations.translating");
    try {
      if (native)
        await invoke("translate_selection", {
          text,
          token: mine,
          action: "translate",
          tone: bar.tone(),
        });
      if (token !== mine) return;
      status.textContent = "";
      box.value = "";
      search.value = "";
      await load();
    } catch (e) {
      if (token === mine) status.textContent = String(e);
    } finally {
      if (token === mine) token = "";
    }
  }
  compose.onsubmit = (e) => {
    e.preventDefault();
    void translate();
  };
  box.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void translate();
    }
  };
  search.oninput = () => draw(records, false);
  let request = 0;
  function hide() {
    request++;
    page.hidden = true;
    onVisibilityChange?.(false);
  }
  page.querySelector<HTMLButtonElement>("[data-tr-back]")!.onclick = hide;
  const clearAll = page.querySelector<HTMLButtonElement>("[data-tr-clear]")!;
  // What is shown, so the browser preview can delete without the host.
  let records: TranslationRecord[] = [];

  /** A question in place, with 确认删除 and 取消; an error stays in it. */
  function ask(text: string, yes: () => Promise<void>, no: () => void) {
    const box = document.createElement("div");
    box.className = "tr-ask";
    box.setAttribute("role", "group");
    const say = document.createElement("span");
    say.textContent = text;
    const confirm = document.createElement("button");
    const cancel = document.createElement("button");
    confirm.type = cancel.type = "button";
    confirm.className = "tr-confirm";
    confirm.textContent = t("common.confirmDelete");
    cancel.textContent = t("common.cancel");
    const error = document.createElement("small");
    error.setAttribute("role", "alert");
    cancel.onclick = no;
    confirm.onclick = async () => {
      confirm.disabled = cancel.disabled = true;
      try {
        await yes();
      } catch (e) {
        confirm.disabled = cancel.disabled = false;
        error.textContent = String(e);
      }
    };
    box.append(say, confirm, cancel, error);
    queueMicrotask(() => cancel.focus());
    return box;
  }
  /** Deletes one record, or all with `id` null, then draws what is left. */
  async function remove(id: number | null) {
    if (native) await invoke("delete_translation", { id });
    const top = scroll.scrollTop;
    records = id === null ? [] : records.filter((r) => r.id !== id);
    if (native) await load();
    else draw(records);
    // One gone: stay where the reader was.
    if (id !== null) scroll.scrollTop = top;
  }
  clearAll.onclick = () => {
    if (scroll.querySelector(".tr-ask.is-all")) return;
    const box = ask(
      t("translations.clearAsk"),
      () => remove(null),
      () => box.remove(),
    );
    box.classList.add("is-all");
    scroll.prepend(box);
    scroll.scrollTop = 0;
  };

  function item(record: TranslationRecord, first: boolean) {
    const article = document.createElement("article");
    article.className = "tr-item";
    const meta = document.createElement("small");
    meta.className = "tr-when";
    meta.textContent = record.into
      ? `${when(record.at)} · ${t("translate.into", { lang: record.into })}`
      : when(record.at);
    const source = document.createElement("details");
    source.className = "tr-source";
    source.open = first
      ? record.source.length < 600
      : record.source.length <= LONG;
    source.innerHTML = `<summary>${t("selection.source")}</summary><div></div>`;
    source.querySelector("div")!.textContent = record.source;
    const result = document.createElement("div");
    result.className = "tr-text";
    renderText(result, record.result);
    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "tr-copy";
    copy.textContent = t("translations.copy");
    copy.onclick = async () => {
      if (native) await invoke("copy_translation", { text: record.result });
      else await navigator.clipboard?.writeText(record.result);
      copy.textContent = t("common.copied");
      setTimeout(() => (copy.textContent = t("translations.copy")), 1500);
    };
    const del = document.createElement("button");
    del.type = "button";
    del.className = "tr-delete";
    del.textContent = t("common.delete");
    const actions = document.createElement("div");
    actions.className = "tr-actions";
    actions.append(copy, del);
    del.onclick = () => {
      const box = ask(
        t("translations.deleteAsk"),
        () => remove(record.id),
        () => box.replaceWith(actions),
      );
      actions.replaceWith(box);
    };
    article.append(meta, source, result, actions);
    // A click on the record, not its buttons: its original goes back on top.
    article.onclick = (e) => {
      if ((e.target as HTMLElement).closest("button, summary, .tr-ask")) return;
      if (getSelection()?.toString()) return;
      box.value = record.source;
      box.focus();
      scroll.scrollTop = 0;
    };
    return article;
  }
  function draw(list: TranslationRecord[], top = true) {
    records = list;
    clearAll.hidden = !list.length;
    const q = search.value.trim().toLowerCase();
    const shown = q
      ? list.filter((r) =>
          (r.source + "\n" + r.result).toLowerCase().includes(q),
        )
      : list;
    scroll.replaceChildren(...shown.map((t, i) => item(t, i === 0 && !q)));
    if (!shown.length) {
      const p = document.createElement("p");
      p.className = "chat-empty";
      p.textContent = t(q ? "translations.noMatch" : "translations.empty");
      scroll.append(p);
    }
    if (top) scroll.scrollTop = 0;
    page.hidden = false;
    onVisibilityChange?.(true);
  }
  async function load() {
    const current = ++request;
    try {
      const list = native
        ? await invoke<TranslationRecord[]>("translation_history")
        : [];
      if (current === request) draw(list);
    } catch (e) {
      if (current !== request) return;
      scroll.textContent = String(e);
      page.hidden = false;
      onVisibilityChange?.(true);
    }
  }
  return {
    hide,
    show: load,
    isDirty: () =>
      Boolean(token || box.value.trim() || scroll.querySelector(".tr-ask")),
    /** Browser preview only. */
    preview: draw,
  };
}
