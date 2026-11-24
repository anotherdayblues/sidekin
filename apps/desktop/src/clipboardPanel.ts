import { glyphs } from "./icons.ts";
import { invoke } from "@tauri-apps/api/core";
import { dateLocale, t, type Key } from "./i18n.ts";
import "./styles/clipboard.css";

import {
  clipSettings,
  defaultClipPrefs,
  formatBytes,
  type ClipCall as Call,
  type ClipDetail,
  type ClipEntry as Item,
  type ClipFilter,
  type ClipImageUsage,
  type ClipPreferences as Prefs,
} from "./clipboardSettings.ts";
import "./styles/clipboard-settings.css";
export type ClipboardView = { id: number };

export function clipboardPanel(session: ClipboardView, call: Call = invoke) {
  const panel = document.createElement("section");
  panel.className = "clipboard-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", t("clip.title"));
  panel.innerHTML = `<header><span class="clip-search-icon" aria-hidden="true">${glyphs.search}</span><input type="search" autocomplete="off" spellcheck="false"><button class="clip-icon-btn" data-settings>${glyphs.tune}</button><button class="clip-icon-btn" data-close>${glyphs.close}</button></header><div class="clip-filters"><div class="clip-filter-tabs" role="tablist"><button type="button" role="tab" data-kind="all" aria-selected="true"></button><button type="button" role="tab" data-kind="text" aria-selected="false"></button><button type="button" role="tab" data-kind="image" aria-selected="false"></button></div><button type="button" class="clip-select-toggle" data-select-mode aria-pressed="false"></button></div><div class="clip-list" role="listbox"></div><div class="clip-detail" hidden></div><div class="clip-settings" hidden></div><footer><button data-paste></button><button data-copy-only></button><button data-delete-current></button><button data-select-all hidden></button><button class="clip-danger" data-delete-selected hidden></button><button data-select-done hidden></button></footer><div class="clip-actions" hidden></div><output role="status"></output>`;
  const el = <T extends HTMLElement>(selector: string) =>
    panel.querySelector<T>(selector)!;
  const input = el<HTMLInputElement>("input"),
    filters = el<HTMLElement>(".clip-filters"),
    selectToggle = el<HTMLButtonElement>("[data-select-mode]"),
    list = el<HTMLElement>(".clip-list"),
    settings = el<HTMLElement>(".clip-settings"),
    detail = el<HTMLElement>(".clip-detail"),
    actions = el<HTMLElement>(".clip-actions"),
    status = el<HTMLOutputElement>("output");
  const pasteButton = el<HTMLButtonElement>("[data-paste]"),
    copyButton = el<HTMLButtonElement>("footer [data-copy-only]"),
    deleteCurrentButton = el<HTMLButtonElement>("[data-delete-current]"),
    selectAllButton = el<HTMLButtonElement>("[data-select-all]"),
    deleteSelectedButton = el<HTMLButtonElement>("[data-delete-selected]"),
    selectDoneButton = el<HTMLButtonElement>("[data-select-done]");
  const mac = document.documentElement.dataset.platform === "mac";
  const copyKeys = mac ? "⌘+↵" : "Ctrl+↵";
  const deleteKeys = mac ? "⌘⌫" : "Ctrl+Del";
  const date = new Intl.DateTimeFormat(dateLocale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  const timeOnly = new Intl.DateTimeFormat(dateLocale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  function formatAt(ms: number) {
    const d = new Date(ms),
      now = new Date();
    const sameDay =
      d.getFullYear() === now.getFullYear() &&
      d.getMonth() === now.getMonth() &&
      d.getDate() === now.getDate();
    return sameDay ? timeOnly.format(d) : date.format(d);
  }
  let items: Item[] = [],
    selected = 0,
    revision = 0,
    alive = true,
    busy = false,
    prefs: Prefs = defaultClipPrefs,
    composing = false,
    morePages = false,
    kindFilter: ClipFilter = "all",
    selectMode = false,
    lastCheckedIndex: number | null = null;
  const checkedIds = new Set<number>();

  const filterLabels: Record<ClipFilter, Key> = {
    all: "clip.filterAll",
    text: "clip.filterText",
    image: "clip.filterImage",
  };
  filters.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((btn) => {
    const k = btn.dataset.kind as ClipFilter;
    btn.textContent = t(filterLabels[k]);
    btn.onclick = () => {
      if (kindFilter === k) return;
      kindFilter = k;
      filters
        .querySelectorAll<HTMLButtonElement>("[data-kind]")
        .forEach((b) =>
          b.setAttribute("aria-selected", String(b.dataset.kind === k)),
        );
      selected = 0;
      void search();
    };
  });

  function button(key: Key, action: () => void) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t(key);
    b.onclick = action;
    return b;
  }
  function label(selector: string, key: Key) {
    const b = el<HTMLButtonElement>(selector);
    b.title = t(key);
    b.setAttribute("aria-label", t(key));
    return b;
  }
  function report(e: unknown) {
    if (alive) status.textContent = String(e);
  }
  const close = () => {
    if (!busy) void call("clip_close", { session: session.id }).catch(report);
  };
  label("[data-close]", "clip.close").onclick = close;
  input.placeholder = t("clip.search");
  input.setAttribute("aria-label", t("clip.search"));
  list.setAttribute("aria-label", t("clip.title"));
  input.setAttribute("role", "combobox");
  input.setAttribute("aria-expanded", "true");
  list.id = "clip-results";
  input.setAttribute("aria-controls", list.id);
  function shortcut(
    button: HTMLButtonElement,
    keys: string,
    key: Key,
    trailing = false,
  ) {
    const badge = document.createElement("kbd");
    badge.textContent = keys;
    button.replaceChildren(
      ...(trailing ? [t(key) + " ", badge] : [badge, " " + t(key)]),
    );
  }
  shortcut(pasteButton, "↵", "clip.paste");
  shortcut(copyButton, copyKeys, "clip.copyOnly");
  shortcut(deleteCurrentButton, deleteKeys, "clip.deleteShort");
  selectDoneButton.textContent = t("clip.selectDone");
  function setSelectMode(on: boolean) {
    if (selectMode === on) return;
    selectMode = on;
    checkedIds.clear();
    lastCheckedIndex = null;
    if (on) actions.hidden = true;
    panel.dataset.selectMode = String(on);
    render();
  }
  selectToggle.onclick = () => setSelectMode(!selectMode);
  selectDoneButton.onclick = () => setSelectMode(false);
  selectAllButton.onclick = () => {
    if (!items.length) return;
    const allChecked = items.every((item) => checkedIds.has(item.id));
    if (allChecked) checkedIds.clear();
    else for (const item of items) checkedIds.add(item.id);
    lastCheckedIndex = null;
    render();
  };
  async function deleteSelected() {
    const ids = items.filter((i) => checkedIds.has(i.id)).map((i) => i.id);
    if (!ids.length || busy) return;
    busy = true;
    status.textContent = "";
    sync();
    try {
      await call("clip_delete_batch", { ids });
      checkedIds.clear();
      lastCheckedIndex = null;
      await search();
      if (!items.length) setSelectMode(false);
    } catch (e) {
      report(e);
    } finally {
      busy = false;
      sync();
    }
  }
  deleteSelectedButton.onclick = () => void deleteSelected();
  function toggleChecked(index: number, shiftKey: boolean) {
    const item = items[index];
    if (!item) return;
    const next = !checkedIds.has(item.id);
    if (shiftKey && lastCheckedIndex !== null) {
      const start = Math.min(lastCheckedIndex, index);
      const end = Math.max(lastCheckedIndex, index);
      for (let idx = start; idx <= end; idx++) {
        const entry = items[idx];
        if (!entry) continue;
        if (next) checkedIds.add(entry.id);
        else checkedIds.delete(entry.id);
      }
    } else if (next) {
      checkedIds.add(item.id);
    } else {
      checkedIds.delete(item.id);
    }
    lastCheckedIndex = index;
    selected = index;
    render();
  }
  function home() {
    settings.hidden = true;
    detail.hidden = true;
    detail.replaceChildren();
    actions.hidden = true;
    filters.hidden = false;
    list.hidden = false;
    input.disabled = false;
    input.focus();
    sync();
  }
  async function configure(patch: Partial<Prefs>) {
    const next = await call<Prefs>("clip_configure", { prefs: patch });
    if (!alive) return;
    prefs = next;
    home();
    await search();
  }
  async function settingsPage() {
    if (selectMode) setSelectMode(false);
    actions.hidden = true;
    filters.hidden = true;
    list.hidden = true;
    detail.hidden = true;
    settings.hidden = false;
    input.disabled = true;
    const renderSettings = (usage: ClipImageUsage | null) => {
      if (!alive || settings.hidden) return;
      clipSettings(settings, prefs, {
        save: configure,
        clear: async () => {
          await call("clip_edit", { action: "clear", id: null });
          home();
          await search();
        },
        back: home,
        error: report,
        usage,
      });
      sync();
      settings.querySelector<HTMLElement>("input")?.focus();
    };
    renderSettings(null);
    const usage = await call<ClipImageUsage>("clip_usage").catch(() => null);
    if (usage && alive && !settings.hidden) {
      const elUsage = settings.querySelector<HTMLElement>(".clip-option-usage");
      if (elUsage) {
        elUsage.textContent = t("clip.imageUsage", {
          count: usage.count,
          used: formatBytes(usage.bytes),
          limit: formatBytes(usage.limitBytes),
        });
        elUsage.hidden = false;
      }
    }
  }
  label("[data-settings]", "clip.settings").onclick = () =>
    settings.hidden ? void settingsPage() : home();
  function sync() {
    const enabled = !!items[selected] && settings.hidden && detail.hidden;
    const inBatch = selectMode && settings.hidden && detail.hidden;
    pasteButton.hidden = inBatch;
    copyButton.hidden = inBatch;
    deleteCurrentButton.hidden = inBatch;
    selectAllButton.hidden = !inBatch;
    deleteSelectedButton.hidden = !inBatch;
    selectDoneButton.hidden = !inBatch;
    pasteButton.disabled = !enabled || busy;
    copyButton.disabled = !enabled || busy;
    deleteCurrentButton.disabled = !enabled || busy;
    selectToggle.hidden = !items.length && !selectMode;
    selectToggle.textContent = t(
      selectMode ? "clip.selectDone" : "clip.selectMode",
    );
    selectToggle.setAttribute("aria-pressed", String(selectMode));
    if (inBatch) {
      const count = items.filter((item) => checkedIds.has(item.id)).length;
      const allChecked = items.length > 0 && count === items.length;
      selectAllButton.textContent = t(
        allChecked ? "clip.unselectAll" : "clip.selectAll",
      );
      selectAllButton.disabled = !items.length || busy;
      deleteSelectedButton.textContent = t("clip.deleteSelected", { n: count });
      deleteSelectedButton.disabled = count === 0 || busy;
      selectDoneButton.disabled = busy;
    }
    list
      .querySelectorAll<HTMLElement>("[role=option]")
      .forEach((row, i) =>
        row.setAttribute("aria-selected", String(i === selected)),
      );
    if (items[selected])
      input.setAttribute("aria-activedescendant", "clip-" + items[selected].id);
    else input.removeAttribute("aria-activedescendant");
  }
  async function useEntry(
    action: "clip_paste" | "clip_copy",
    item = items[selected],
  ) {
    if (busy || !item || !settings.hidden) return;
    busy = true;
    status.textContent = "";
    sync();
    try {
      await call(action, { session: session.id, id: item.id });
    } catch (e) {
      report(e);
      if (
        alive &&
        mac &&
        action === "clip_paste" &&
        (await call<boolean>("selection_access").catch(() => true)) === false &&
        alive
      ) {
        status.append(
          " ",
          button(
            "settings.openSystemSettings",
            () => void call("selection_preferences").catch(report),
          ),
        );
      }
      input.focus();
    } finally {
      busy = false;
      sync();
    }
  }
  pasteButton.onclick = () => void useEntry("clip_paste");
  copyButton.onclick = () => void useEntry("clip_copy");
  deleteCurrentButton.onclick = () => {
    const item = items[selected];
    if (item && !busy) void edit("delete", item.id);
  };
  async function edit(action: string, id: number) {
    const keepIndex = action === "delete" ? selected : undefined;
    try {
      await call("clip_edit", { action, id });
      home();
      await search(false, keepIndex);
    } catch (e) {
      report(e);
    }
  }
  async function showDetail(item: Item) {
    try {
      const isImage = item.kind === "image";
      if (!isImage) {
        const full = await call<string>("clip_full", { id: item.id });
        if (!alive) return;
        actions.hidden = true;
        filters.hidden = true;
        list.hidden = true;
        detail.replaceChildren(
          document.createTextNode(full),
          button("clip.back", home),
        );
        detail.hidden = false;
        return;
      }
      const info = await call<ClipDetail>("clip_detail", { id: item.id });
      if (!alive) return;
      actions.hidden = true;
      filters.hidden = true;
      list.hidden = true;
      const nodes: Node[] = [];
      if (info.imageDataUrl) {
        const wrap = document.createElement("div");
        wrap.className = "clip-detail-img-wrap";
        const img = document.createElement("img");
        img.className = "clip-detail-img";
        img.src = info.imageDataUrl;
        img.alt = item.preview;
        wrap.append(img);
        nodes.push(wrap);
      }
      const metaParts = [
        info.width && info.height ? `${info.width}×${info.height}` : "",
        info.bytes ? formatBytes(info.bytes) : "",
      ].filter(Boolean);
      if (metaParts.length) {
        const meta = document.createElement("small");
        meta.className = "clip-detail-meta";
        meta.textContent = metaParts.join(" · ");
        nodes.push(meta);
      }
      if (info.ocr) {
        const ocrBox = document.createElement("div");
        ocrBox.className = "clip-detail-ocr";
        const heading = document.createElement("small");
        heading.textContent = t("clip.ocrText");
        const pre = document.createElement("pre");
        pre.textContent = info.ocr;
        ocrBox.append(heading, pre);
        nodes.push(ocrBox);
      }
      const bar = document.createElement("div");
      bar.className = "clip-detail-bar";
      bar.append(button("clip.back", home));
      if (info.ocr) {
        bar.append(
          button("clip.copyOcr", async () => {
            try {
              await call("clip_copy_text", { text: info.ocr });
              report(t("common.copied"));
            } catch (e) {
              report(e);
            }
          }),
        );
      }
      nodes.push(bar);
      detail.replaceChildren(...nodes);
      detail.hidden = false;
    } catch (e) {
      report(e);
    }
  }
  function menu(item: Item, anchor: HTMLButtonElement) {
    if (!actions.hidden && actions.dataset.entry === String(item.id)) {
      home();
      return;
    }
    actions.dataset.entry = String(item.id);
    actions.hidden = false;
    const copy = button(
      "clip.copyOnly",
      () => void useEntry("clip_copy", item),
    );
    copy.dataset.copyOnly = "";
    shortcut(copy, copyKeys, "clip.copyOnly", true);
    actions.replaceChildren(
      copy,
      button(
        item.kind === "image" ? "clip.previewImage" : "clip.full",
        () => void showDetail(item),
      ),
      button(
        item.pinned ? "clip.unpin" : "clip.pin",
        () => void edit("pin", item.id),
      ),
      button("clip.delete", () => void edit("delete", item.id)),
    );
    const anchorRect = anchor.getBoundingClientRect(),
      bounds = panel.getBoundingClientRect();
    const below = anchorRect.bottom - bounds.top;
    const above = anchorRect.top - bounds.top - actions.offsetHeight;
    actions.style.top =
      Math.max(
        0,
        below + actions.offsetHeight <= bounds.height ? below : above,
      ) + "px";
    copy.focus({ preventScroll: true });
  }
  list.addEventListener("scroll", () => {
    if (!actions.hidden) home();
  });
  panel.addEventListener("pointerdown", (e) => {
    if (
      !actions.hidden &&
      e.target instanceof Element &&
      !e.target.closest(".clip-actions,[data-more]")
    )
      actions.hidden = true;
  });
  function render() {
    list.replaceChildren();
    let sawPinned = false,
      divided = false;
    for (const [i, item] of items.entries()) {
      const isImage = item.kind === "image";
      const row = document.createElement("button");
      row.type = "button";
      row.className = isImage ? "clip-row clip-row-image" : "clip-row";
      row.setAttribute("role", "option");
      row.id = "clip-" + item.id;
      const copy = document.createElement("span"),
        text = document.createElement("strong"),
        meta = document.createElement("small");
      copy.className = "clip-copy";
      let leading: HTMLElement;
      if (isImage) {
        const thumb = document.createElement("span");
        thumb.className = "clip-thumb";
        if (item.thumb) {
          const img = document.createElement("img");
          img.src = item.thumb;
          img.alt = "";
          thumb.append(img);
        } else {
          thumb.innerHTML = glyphs.image;
        }
        leading = thumb;
      } else {
        const icon = document.createElement("span");
        icon.className = "clip-icon";
        icon.innerHTML = item.link ? glyphs.link : glyphs.text;
        icon.setAttribute("aria-hidden", "true");
        leading = icon;
      }
      const dims = item.width && item.height ? `${item.width}×${item.height}` : "";
      text.textContent = isImage
        ? item.ocrPreview || (dims ? `${t("clip.imageLabel")} · ${dims}` : t("clip.imageLabel"))
        : item.preview;
      const source = item.source.endsWith(".exe")
        ? item.source.slice(0, -4)
        : item.source.split(".").at(-1) || item.source;
      meta.textContent = isImage
        ? [
            item.ocrPreview ? dims : "",
            item.bytes ? formatBytes(item.bytes) : "",
            source,
            formatAt(item.at),
          ]
            .filter(Boolean)
            .join(" · ")
        : source + " · " + formatAt(item.at);
      copy.append(text, meta);
      const checked = selectMode && checkedIds.has(item.id);
      if (selectMode) {
        const check = document.createElement("input");
        check.type = "checkbox";
        check.className = "clip-check";
        check.checked = checked;
        check.tabIndex = -1;
        check.setAttribute("aria-hidden", "true");
        row.append(check, leading, copy);
        row.setAttribute("aria-checked", String(checked));
      } else {
        row.append(leading, copy);
      }
      if (item.pinned) {
        sawPinned = true;
        const pin = document.createElement("span");
        pin.className = "clip-pin";
        pin.innerHTML = glyphs.pin;
        pin.title = t("clip.pinned");
        row.append(pin);
      }
      row.onfocus = () => {
        selected = i;
        sync();
      };
      row.onclick = (e) => {
        if (selectMode) {
          toggleChecked(i, e.shiftKey);
          return;
        }
        selected = i;
        void useEntry("clip_paste", item);
      };
      const entry = document.createElement("div"),
        rowActions = document.createElement("div"),
        quickDelete = document.createElement("button"),
        more = document.createElement("button");
      entry.className = "clip-entry";
      if (checked) entry.dataset.checked = "true";
      if (sawPinned && !item.pinned && !divided) {
        entry.classList.add("clip-group-start");
        divided = true;
      }
      rowActions.className = "clip-entry-actions";
      quickDelete.type = "button";
      quickDelete.dataset.quickDelete = "";
      quickDelete.innerHTML = glyphs.trash;
      quickDelete.title = `${t("clip.delete")} (${deleteKeys})`;
      quickDelete.setAttribute(
        "aria-label",
        t("clip.delete") + " · " + text.textContent,
      );
      quickDelete.onfocus = row.onfocus;
      quickDelete.onclick = () => {
        selected = i;
        void edit("delete", item.id);
      };
      more.type = "button";
      more.dataset.more = "";
      more.innerHTML = glyphs.more;
      more.title = t("clip.more");
      more.setAttribute("aria-label", t("clip.more") + " · " + text.textContent);
      more.onfocus = row.onfocus;
      more.onclick = () => {
        selected = i;
        sync();
        menu(item, more);
      };
      rowActions.append(quickDelete, more);
      entry.append(row, rowActions);
      list.append(entry);
    }
    if (!items.length) {
      const empty = document.createElement("p");
      empty.textContent = t(
        input.value || kindFilter !== "all"
          ? "clip.noMatch"
          : prefs.enabled
            ? "clip.empty"
            : "clip.intro",
      );
      list.append(empty);
    }
    if (!prefs.enabled)
      list.append(
        button(
          "clip.enable",
          () => void configure({ enabled: true }).catch(report),
        ),
      );
    if (morePages) list.append(button("clip.next", () => void search(true)));
    sync();
  }
  async function search(append = false, keepIndex?: number) {
    const token = ++revision,
      current = items[selected]?.id;
    try {
      const rows = await call<Item[]>("clip_search", {
        query: input.value,
        offset: append ? items.length : 0,
        kind: kindFilter === "all" ? null : kindFilter,
      });
      if (!alive || token !== revision) return;
      items = append ? [...items, ...rows] : rows;
      morePages = rows.length === 30;
      if (selectMode) {
        const visible = new Set(items.map((item) => item.id));
        for (const id of [...checkedIds]) {
          if (!visible.has(id)) checkedIds.delete(id);
        }
        lastCheckedIndex = null;
      }
      const found = items.findIndex((i) => i.id === current);
      if (found >= 0) selected = found;
      else if (keepIndex !== undefined && items.length)
        selected = Math.min(keepIndex, items.length - 1);
      else selected = 0;
      render();
    } catch (e) {
      report(e);
    }
  }
  function refresh() {
    if (alive && settings.hidden && detail.hidden && actions.hidden)
      void search();
  }
  input.oninput = () => {
    selected = 0;
    void search();
  };
  input.addEventListener("compositionstart", () => {
    composing = true;
  });
  input.addEventListener("compositionend", () => {
    composing = false;
  });
  panel.onkeydown = (e) => {
    e.stopPropagation();
    if (e.isComposing || composing || e.keyCode === 229) return;
    if (e.key === "Escape") {
      e.preventDefault();
      if (selectMode) setSelectMode(false);
      else if (!settings.hidden || !actions.hidden || !detail.hidden) home();
      else close();
      return;
    }
    const isQuickDelete = mac
      ? e.key === "Backspace" &&
        e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !e.shiftKey
      : e.key === "Delete" &&
        e.ctrlKey &&
        !e.metaKey &&
        !e.altKey &&
        !e.shiftKey;
    if (isQuickDelete) {
      if (
        !selectMode &&
        settings.hidden &&
        detail.hidden &&
        actions.hidden &&
        items[selected] &&
        !busy
      ) {
        e.preventDefault();
        if (!e.repeat) void edit("delete", items[selected].id);
      }
      return;
    }
    if (
      e.key === "Enter" &&
      (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey)
    ) {
      if (!settings.hidden || selectMode) return;
      e.preventDefault();
      if (
        !e.repeat &&
        !e.altKey &&
        !e.shiftKey &&
        (mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey)
      ) {
        void useEntry("clip_copy");
      }
      return;
    }
    if (e.target !== input) return;
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      selected = Math.max(
        0,
        Math.min(items.length - 1, selected + (e.key === "ArrowDown" ? 1 : -1)),
      );
      sync();
      list
        .querySelector('[aria-selected="true"]')
        ?.scrollIntoView({ block: "nearest" });
    }
    if (e.key === "Enter") {
      e.preventDefault();
      if (selectMode) toggleChecked(selected, e.shiftKey);
      else void useEntry("clip_paste");
    }
  };
  document.body.append(panel);
  document.documentElement.classList.add("clip-active");
  input.focus({ preventScroll: true });
  void call<Prefs>("clip_preferences")
    .then((v) => {
      if (alive) {
        prefs = v;
        refresh();
      }
    })
    .catch(report);
  return {
    preferences: (next: Prefs) => {
      prefs = next;
      refresh();
    },
    id: session.id,
    refresh,
    error: report,
    focus: () => input.focus({ preventScroll: true }),
    dispose: () => {
      alive = false;
      revision++;
      items = [];
      panel.remove();
      document.documentElement.classList.remove("clip-active");
    },
  };
}
