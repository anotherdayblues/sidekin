// DOM for a folded stack and its expanded list. State lives in piles.ts.
import { t, tn } from "../i18n.ts";
import { nativeFileGesture } from "./nativeGesture.ts";
import { mac, native } from "./bridge.ts";
import { rangeSelection } from "./vendor/droper/selection.ts";
import { fileType, type FileMeta } from "./fileTypes.ts";
import { formatSize } from "./fileSize.ts";
import type { ShelfItem } from "./vendor/droper/shelfStore.ts";

export interface Selection {
  paths: Set<string>;
  anchor: string | null;
}
/** The click that ends a drag must not also toggle; holds the dragged key. */
export interface ClickGuard {
  suppress: string | null;
}
type Drag = (
  event: DragEvent | null,
  paths: string[],
  held?: () => boolean,
) => Promise<void>;
/** Right click (fileMenu.ts) and 发到手机 (the panel's button). */
type Menu = (event: MouseEvent, paths: string[]) => void;

export function buildPile(
  item: ShelfItem,
  metadata: Map<string, FileMeta>,
  click: ClickGuard,
  actions: {
    toggle(): void;
    drag: Drag;
    remove(paths: string[]): void;
    menu: Menu;
  },
) {
  const group = document.createElement("div");
  group.className = "pile";
  group.dataset.id = item.id;
  // 手机传文件: 随伴's own files, from the phone, wear a phone mark.
  group.toggleAttribute("data-phone", item.snippet);
  const front = document.createElement("button");
  front.type = "button";
  front.className = "pile-top";
  front.draggable = !native;
  front.title = item.paths.join("\n");
  front.setAttribute(
    "aria-label",
    item.paths.length > 1
      ? tn("files.heldCount", item.paths.length)
      : item.name,
  );
  const papers = cover(item, metadata);
  const count = document.createElement("span");
  count.className = "count";
  count.textContent = String(item.paths.length);
  const label = document.createElement("span");
  label.className = "file-name";
  label.textContent =
    item.paths.length > 1 ? tn("files.count", item.paths.length) : item.name;
  front.append(papers, count, label);
  front.onpointerdown = () => {
    click.suppress = null;
  };
  front.oncontextmenu = (e) => actions.menu(e, item.paths);
  front.onclick = () => {
    if (click.suppress === item.id) {
      click.suppress = null;
      return;
    }
    actions.toggle();
  };
  if (native)
    nativeFileGesture(front, (held) => {
      click.suppress = item.id;
      return actions.drag(null, item.paths, held);
    });
  else
    front.ondragstart = (e) => {
      click.suppress = item.id;
      void actions.drag(e, item.paths);
    };
  const remove = document.createElement("button");
  remove.className = "remove";
  remove.textContent = "×";
  remove.title = t("files.remove");
  remove.onpointerdown = (e) => e.stopPropagation();
  remove.onclick = (e) => {
    e.stopPropagation();
    actions.remove(item.paths);
  };
  group.append(front, remove);
  return group;
}

/** A fan of up to three sheets, one per kind of file, so a mixed stack
 *  shows what is in it. The first file stays on top. */
function cover(item: ShelfItem, metadata: Map<string, FileMeta>) {
  const papers = document.createElement("span");
  papers.className = "papers";
  const seen = new Set<string>();
  const shown = [];
  for (const path of item.paths) {
    const type = fileType(path, metadata.get(path));
    if (seen.has(type.kind)) continue;
    seen.add(type.kind);
    shown.push(type);
    if (shown.length === 3) break;
  }
  // A stack of one kind still looks like a stack.
  while (item.paths.length > shown.length && shown.length < 3)
    shown.push(shown[0]);
  for (const type of shown.reverse()) {
    const sheet = document.createElement("span");
    sheet.className = "sheet";
    const icon = document.createElement("img");
    icon.className = "pile-icon";
    icon.src = type.icon;
    icon.alt = type.label;
    icon.draggable = false;
    sheet.append(icon);
    papers.append(sheet);
  }
  return papers;
}

