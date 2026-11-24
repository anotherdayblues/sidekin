// What a to-do can do, from its right-click menu or its ⋯ key (plan/31),
// the same on the 待办 page and in the bubble: move it to 今天 or 以后,
// 帮我拆一下 (with 伙伴大脑 on), edit, start a tomato on it, delete.
import { todos, type Todo } from "./api.ts";
import { breakDown } from "./drafts.ts";
import { edit, removeLater, type RowHooks } from "./row.ts";
import { rowMenu, type MenuAt, type RowAct } from "./rowMenu.ts";

/** Opens the menu for `todo` at `at`. `ai`: 伙伴大脑 is on, so it can be
 * broken down. */
export function openRowMenu(
  row: HTMLElement,
  todo: Todo,
  at: MenuAt,
  hooks: RowHooks,
  ai: boolean,
) {
  const open = !todo.doneAt;
  const move: RowAct[] = !open
    ? []
    : [todo.group === "later" ? "today" : "later"];
  if (open && ai) move.push("break");
  const work: RowAct[] = open ? ["edit"] : [];
  if (open && todo.group === "today") work.push("focus");
  // In the bubble the menu stays on its card: the window is only that big.
  const card = row.closest(".bubble-card")?.getBoundingClientRect();
  rowMenu(
    at,
    [move, work, ["delete"]],
    (act) => {
      if (act === "today" || act === "later")
        void todos.move(todo.id, act === "today", null).then(hooks.refresh);
      if (act === "edit") edit(row, todo, { ...hooks, focusing: null });
      if (act === "focus") void todos.focus(todo.id).then(hooks.refresh);
      if (act === "delete")
        removeLater(row, todo.id, { done: hooks.refresh, hold: hooks.editing });
      if (act === "break") {
        // In a list the drafts go in a row of their own.
        const slot = document.createElement(
          row.tagName === "LI" ? "li" : "div",
        );
        slot.className = "todo-drafts-slot todo-break-slot";
        row.after(slot);
        hooks.editing(true);
        void breakDown(slot, todo, (replaced) => {
          slot.remove();
          hooks.editing(false);
          if (replaced)
            removeLater(row, todo.id, {
              done: hooks.refresh,
              hold: hooks.editing,
            });
          else hooks.refresh();
        });
      }
    },
    card,
  );
}
