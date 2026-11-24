import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { watchCaret } from "./caretLook.ts";
import { dateLocale, t, type Key } from "./i18n.ts";
import { glyphs } from "./icons.ts";
import {
  clipSettings,
  defaultClipPrefs,
  formatBytes,
  retentionLabel,
  type ClipCall,
  type ClipDetail,
  type ClipEntry,
  type ClipFilter,
  type ClipImageUsage,
  type ClipPreferences,
} from "./clipboardSettings.ts";
import "./styles/clipboard-settings.css";
import "./styles/clipboard-memory.css";

export function mountClipboardMemory(
  section: HTMLElement,
  call: ClipCall = invoke,
) {
  section.classList.add("memory-clipboard");
  section.innerHTML = `<header class="memory-pane-head"><div><h3></h3><p data-record-status></p></div><button type="button" data-options aria-expanded="false"></button></header>
    <div data-config hidden></div><div class="clip-memory-toolbar"><input type="search" class="clip-memory-search"><div class="clip-memory-filters" role="tablist"><button type="button" role="tab" data-kind="all" aria-selected="true"></button><button type="button" role="tab" data-kind="text" aria-selected="false"></button><button type="button" role="tab" data-kind="image" aria-selected="false"></button></div><button type="button" class="clip-select-toggle" data-select-mode aria-pressed="false" hidden></button></div>
    <div class="clip-memory-batch" data-batch-bar hidden><button type="button" data-select-all></button><button type="button" class="clip-danger" data-delete-selected></button><button type="button" data-select-done></button></div>
    <ul class="memory-list"></ul><p class="memory-kind" data-empty hidden></p>
    <button type="button" data-next hidden></button><output role="status"></output>`;
  const el = <T extends HTMLElement>(q: string) => section.querySelector<T>(q)!;
  const input = el<HTMLInputElement>("input[type=search]"),
    filters = el<HTMLElement>(".clip-memory-filters"),
    selectToggle = el<HTMLButtonElement>("[data-select-mode]"),
    batchBar = el<HTMLElement>("[data-batch-bar]"),
    selectAllButton = el<HTMLButtonElement>("[data-select-all]"),
    deleteSelectedButton = el<HTMLButtonElement>("[data-delete-selected]"),
    selectDoneButton = el<HTMLButtonElement>("[data-select-done]"),
    ul = el<HTMLUListElement>("ul"),
    config = el<HTMLElement>("[data-config]"),
    options = el<HTMLButtonElement>("[data-options]"),
    next = el<HTMLButtonElement>("[data-next]"),
    empty = el<HTMLElement>("[data-empty]"),
    out = el<HTMLOutputElement>("output");
  el("h3").textContent = t("clip.memoryPage");
  options.textContent = t("clip.settings");
  input.placeholder = t("clip.search");
  input.setAttribute("aria-label", input.placeholder);
  watchCaret(input);
  next.textContent = t("clip.next");
  selectDoneButton.textContent = t("clip.selectDone");
  let prefs = defaultClipPrefs,
    items: ClipEntry[] = [],
    revision = 0,
    alive = true,
    busy = false,
    kindFilter: ClipFilter = "all",
    selectMode = false,
    lastCheckedIndex: number | null = null;
  const checkedIds = new Set<number>();
  const off: (() => void)[] = [];
  const date = new Intl.DateTimeFormat(dateLocale, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
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
      void search();
    };
  });
  const error = (e: unknown) => {
    if (alive) out.textContent = String(e);
  };
  function updateStatus() {
    el("[data-record-status]").textContent =
      t(prefs.enabled ? "clip.recording" : "clip.paused") +
      " · " +
      (prefs.retentionDays
        ? t("clip.keepDays", { days: prefs.retentionDays })
        : retentionLabel(0));
  }
  function closeSettings() {
    config.hidden = true;
    options.setAttribute("aria-expanded", "false");
  }
  async function showSettings() {
    if (!config.hidden) {
      closeSettings();
      return;
    }
    config.hidden = false;
    options.setAttribute("aria-expanded", "true");
    const render = (usage: ClipImageUsage | null) => {
      clipSettings(config, prefs, {
        error,
        back: closeSettings,
        usage,
        save: async (patch) => {
          prefs = await call<ClipPreferences>("clip_configure", {
            prefs: patch,
          });
          if (!alive) return;
          updateStatus();
          closeSettings();
          out.textContent = t("settings.saved");
          await search();
        },
        clear: async () => {
          await call("clip_edit", { action: "clear", id: null });
          if (alive) {
            closeSettings();
            await search();
          }
        },
      });
    };
    render(null);
    const usage = await call<ClipImageUsage>("clip_usage").catch(() => null);
    if (usage && alive && !config.hidden) {
      const elUsage = config.querySelector<HTMLElement>(".clip-option-usage");
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
  options.onclick = () => void showSettings();
  function syncBatch() {
    selectToggle.hidden = !items.length && !selectMode;
    selectToggle.textContent = t(
      selectMode ? "clip.selectDone" : "clip.selectMode",
    );
    selectToggle.setAttribute("aria-pressed", String(selectMode));
    batchBar.hidden = !selectMode;
    if (!selectMode) return;
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
  function renderRows() {
    ul.replaceChildren(...items.map((item, idx) => row(item, idx)));
    syncBatch();
  }
  function setSelectMode(on: boolean) {
    if (selectMode === on) return;
    selectMode = on;
    checkedIds.clear();
    lastCheckedIndex = null;
    section.dataset.selectMode = String(on);
    renderRows();
  }
  function toggleChecked(index: number, shiftKey: boolean) {
    const item = items[index];
    if (!item) return;
    const nextState = !checkedIds.has(item.id);
    if (shiftKey && lastCheckedIndex !== null) {
      const start = Math.min(lastCheckedIndex, index);
      const end = Math.max(lastCheckedIndex, index);
      for (let idx = start; idx <= end; idx++) {
        const entry = items[idx];
        if (!entry) continue;
        if (nextState) checkedIds.add(entry.id);
        else checkedIds.delete(entry.id);
      }
    } else if (nextState) {
      checkedIds.add(item.id);
    } else {
      checkedIds.delete(item.id);
    }
    lastCheckedIndex = index;
    renderRows();
  }
  selectToggle.onclick = () => setSelectMode(!selectMode);
  selectDoneButton.onclick = () => setSelectMode(false);
  selectAllButton.onclick = () => {
    if (!items.length) return;
    const allChecked = items.every((item) => checkedIds.has(item.id));
    if (allChecked) checkedIds.clear();
    else for (const item of items) checkedIds.add(item.id);
    lastCheckedIndex = null;
    renderRows();
  };
  deleteSelectedButton.onclick = async () => {
    const ids = items.filter((i) => checkedIds.has(i.id)).map((i) => i.id);
    if (!ids.length || busy) return;
    busy = true;
    syncBatch();
    try {
      await call("clip_delete_batch", { ids });
      checkedIds.clear();
      lastCheckedIndex = null;
      await search();
      if (!items.length) setSelectMode(false);
    } catch (e) {
      error(e);
    } finally {
      busy = false;
      syncBatch();
    }
  };
  function action(key: Key, run: () => Promise<void>) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t(key);
    b.onclick = () => void run().catch(error);
    return b;
  }
  function row(item: ClipEntry, index: number) {
    const isImage = item.kind === "image";
    const li = document.createElement("li");
    li.className = isImage ? "memory-entry clip-memory-image-entry" : "memory-entry";
    const checked = selectMode && checkedIds.has(item.id);
    if (checked) li.dataset.checked = "true";
    if (selectMode) {
      const check = document.createElement("input");
      check.type = "checkbox";
      check.className = "clip-check";
      check.checked = checked;
      check.setAttribute("aria-label", item.preview || t("clip.imageLabel"));
      check.onclick = (e) => {
        e.stopPropagation();
        toggleChecked(index, e.shiftKey);
      };
      li.append(check);
    }
    const body = document.createElement("div");
    body.className = "memory-entry-body";
    const preview = document.createElement("button");
    preview.type = "button";
    preview.className = isImage
      ? "clip-memory-preview clip-memory-preview-image"
      : "clip-memory-preview";
    const dims = item.width && item.height ? `${item.width}×${item.height}` : "";
    const title = isImage
      ? item.ocrPreview ||
        (dims ? `${t("clip.imageLabel")} · ${dims}` : t("clip.imageLabel"))
      : item.preview;
    if (isImage) {
      const thumb = document.createElement("span");
      thumb.className = "clip-memory-thumb";
      if (item.thumb) {
        const img = document.createElement("img");
        img.src = item.thumb;
        img.alt = "";
        thumb.append(img);
      } else {
        thumb.innerHTML = glyphs.image;
      }
      const labelSpan = document.createElement("span");
      labelSpan.textContent = title;
      preview.append(thumb, labelSpan);
    } else {
      preview.textContent = title;
    }
    preview.setAttribute("aria-expanded", "false");
    const meta = document.createElement("small");
    meta.className = "memory-kind";
    const source = item.source.endsWith(".exe")
      ? item.source.slice(0, -4)
      : item.source.split(".").at(-1) || item.source;
    meta.textContent = [
      item.pinned ? t("clip.pinned") : "",
      isImage && item.ocrPreview ? dims : "",
      isImage && item.bytes ? formatBytes(item.bytes) : "",
      source,
      date.format(item.at),
    ]
      .filter(Boolean)
      .join(" · ");
    body.append(preview, meta);
    const full = document.createElement(isImage ? "div" : "pre");
    if (isImage) full.className = "clip-memory-detail";
    full.hidden = true;
    preview.onclick = async (e) => {
      if (selectMode) {
        toggleChecked(index, e.shiftKey);
        return;
      }
      if (!full.hidden) {
        full.hidden = true;
        preview.setAttribute("aria-expanded", "false");
        return;
      }
      try {
        if (!isImage) {
          full.textContent = await call<string>("clip_full", { id: item.id });
        } else {
          const info = await call<ClipDetail>("clip_detail", { id: item.id });
          const nodes: Node[] = [];
          if (info.imageDataUrl) {
            const img = document.createElement("img");
            img.src = info.imageDataUrl;
            img.alt = title;
            nodes.push(img);
          }
          if (info.ocr) {
            const pre = document.createElement("pre");
            pre.textContent = info.ocr;
            nodes.push(
              pre,
              action("clip.copyOcr", async () => {
                await call("clip_copy_text", { text: info.ocr });
                if (alive) out.textContent = t("common.copied");
              }),
            );
          }
          full.replaceChildren(...nodes);
        }
        full.hidden = false;
        preview.setAttribute("aria-expanded", "true");
      } catch (e) {
        error(e);
      }
    };
    const controls = document.createElement("div");
    controls.className = "clip-memory-actions";
    const copy = action("clip.copyOnly", async () => {
      await call("clip_copy", { id: item.id, session: null });
      if (alive) out.textContent = t("common.copied");
    });
    const menu = document.createElement("details"),
      summary = document.createElement("summary"),
      choices = document.createElement("div");
    menu.name = "clip-memory-actions";
    summary.textContent = "···";
    summary.setAttribute("aria-label", t("clip.more") + " · " + title);
    choices.className = "clip-memory-choices";
    const edit = async (kind: "pin" | "delete") => {
      await call("clip_edit", { action: kind, id: item.id });
      await search();
    };
    const quickDelete = document.createElement("button");
    quickDelete.type = "button";
    quickDelete.className = "clip-memory-delete";
    quickDelete.dataset.quickDelete = "";
    quickDelete.innerHTML = glyphs.trash;
    quickDelete.title = t("clip.delete");
    quickDelete.setAttribute("aria-label", t("clip.delete") + " · " + title);
    quickDelete.onclick = () => void edit("delete").catch(error);
    choices.append(
      action(item.pinned ? "clip.unpin" : "clip.pin", () => edit("pin")),
      action("clip.delete", () => edit("delete")),
    );
    menu.append(summary, choices);
    controls.append(copy, quickDelete, menu);
    li.append(body, controls, full);
    return li;
  }
  async function search(append = false) {
    const gen = ++revision;
    try {
      const rows = await call<ClipEntry[]>("clip_search", {
        query: input.value,
        offset: append ? items.length : 0,
        kind: kindFilter === "all" ? null : kindFilter,
      });
      if (!alive || gen !== revision) return;
      if (append) {
        const start = items.length;
        items.push(...rows);
        ul.append(...rows.map((item, i) => row(item, start + i)));
      } else {
        items = rows;
        if (selectMode) {
          const visible = new Set(items.map((item) => item.id));
          for (const id of [...checkedIds]) {
            if (!visible.has(id)) checkedIds.delete(id);
          }
          lastCheckedIndex = null;
        }
        ul.replaceChildren(...rows.map((item, i) => row(item, i)));
      }
      syncBatch();
      next.hidden = rows.length !== 30;
      empty.hidden = items.length !== 0;
      empty.textContent = t(
        input.value || kindFilter !== "all"
          ? "clip.noMatch"
          : prefs.enabled
            ? "clip.empty"
            : "clip.intro",
      );
    } catch (e) {
      error(e);
    }
  }
  input.oninput = () => void search();
  next.onclick = () => void search(true);
  const observe = async <T>(event: string, fn: (payload: T) => void) => {
    const stop = await listen<T>(event, (e) => {
      if (alive) fn(e.payload);
    });
    if (alive) off.push(stop);
    else stop();
  };
  if (isTauri()) {
    void observe<void>("clip-updated", () => void search()).catch(error);
    void observe<ClipPreferences>("clip-preferences-updated", (value) => {
      prefs = value;
      updateStatus();
      void search();
    }).catch(error);
  }
  void call<ClipPreferences>("clip_preferences")
    .then((value) => {
      if (alive) {
        prefs = value;
        updateStatus();
        void search();
      }
    })
    .catch(error);
  return () => {
    alive = false;
    revision++;
    off.forEach((stop) => stop());
    section.replaceChildren();
  };
}
