// 待办 in the pet's right-click menu (plan/27): complete the one the
// tomato is on, or open today's card to add one. Reading the text selected
// in another app was dropped in plan/29: nobody else does it, and ⌘V works.
import { invoke } from "@tauri-apps/api/core";
import { t } from "../i18n.ts";
import type { FocusState } from "../focus.ts";
import { todos } from "./api.ts";

export async function todoMenu(focus: FocusState, n: number) {
  const current =
    focus.phase === "idle"
      ? null
      : await todos
          .focusState()
          .then((s) => s.current)
          .catch(() => null);
  return [
    ...(current
      ? [
          {
            id: `pet-todo-done-${n}`,
            text: t("todo.menuDone"),
            action: () => void todos.complete(current.id),
          },
        ]
      : []),
    {
      id: `pet-todo-new-${n}`,
      text: t("todo.menuOpen"),
      action: () => void invoke("todo_today_from_menu"),
    },
  ];
}
