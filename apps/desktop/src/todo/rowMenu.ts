// A right click on a to-do in the 待办 page (plan/31): what a row can do,
// out of the way until asked for (提醒事项, Things). Only 开始专注 shows on
// the row itself.
import "./todo-ai.css";
import { t, type Key } from "../i18n.ts";
import { petMark } from "./petMark.ts";

export type RowAct = "today" | "later" | "break" | "edit" | "focus" | "delete";

let open: HTMLElement | null = null;
function close() {
  open?.remove();
  open = null;
  removeEventListener("pointerdown", outside, true);
  removeEventListener("keydown", escape, true);
  removeEventListener("blur", close);
}
function outside(e: Event) {
  if (open && !open.contains(e.target as Node)) close();
}
function escape(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    close();
  }
}

/** Where a menu opens: at the pointer, or under a key (`above`: the key's
 * top, to open upward when there is no room below). */
export type MenuAt = { x: number; y: number; above?: number };

/** Opens the menu at `at`, inside `within` (the window by default); `items`
 * are groups split by a line. */
export function rowMenu(
  at: MenuAt,
  items: RowAct[][],
  pick: (act: RowAct) => void,
  within?: DOMRect,
) {
  close();
  const menu = document.createElement("div");
  menu.className = "todo-menu";
  menu.setAttribute("role", "menu");
  const label: Record<RowAct, Key> = {
    today: "todo.moveToday",
    later: "todo.moveLater",
    break: "todo.aiBreak",
    edit: "common.editLong",
    focus: "todo.startFocus",
    delete: "todo.remove",
  };
  items
    .filter((g) => g.length)
    .forEach((group, i) => {
      if (i) menu.append(document.createElement("hr"));
      for (const act of group) {
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "menuitem");
        b.dataset.act = act;
        // Every item keeps room for a mark; 帮我拆一下 has the pet's face in
        // it. The room is its own box: the face stays hidden until drawn,
        // and a hidden element takes no room.
        const mark = document.createElement("i");
        mark.className = "todo-menu-mark";
        if (act === "break") mark.append(petMark());
        b.append(mark, document.createTextNode(t(label[act])));
        b.onclick = () => {
          close();
          pick(act);
        };
        menu.append(b);
      }
    });
  document.body.append(menu);
  // Inside the window (or `within`, the bubble's card), beside the pointer
  // or under the key; over the key when there is no room under it.
  const r = menu.getBoundingClientRect();
  const box = within ?? new DOMRect(0, 0, innerWidth, innerHeight);
  const left = Math.min(at.x, box.right - r.width - 8);
  const fits = at.y + r.height <= box.bottom - 8;
  const top = fits
    ? at.y
    : at.above !== undefined
      ? at.above - r.height
      : box.bottom - r.height - 8;
  menu.style.left = `${Math.max(box.left + 8, left)}px`;
  menu.style.top = `${Math.max(box.top + 8, top)}px`;
  open = menu;
  addEventListener("pointerdown", outside, true);
  addEventListener("keydown", escape, true);
  addEventListener("blur", close);
}
