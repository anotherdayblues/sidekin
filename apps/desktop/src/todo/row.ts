// One to-do in the 待办 page: the ⋮⋮ to drag it by, the round check, the
// title and when, the tomatoes, and what can be done with it; and its
// editor, in place.
import { clearLook, watchCaret } from "../caretLook.ts";
import { t, tn } from "../i18n.ts";
import {
  carriedLabel,
  dayLabel,
  repeatLabel,
  REPEATS,
  todos,
  type Fields,
  type Todo,
} from "./api.ts";
import "./quick.css";
import "./row-keys.css";

/** How long a checked one stays struck through before it goes, so a slip
 * can be taken back (as Things and 提醒事项 do). */
export const LEAVE_MS = 1200;
/** How long a deleted one can be taken back (Super Productivity, Todoist
 * and Gmail all say "deleted" with an undo for a few seconds rather than
 * asking first). */
export const UNDO_MS = 4000;
/** Tomatoes drawn before the rest go into a number. */
const TOMATO_DOTS = 6;

export interface RowHooks {
  /** A change saved: draw the list again. */
  refresh(): void;
  /** Editing started or ended: hold redraws meanwhile. */
  editing(on: boolean): void;
  /** Shown as the one the running tomato is on. */
  focusing: number | null;
  /** A right click: the row's menu (rowMenu.ts, plan/31). */
  menu?(
    row: HTMLElement,
    todo: Todo,
    at: { x: number; y: number; above?: number },
  ): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string,
  text = "",
) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}
function button(className: string, label: string, act?: string) {
  const b = el("button", className, label);
  b.type = "button";
  if (act) b.dataset.act = act;
  return b;
}

/** The pencil, the ⋯ and the × on a row under the pointer, the same on the
 * page and in the bubble (row-keys.css). A done one has only the ×. */
/** Where a menu opened by a key goes: under it, from its left edge. */
export function under(key: HTMLElement) {
  const r = key.closest("button")!.getBoundingClientRect();
  return { x: r.left, y: r.bottom + 4, above: r.top - 4 };
}
export function rowKeys(done: boolean) {
  const keys: HTMLButtonElement[] = [];
  if (!done) {
    const pencil = button("todo-edit-key", "", "edit");
    pencil.setAttribute("aria-label", t("common.editLong"));
    pencil.title = t("common.editLong");
    keys.push(pencil);
  }
  if (!done) {
    const more = button("todo-more-key", "", "more");
    more.setAttribute("aria-label", t("todo.more"));
    more.title = t("todo.more");
    more.setAttribute("aria-haspopup", "menu");
    keys.push(more);
  }
  const del = button("todo-del-key", "", "delete");
  del.setAttribute("aria-label", t("common.delete"));
  del.title = t("common.delete");
  keys.push(del);
  return keys;
}

/** Deleted, with 撤销 for a moment; gone for good after it. `hold` keeps
 * the list from being drawn again meanwhile. */
export function removeLater(
  row: HTMLElement,
  id: number,
  o: { done(): void; hold?(on: boolean): void },
) {
  const was = row.dataset.state ?? "open";
  row.dataset.state = "removed";
  const note = el("span", "todo-removed");
  const undo = button("todo-undo", t("common.undo"));
  note.append(el("span", "", t("todo.deleted")), undo);
  row.append(note);
  o.hold?.(true);
  const timer = window.setTimeout(() => {
    o.hold?.(false);
    void todos.remove(id).then(o.done, o.done);
  }, UNDO_MS);
  undo.onclick = (e) => {
    e.stopPropagation();
    clearTimeout(timer);
    note.remove();
    row.dataset.state = was;
    o.hold?.(false);
  };
}

