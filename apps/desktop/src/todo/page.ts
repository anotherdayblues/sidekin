// 待办 page in the studio (plan/27, plan/30): a line to add one, then
// 今天 · 以后 · 已完成, each in the order the user drags (drag.ts), then
// 伙伴大脑's scheduled tasks folded at the bottom. One not done from an
// earlier day carries on at the top of 今天, quietly. It takes the place of
// the 提醒 page; the block keeps its id "reminders".
import { t } from "../i18n.ts";
import { focusState, onFocus } from "../focus.ts";
import { onTodos, todos, type Group, type Todo } from "./api.ts";
import { todoRow } from "./row.ts";
import { openRowMenu } from "./rowActions.ts";
import type { MenuAt } from "./rowMenu.ts";
import { tidy } from "./drafts.ts";
import { sortable } from "./drag.ts";
import { quickLine } from "./quick.ts";
import "./todo.css";

/** Said once, the first time the page has rows to drag. */
const HINT_SEEN = "todo-drag-hint-seen";

const GROUPS: [Group, Parameters<typeof t>[0]][] = [
  ["today", "todo.today"],
  ["later", "todo.later"],
  ["done", "todo.done"],
];

/** `tasks`: the scheduled tasks of 伙伴大脑 (the old reminders list). */
export function todoPage(tasks: HTMLElement) {
  const page = document.createElement("section");
  page.className = "todo-page";
  page.innerHTML = `<div class="todo-new"><span class="todo-check" aria-hidden="true"></span><small class="todo-error" role="status"></small></div><div class="todo-lists"></div><details class="todo-tasks"><summary>${t("todo.tasks")}</summary><p class="silk">${t("todo.tasksNote")}</p></details>`;
  const form = page.querySelector<HTMLElement>(".todo-new")!;
  // One line, with the day, time and repeat it names filled into the
  // pickers under it, or picked by hand (quick.ts).
  const line = quickLine({ controls: true, tidy: todos.aiReady });
  form.querySelector(".todo-check")!.after(line.el);
  const error = form.querySelector<HTMLElement>(".todo-error")!;
  const lists = page.querySelector<HTMLElement>(".todo-lists")!;
  page.querySelector(".todo-tasks")!.append(tasks);
  // 整理成几条 (plan/31): the drafts open under the line.
  const drafts = document.createElement("div");
  drafts.className = "todo-drafts-slot";
  drafts.hidden = true;
  form.after(drafts);
  line.onTidy((text) => {
    hooks.editing(true);
    void tidy(drafts, text, {
      done(n) {
        hooks.editing(false);
        if (n) line.clear();
        void refresh();
      },
    });
  });
  line.onSubmit(async (f) => {
    try {
      await todos.add(f);
      line.clear();
      error.textContent = "";
      line.input.focus();
      await refresh();
    } catch (err) {
      error.textContent = String(err);
    }
  });

  let editing = 0;
  let seq = 0;
  async function refresh() {
    if (editing) return;
    const ticket = ++seq;
    const [all, focus, timer] = await Promise.all([
      todos.list(),
      todos.focusState().catch(() => ({ current: null, candidates: [] })),
      focusState(),
    ]);
    if (ticket !== seq || editing) return;
    // 专注中 only while a tomato runs: the one it was on last stays the
    // suggestion, on the 专注 page, but is not shown as running here.
    draw(all, timer.phase === "focus" ? (focus.current?.id ?? null) : null);
  }
  let ai = false;
  void todos.aiReady().then((on) => (ai = on));
  const hooks = {
    refresh: () => void refresh(),
    editing(on: boolean) {
      editing = Math.max(0, editing + (on ? 1 : -1));
    },
    /** A right click or the ⋯ on a row (rowActions.ts). */
    menu(row: HTMLElement, todo: Todo, at: MenuAt) {
      openRowMenu(row, todo, at, { ...hooks, focusing: null }, ai);
    },
  };
  sortable(lists, {
    hold: hooks.editing,
    drop: (id, to) =>
      void todos.move(id, to.today, to.before).then(refresh, refresh),
  });
  function draw(all: Todo[], focusing: number | null) {
    lists.replaceChildren();
    for (const [group, key] of GROUPS) {
      const items = all.filter((x) => x.group === group);
      // 今天 and 以后 are always there: a row can be dragged into either.
      if (!items.length && group === "done") continue;
      const box =
        group === "done"
          ? document.createElement("details")
          : document.createElement("section");
      box.className = "todo-group";
      box.dataset.group = group;
      const head = document.createElement(group === "done" ? "summary" : "h3");
      head.className = "todo-group-head";
      head.textContent = t(key);
      head.dataset.count = String(items.length);
      box.append(head);
      for (const x of items) box.append(todoRow(x, { ...hooks, focusing }));
      if (!items.length) {
        const empty = document.createElement("p");
        empty.className = "todo-empty";
        empty.textContent = t(
          group === "today" ? "todo.empty" : "todo.laterEmpty",
        );
        box.append(empty);
      }
      lists.append(box);
      if (group === "today") lists.append(...hint(all));
    }
    badge(all.filter((x) => x.group === "today").length);
  }
  /** How to drag, once: under 今天 the first time there is a row to drag. */
  function hint(all: Todo[]) {
    let seen = false;
    try {
      seen = localStorage.getItem(HINT_SEEN) === "1";
      if (!seen && all.some((x) => !x.doneAt))
        localStorage.setItem(HINT_SEEN, "1");
    } catch {
      seen = true;
    }
    if (seen || !all.some((x) => !x.doneAt)) return [];
    const p = document.createElement("p");
    p.className = "todo-hint";
    p.textContent = t("todo.dragHint");
    return [p];
  }
  /** How many are left for today, on the block's tab (skins choose
   * whether to show it). */
  function badge(n: number) {
    for (const e of document.querySelectorAll<HTMLElement>(
      '[data-block="reminders"][role="tab"]',
    )) {
      if (n) e.dataset.count = String(n);
      else delete e.dataset.count;
    }
  }
  // Groups change at midnight.
  function atMidnight() {
    const next = new Date();
    next.setHours(24, 0, 1, 0);
    setTimeout(() => {
      void refresh();
      atMidnight();
    }, next.getTime() - Date.now());
  }
  atMidnight();
  void onTodos(() => void refresh());
  void onFocus(() => void refresh());
  return { page, refresh };
}