interface PanelActions {
  drag: Drag;
  remove(paths: string[]): void;
  refresh(): void;
  menu: Menu;
  send(paths: string[]): void;
}

export function buildPanel(
  item: ShelfItem,
  metadata: Map<string, FileMeta>,
  selection: Selection,
  click: ClickGuard,
  actions: PanelActions,
) {
  const panel = document.createElement("div");
  panel.className = "file-panel";
  panel.style.visibility = "hidden";
  // A small Finder / Explorer window: a header, column titles, then rows.
  const head = document.createElement("div");
  head.className = "panel-head";
  const title = document.createElement("strong");
  title.className = "panel-title";
  title.textContent = t("files.title");
  const count = document.createElement("span");
  count.className = "selection-count";
  const erase = document.createElement("button");
  erase.textContent = t("files.removeSelected");
  erase.className = "remove-selected";
  erase.onclick = () =>
    actions.remove(item.paths.filter((p) => selection.paths.has(p)));
  // 发到手机: the chosen files, or all of them when none is chosen.
  const phone = document.createElement("button");
  phone.textContent = t("files.sendPhone");
  phone.className = "send-phone";
  phone.onclick = () => {
    const chosen = item.paths.filter((p) => selection.paths.has(p));
    actions.send(chosen.length ? chosen : item.paths);
  };
  // Two buttons at most: 移除 shows only once something is chosen.
  head.append(title, count, phone, erase);
  const columns = document.createElement("div");
  columns.className = "file-columns";
  // Choose all or none, like the box over a mail list's checkboxes.
  const every = document.createElement("input");
  every.type = "checkbox";
  every.className = "all-check";
  every.setAttribute("aria-label", t("files.selectAll"));
  every.onchange = () => {
    selection.paths = every.checked ? new Set(item.paths) : new Set();
    actions.refresh();
  };
  columns.append(every);
  for (const name of [t("files.name"), t("files.kind"), t("files.size")]) {
    const cell = document.createElement("span");
    cell.textContent = name;
    cell.setAttribute("aria-hidden", "true");
    columns.append(cell);
  }
  const list = document.createElement("div");
  list.className = "file-list";
  list.setAttribute("role", "listbox");
  list.setAttribute("aria-multiselectable", "true");
  for (const path of item.paths)
    list.append(fileRow(item, path, metadata, selection, click, actions));
  panel.append(head, columns, list);
  return panel;
}

