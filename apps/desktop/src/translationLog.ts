// Minimalist native translation panel (shared side panel with chat):
// - Single unified header: back to chat, clean language pair, history clock toggle, pin, collapse.
// - Main stage: quiet upper source textarea + 1px hairline + live-streaming translation pane.
// - History drawer (clock icon): search, clear all, borderless rows with hover-reveal copy & trash icon.
import { t, dateLocale } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import { glyphs } from "./icons.ts";
import { renderText } from "./richText.ts";
import { readClipboardText, translateBar } from "./translateBar.ts";
import { formatIntoLang } from "./translateLang.ts";
import { errorText } from "./errorText.ts";

export interface TranslationRecord {
  id: number;
  source: string;
  result: string;
  at: number;
  /** The language it went into; absent on older records. */
  into?: string | null;
}

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

export interface TranslationLogOptions {
  onVisibilityChange?: (shown: boolean) => void;
  onBack?: () => void;
  onTogglePin?: () => boolean;
  onCollapse?: () => void;
  initialPinned?: boolean;
}

export function translationLog(
  shell: HTMLElement,
  opts: TranslationLogOptions | ((shown: boolean) => void) = {},
) {
  const o: TranslationLogOptions =
    typeof opts === "function" ? { onVisibilityChange: opts } : opts;
  const page = document.createElement("section");
  page.className = "chat-translation";
  page.hidden = true;
  page.setAttribute("aria-label", t("chat.translations"));
  page.innerHTML = `<header data-tauri-drag-region>
      <button type="button" class="tr-back" data-tr-back>‹ ${t("translations.backChat")}</button>
      <div class="tr-head-center" data-tauri-drag-region>
        <div class="tr-lang-slot" data-tr-lang-slot></div>
        <strong class="tr-hist-title" data-tr-hist-title hidden>${t("translations.history")}</strong>
      </div>
      <button type="button" class="tr-icon-key" data-tr-history aria-label="${t("translations.history")}" title="${t("translations.history")}" aria-pressed="false">${glyphs.history}</button>
      <button type="button" class="tr-icon-key" data-tr-pin aria-label="${t("chat.pin")}" title="${t("chat.pin")}" aria-pressed="${String(o.initialPinned ?? true)}">${glyphs.pin}</button>
      <button type="button" class="tr-icon-key" data-tr-collapse aria-label="${t("chat.collapse")}" title="${t("chat.collapse")}">${glyphs.collapse}</button>
    </header>
    <div class="tr-stage" data-tr-stage>
      <form class="tr-compose">
        <textarea rows="3" placeholder="${t("translate.placeholder")}" aria-label="${t("translate.placeholder")}"></textarea>
        <div class="tr-pane-foot">
          <div class="tr-tone-slot" data-tr-tone-slot></div>
          <button type="button" class="tr-icon-btn tr-paste" data-tr-paste aria-label="${t("translate.pasteClipboard")}" title="${t("translate.pasteClipboard")}">${glyphs.paste}</button>
          <button type="button" class="tr-icon-btn tr-clear-input" data-tr-clear-input aria-label="${t("translations.clearInput")}" title="${t("translations.clearInput")}">${glyphs.close}</button>
          <button type="submit" class="tr-send" data-tr-send aria-label="${t("selection.translate")}" title="${t("selection.translate")}">${glyphs.arrow}</button>
          <button type="button" class="tr-stop" data-tr-stop aria-label="${t("chat.stop")}" title="${t("chat.stop")}" hidden>${glyphs.square}</button>
        </div>
        <output role="status"></output>
      </form>
      <div class="tr-result-pane" data-tr-result-pane>
        <div class="tr-live-text" data-tr-live-text data-empty="true">${t("translations.emptyResult")}</div>
        <div class="tr-pane-foot tr-result-foot" data-tr-result-foot hidden>
          <small class="tr-live-into" data-tr-live-into></small>
          <button type="button" class="tr-copy-live" data-tr-copy-live>${t("common.copy")}</button>
        </div>
      </div>
    </div>
    <div class="tr-history" data-tr-history-pane hidden>
      <div class="tr-history-bar">
        <input type="search" class="tr-search" placeholder="${t("translations.search")}" aria-label="${t("translations.search")}">
        <button type="button" class="tr-clear-all" data-tr-clear hidden>${t("translations.clearAll")}</button>
      </div>
      <div class="tr-scroll"></div>
    </div>`;
  shell.append(page);

  const q = <T extends HTMLElement>(s: string) => page.querySelector<T>(s)!;
  const stage = q("[data-tr-stage]");
  const historyPane = q("[data-tr-history-pane]");
  const historyBtn = q<HTMLButtonElement>("[data-tr-history]");
  const langSlot = q("[data-tr-lang-slot]");
  const histTitle = q("[data-tr-hist-title]");
  const pinBtn = q<HTMLButtonElement>("[data-tr-pin]");
  const collapseBtn = q<HTMLButtonElement>("[data-tr-collapse]");
  const compose = q<HTMLFormElement>(".tr-compose");
  const box = compose.querySelector("textarea")!;
  const status = compose.querySelector("output")!;
  const pasteBtn = q<HTMLButtonElement>("[data-tr-paste]");
  const clearInputBtn = q<HTMLButtonElement>("[data-tr-clear-input]");
  const sendBtn = q<HTMLButtonElement>("[data-tr-send]");
  const stopBtn = q<HTMLButtonElement>("[data-tr-stop]");
  const liveText = q("[data-tr-live-text]");
  const resultFoot = q("[data-tr-result-foot]");
  const liveInto = q("[data-tr-live-into]");
  const copyLiveBtn = q<HTMLButtonElement>("[data-tr-copy-live]");
  const search = q<HTMLInputElement>(".tr-search");
  const clearAll = q<HTMLButtonElement>("[data-tr-clear]");
  const scroll = q(".tr-scroll");

  // Reuse translateBar's language & tone SSOT, splitting partner selector into the header
  // and quiet tone selector into the source pane footer.
  const bar = translateBar();
  const toneEl = bar.el.querySelector(".tb-tone");
  langSlot.append(bar.el);
  if (toneEl) q("[data-tr-tone-slot]").append(toneEl);

  let records: TranslationRecord[] = [];
  let token = "";
  let streamed = "";
  let liveResult = "";
  let lastSource = "";
  let historyOpen = false;
  let pasteHintTimer = 0;
  let copyTimer = 0;

  const setHistoryView = (open: boolean) => {
    historyOpen = open;
    stage.hidden = open;
    historyPane.hidden = !open;
    langSlot.hidden = open;
    histTitle.hidden = !open;
    historyBtn.setAttribute("aria-pressed", String(open));
    if (open) {
      draw(records, true);
      queueMicrotask(() => search.focus());
    } else {
      queueMicrotask(() => box.focus());
    }
  };

  const setStreaming = (busy: boolean) => {
    sendBtn.hidden = busy;
    stopBtn.hidden = !busy;
    liveText.toggleAttribute("data-streaming", busy);
  };

  const showResult = (text: string, into?: string | null, streaming = false) => {
    liveResult = text;
    if (!text && !streaming) {
      liveText.textContent = t("translations.emptyResult");
      liveText.dataset.empty = "true";
      resultFoot.hidden = true;
      return;
    }
    delete liveText.dataset.empty;
    if (streaming) {
      liveText.textContent = text;
    } else {
      liveText.replaceChildren();
      renderText(liveText, text);
    }
    liveInto.textContent = into
      ? t("translate.into", { lang: formatIntoLang(into, t) })
      : "";
    resultFoot.hidden = streaming || !text.trim();
  };

  const resetLive = () => {
    lastSource = "";
    streamed = "";
    showResult("", null, false);
  };

  if (native) {
    void listen<{
      method: string;
      params?: { token?: string; delta?: string; text?: string };
    }>("brain-event", ({ payload }) => {
      if (!token || payload.params?.token !== token) return;
      if (payload.method === "chat.delta" && typeof payload.params.delta === "string") {
        status.textContent = "";
        streamed += payload.params.delta;
        showResult(streamed, null, true);
      } else if (payload.method === "chat.rewind") {
        streamed = String(payload.params.text ?? "");
        showResult(streamed, null, true);
      }
    });
  }

  async function translate(overrideText?: string) {
    const text = (overrideText ?? box.value).trim();
    if (!text) return;
    if (token) {
      if (native) void invoke("cancel_chat", { token });
      token = "";
    }
    if (historyOpen) setHistoryView(false);
    const mine = (token = crypto.randomUUID());
    lastSource = text;
    streamed = "";
    status.textContent = "";
    setStreaming(true);
    showResult("", null, true);
    try {
      if (native) {
        const res = await invoke<{ text: string; into?: string }>(
          "translate_selection",
          {
            text,
            token: mine,
            action: "translate",
            tone: bar.tone(),
          },
        );
        if (token !== mine) return;
        const finalText = res?.text ?? streamed;
        showResult(finalText, res?.into ?? null, false);
        search.value = "";
        await loadRecords();
      } else {
        showResult(text, bar.partner(), false);
      }
    } catch (e) {
      if (token !== mine) return;
      const code = String(e).replace(/^Error:\s*/, "");
      if (code === "stopped") {
        showResult(streamed, null, false);
      } else {
        status.textContent = errorText[code] ?? code;
        if (!streamed) showResult("", null, false);
      }
    } finally {
      if (token === mine) {
        token = "";
        setStreaming(false);
      }
    }
  }

  bar.onChange(() => {
    const activeText = box.value.trim() || lastSource;
    if (activeText && (liveResult || token)) {
      void translate(activeText);
    }
  });

  pasteBtn.onclick = async () => {
    const text = (await readClipboardText()).trim();
    if (!text) {
      clearTimeout(pasteHintTimer);
      status.textContent = t("translate.clipboardEmpty");
      pasteHintTimer = window.setTimeout(() => {
        if (status.textContent === t("translate.clipboardEmpty"))
          status.textContent = "";
      }, 1800);
      return;
    }
    status.textContent = "";
    box.value = text;
    box.focus();
    box.setSelectionRange(text.length, text.length);
  };

  clearInputBtn.onclick = () => {
    if (token && native) void invoke("cancel_chat", { token });
    token = "";
    setStreaming(false);
    box.value = "";
    status.textContent = "";
    resetLive();
    box.focus();
  };

  stopBtn.onclick = () => {
    if (token && native) void invoke("cancel_chat", { token });
  };

  copyLiveBtn.onclick = async () => {
    if (!liveResult) return;
    if (native) await invoke("copy_translation", { text: liveResult });
    else await navigator.clipboard?.writeText(liveResult);
    clearTimeout(copyTimer);
    copyLiveBtn.textContent = t("common.copied");
    copyTimer = window.setTimeout(() => {
      copyLiveBtn.textContent = t("common.copy");
    }, 1500);
  };

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

  historyBtn.onclick = () => {
    if (!historyOpen) {
      void loadRecords().then(() => setHistoryView(true));
    } else {
      setHistoryView(false);
    }
  };

  pinBtn.onclick = () => {
    if (!o.onTogglePin) return;
    const on = o.onTogglePin();
    pinBtn.setAttribute("aria-pressed", String(on));
  };
  collapseBtn.onclick = () => o.onCollapse?.();

  let request = 0;
  function hide() {
    request++;
    if (page.hidden) return;
    page.hidden = true;
    o.onVisibilityChange?.(false);
  }
  q<HTMLButtonElement>("[data-tr-back]").onclick = () => {
    hide();
    o.onBack?.();
  };

  /** Inline confirmation bar (single record or clear all). */
  function ask(text: string, yes: () => Promise<void>, no: () => void) {
    const confirmBox = document.createElement("div");
    confirmBox.className = "tr-ask";
    confirmBox.setAttribute("role", "group");
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
    confirmBox.append(say, confirm, cancel, error);
    queueMicrotask(() => cancel.focus());
    return confirmBox;
  }

  async function remove(id: number | null) {
    if (native) await invoke("delete_translation", { id });
    const top = scroll.scrollTop;
    records = id === null ? [] : records.filter((r) => r.id !== id);
    if (native) await loadRecords();
    draw(records, false);
    if (id !== null) scroll.scrollTop = top;
  }

  clearAll.onclick = () => {
    if (scroll.querySelector(".tr-ask.is-all")) return;
    const confirmBox = ask(
      t("translations.clearAsk"),
      () => remove(null),
      () => confirmBox.remove(),
    );
    confirmBox.classList.add("is-all");
    scroll.prepend(confirmBox);
    scroll.scrollTop = 0;
  };

  function item(record: TranslationRecord) {
    const article = document.createElement("article");
    article.className = "tr-item";

    const head = document.createElement("div");
    head.className = "tr-item-head";
    const meta = document.createElement("small");
    meta.className = "tr-when";
    meta.textContent = record.into
      ? `${when(record.at)} · ${t("translate.into", { lang: formatIntoLang(record.into, t) })}`
      : when(record.at);

    const actions = document.createElement("div");
    actions.className = "tr-actions";

    const copy = document.createElement("button");
    copy.type = "button";
    copy.className = "tr-copy";
    copy.innerHTML = glyphs.copy;
    copy.setAttribute("aria-label", t("translations.copy"));
    copy.title = t("translations.copy");
    copy.onclick = async () => {
      if (native) await invoke("copy_translation", { text: record.result });
      else await navigator.clipboard?.writeText(record.result);
      copy.dataset.done = "1";
      copy.textContent = t("common.copied");
      setTimeout(() => {
        delete copy.dataset.done;
        copy.innerHTML = glyphs.copy;
      }, 1500);
    };

    const del = document.createElement("button");
    del.type = "button";
    del.className = "tr-delete";
    del.innerHTML = glyphs.trash;
    del.setAttribute("aria-label", t("common.delete"));
    del.title = t("common.delete");
    del.onclick = () => {
      const confirmBox = ask(
        t("translations.deleteAsk"),
        () => remove(record.id),
        () => {
          confirmBox.replaceWith(actions);
          delete article.dataset.confirming;
        },
      );
      article.dataset.confirming = "true";
      actions.replaceWith(confirmBox);
    };

    actions.append(copy, del);
    head.append(meta, actions);

    const result = document.createElement("div");
    result.className = "tr-text";
    renderText(result, record.result);

    const source = document.createElement("p");
    source.className = "tr-source";
    source.textContent = record.source;

    article.append(head, result, source);
    article.onclick = (e) => {
      if ((e.target as HTMLElement).closest("button, .tr-ask")) return;
      if (getSelection()?.toString()) return;
      box.value = record.source;
      lastSource = record.source;
      showResult(record.result, record.into ?? null, false);
      setHistoryView(false);
    };
    return article;
  }

  function draw(list: TranslationRecord[], top = true) {
    records = list;
    clearAll.hidden = !list.length;
    const query = search.value.trim().toLowerCase();
    const shown = query
      ? list.filter((r) =>
          (r.source + "\n" + r.result).toLowerCase().includes(query),
        )
      : list;
    scroll.replaceChildren(...shown.map((r) => item(r)));
    if (!shown.length) {
      const p = document.createElement("p");
      p.className = "chat-empty";
      p.textContent = t(query ? "translations.noMatch" : "translations.empty");
      scroll.append(p);
    }
    if (top) scroll.scrollTop = 0;
  }

  async function loadRecords() {
    const current = ++request;
    try {
      const list = native
        ? await invoke<TranslationRecord[]>("translation_history")
        : records;
      if (current === request) draw(list, false);
    } catch (e) {
      if (current !== request) return;
      scroll.textContent = String(e);
    }
  }

  async function show() {
    page.hidden = false;
    o.onVisibilityChange?.(true);
    setHistoryView(false);
    await loadRecords();
    queueMicrotask(() => box.focus());
  }

  return {
    hide,
    show,
    syncPin(on: boolean) {
      pinBtn.setAttribute("aria-pressed", String(on));
    },
    handleEscape(): boolean {
      if (page.hidden) return false;
      if (historyOpen) {
        setHistoryView(false);
        return true;
      }
      return false;
    },
    isDirty: () =>
      Boolean(token || box.value.trim() || scroll.querySelector(".tr-ask")),
    /** Browser preview / tests: populate records and optionally open history drawer. */
    preview(list: TranslationRecord[], openHistory = false) {
      page.hidden = false;
      o.onVisibilityChange?.(true);
      draw(list, true);
      setHistoryView(openHistory);
    },
  };
}