export function todoRow(todo: Todo, hooks: RowHooks): HTMLElement {
  const row = el("div", "todo-row");
  row.dataset.id = String(todo.id);
  row.dataset.group = todo.group;
  row.dataset.state = todo.doneAt ? "done" : "open";
  if (todo.due) row.dataset.due = "";
  if (hooks.focusing === todo.id) row.dataset.focusing = "";

  const check = button("todo-check", "");
  check.setAttribute("role", "checkbox");
  check.setAttribute("aria-checked", String(!!todo.doneAt));
  check.setAttribute(
    "aria-label",
    todo.doneAt ? t("todo.reopen") : t("todo.complete"),
  );

  // Dragged by this, always there and faint (drag.ts).
  const grip = button("todo-grip", "");
  grip.setAttribute("aria-label", t("todo.drag"));
  grip.title = t("todo.drag");

  const main = el("span", "todo-main");
  main.append(el("span", "todo-title", todo.title));
  const meta = el("small", "todo-meta");
  if (hooks.focusing === todo.id)
    meta.append(el("span", "todo-now", t("todo.focusing")));
  if (todo.carried && todo.day)
    meta.append(el("span", "todo-carried", carriedLabel(todo.day)));
  else if (todo.day && (todo.group !== "today" || todo.doneAt))
    meta.append(el("span", "todo-day", dayLabel(todo.day)));
  // A time is when to remind, with a bell (plan/30).
  if (todo.time) meta.append(el("span", "todo-time", todo.time));
  if (todo.repeat)
    meta.append(el("span", "todo-repeat", repeatLabel(todo.repeat)));
  if (meta.childElementCount) main.append(meta);

  const tomatoes = el("span", "todo-tomatoes");
  if (todo.tomatoes) {
    tomatoes.setAttribute("aria-label", tn("todo.tomatoes", todo.tomatoes));
    for (let i = 0; i < Math.min(todo.tomatoes, TOMATO_DOTS); i++)
      tomatoes.append(el("i", ""));
    if (todo.tomatoes > TOMATO_DOTS)
      tomatoes.append(el("b", "", "+" + (todo.tomatoes - TOMATO_DOTS)));
  }

  // On the row 开始专注, a pencil and an ×, as in the bubble; the rest is a
  // right click away (plan/31). A double click on the title also edits.
  const acts = el("span", "todo-acts");
  if (!todo.doneAt && todo.group === "today" && hooks.focusing !== todo.id)
    acts.append(button("todo-focus", t("todo.startFocus"), "focus"));
  acts.append(...rowKeys(!!todo.doneAt));
  if (!todo.doneAt) row.append(grip);
  row.append(check, main, tomatoes, acts);

  // Checked: struck through at once, gone after a moment; a second click
  // in that moment takes it back. From 已完成, back at once.
  let leaving = 0;
  check.onclick = () => {
    if (todo.doneAt) {
      void todos.reopen(todo.id).then(hooks.refresh);
      return;
    }
    if (leaving) {
      clearTimeout(leaving);
      leaving = 0;
      row.dataset.state = "open";
      check.setAttribute("aria-checked", "false");
      hooks.editing(false);
      return;
    }
    row.dataset.state = "leaving";
    check.setAttribute("aria-checked", "true");
    hooks.editing(true);
    leaving = window.setTimeout(() => {
      leaving = 0;
      hooks.editing(false);
      void todos.complete(todo.id).then(hooks.refresh, hooks.refresh);
    }, LEAVE_MS);
  };
  acts.onclick = (e) => {
    const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
      ?.dataset.act;
    if (act === "focus") void todos.focus(todo.id).then(hooks.refresh);
    if (act === "edit") edit(row, todo, hooks);
    if (act === "more") hooks.menu?.(row, todo, under(e.target as HTMLElement));
    if (act === "delete")
      removeLater(row, todo.id, { done: hooks.refresh, hold: hooks.editing });
  };
  // The title is changed where it is, by a double click (as a pet's name).
  if (!todo.doneAt)
    main
      .querySelector(".todo-title")!
      .addEventListener("dblclick", () => edit(row, todo, hooks));
  row.addEventListener("contextmenu", (e) => {
    if (!hooks.menu || row.dataset.state === "editing") return;
    e.preventDefault();
    hooks.menu(row, todo, { x: e.clientX, y: e.clientY });
  });
  return row;
}

/** The when-fields of a form: a date, a time and a repeat. */
export function whenFields(todo?: Partial<Todo>) {
  const wrap = el("span", "todo-when");
  const day = el("input", "");
  day.type = "date";
  day.name = "day";
  day.value = todo?.day ?? "";
  day.setAttribute("aria-label", t("todo.date"));
  const time = el("input", "");
  time.type = "time";
  time.name = "time";
  time.value = todo?.time ?? "";
  time.setAttribute("aria-label", t("todo.time"));
  time.title = t("todo.time");
  const repeat = el("select", "");
  repeat.name = "repeat";
  repeat.setAttribute("aria-label", t("todo.repeat"));
  for (const [value, key] of REPEATS) {
    const o = el("option", "", t(key));
    o.value = value;
    repeat.append(o);
  }
  repeat.value = todo?.repeat ?? "";
  wrap.append(day, time, repeat);
  return {
    wrap,
    read: (): Fields => ({
      day: day.value,
      time: time.value,
      repeat: repeat.value as Fields["repeat"],
    }),
  };
}

/** The row turned into its editor, in place. */
export function edit(row: HTMLElement, todo: Todo, hooks: RowHooks) {
  hooks.editing(true);
  const form = el("form", "todo-edit");
  const title = el("input", "todo-edit-title");
  title.name = "title";
  title.value = todo.title;
  title.maxLength = 200;
  title.setAttribute("aria-label", t("todo.title"));
  watchCaret(title);
  const when = whenFields(todo);
  const save = button("primary", t("common.save"));
  save.type = "submit";
  const cancel = button("", t("common.cancel"));
  const error = el("small", "todo-error");
  form.append(title, when.wrap, save, cancel, error);
  row.replaceChildren(form);
  row.dataset.state = "editing";
  title.focus();
  const close = () => {
    clearLook();
    hooks.editing(false);
    hooks.refresh();
  };
  cancel.onclick = close;
  form.onkeydown = (e) => {
    if (e.key === "Escape") close();
  };
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await todos.update(todo.id, { title: title.value, ...when.read() });
      close();
    } catch (err) {
      error.textContent = String(err);
    }
  };
}