function fileRow(
  item: ShelfItem,
  path: string,
  metadata: Map<string, FileMeta>,
  selection: Selection,
  click: ClickGuard,
  actions: PanelActions,
) {
  const file = document.createElement("div");
  file.className = "file";
  file.draggable = !native;
  file.tabIndex = 0;
  file.dataset.path = path;
  file.setAttribute("role", "option");
  const type = fileType(path, metadata.get(path));
  const name = document.createElement("span");
  name.className = "entry-name";
  name.textContent = type.name;
  const kind = document.createElement("span");
  kind.className = "entry-type";
  kind.textContent = type.kindLabel;
  const size = document.createElement("span");
  size.className = "entry-size";
  size.textContent = formatSize(metadata.get(path)?.size, mac);
  const icon = document.createElement("img");
  icon.className = "file-icon";
  icon.src = type.icon;
  icon.alt = type.label;
  icon.draggable = false;
  file.dataset.type = type.kind;
  const check = document.createElement("input");
  check.type = "checkbox";
  check.className = "file-check";
  check.setAttribute(
    "aria-label",
    t("files.selectOne", { name: name.textContent ?? "" }),
  );
  check.onpointerdown = (e) => {
    click.suppress = null;
    e.stopPropagation();
  };
  check.onclick = (e) => e.stopPropagation();
  check.onchange = () => {
    if (check.checked) selection.paths.add(path);
    else selection.paths.delete(path);
    selection.anchor = path;
    actions.refresh();
  };
  const eraseOne = document.createElement("button");
  eraseOne.className = "file-remove";
  eraseOne.textContent = "×";
  eraseOne.draggable = false;
  eraseOne.setAttribute(
    "aria-label",
    t("files.removeOne", { name: name.textContent ?? "" }),
  );
  eraseOne.title = t("files.removeThis");
  eraseOne.onpointerdown = (e) => e.stopPropagation();
  eraseOne.onclick = (e) => {
    e.stopPropagation();
    actions.remove([path]);
  };
  file.append(check, icon, name, kind, size, eraseOne);
  file.title = path;
  file.onpointerdown = () => {
    click.suppress = null;
  };
  // A right click on a file outside the selection is about that file alone.
  file.oncontextmenu = (e) => {
    if (!selection.paths.has(path)) {
      selection.paths = new Set([path]);
      selection.anchor = path;
      actions.refresh();
    }
    actions.menu(
      e,
      item.paths.filter((p) => selection.paths.has(p)),
    );
  };
  file.onclick = (e) => {
    if (click.suppress === path) {
      click.suppress = null;
      return;
    }
    if (e.shiftKey)
      selection.paths = new Set(
        rangeSelection(item.paths, selection.anchor, path),
      );
    else if (selection.paths.has(path)) selection.paths.delete(path);
    else selection.paths.add(path);
    selection.anchor = path;
    actions.refresh();
  };
  const dragFile = (event: DragEvent | null, held?: () => boolean) => {
    click.suppress = path;
    if (!selection.paths.has(path)) {
      selection.paths = new Set([path]);
      selection.anchor = path;
      actions.refresh();
    }
    return actions.drag(
      event,
      item.paths.filter((p) => selection.paths.has(p)),
      held,
    );
  };
  if (native) nativeFileGesture(file, (held) => dragFile(null, held));
  else
    file.ondragstart = (e) => {
      e.stopPropagation();
      if ((e.target as HTMLElement).closest("button,input")) {
        e.preventDefault();
        return;
      }
      void dragFile(e);
    };
  return file;
}

export function refreshTypes(
  root: HTMLElement,
  items: ShelfItem[],
  metadata: Map<string, FileMeta>,
) {
  for (const row of root.querySelectorAll<HTMLElement>(".file")) {
    const path = row.dataset.path!,
      type = fileType(path, metadata.get(path));
    row.dataset.type = type.kind;
    const img = row.querySelector<HTMLImageElement>(".file-icon");
    if (img) {
      img.src = type.icon;
      img.alt = type.label;
    }
    const label = row.querySelector(".entry-type");
    if (label) label.textContent = type.kindLabel;
    const size = row.querySelector(".entry-size");
    if (size) size.textContent = formatSize(metadata.get(path)?.size, mac);
  }
  for (const group of root.querySelectorAll<HTMLElement>(".pile")) {
    const item = items.find((i) => i.id === group.dataset.id);
    if (item)
      group.querySelector(".papers")?.replaceWith(cover(item, metadata));
  }
}

export function refreshSelection(root: HTMLElement, selected: Set<string>) {
  for (const el of root.querySelectorAll<HTMLElement>(".file")) {
    const on = selected.has(el.dataset.path!);
    el.classList.toggle("selected", on);
    el.setAttribute("aria-selected", String(on));
    const check = el.querySelector<HTMLInputElement>(".file-check");
    if (check) check.checked = on;
  }
  const count = root.querySelector(".selection-count");
  const total = root.querySelectorAll(".file").length;
  if (count)
    count.textContent =
      tn("files.items", total) +
      (selected.size ? tn("files.selected", selected.size) : "");
  const every = root.querySelector<HTMLInputElement>(".all-check");
  if (every) {
    every.checked = total > 0 && selected.size === total;
    every.indeterminate = selected.size > 0 && selected.size < total;
  }
  const erase = root.querySelector<HTMLButtonElement>(".remove-selected");
  if (erase) erase.hidden = selected.size === 0;
}
