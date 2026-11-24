// Dragging a to-do on the 待办 page (plan/30): by the ⋮⋮ at the start of a
// row, up or down, and across 今天 and 以后. Pointer events rather than
// HTML5 drag and drop, which the app's own file-drop handling can swallow
// in a webview. The row follows the pointer, a line marks where it lands,
// and a group it would move into lights up (Things, 提醒事项).
export type Drop = { today: boolean; before: number | null };

/** Under `lists`: rows (`o.row`, `.todo-row` by default) with a `data-id`
 * and a `.todo-grip`, inside `.todo-group[data-group="today"|"later"]`.
 * `hold` keeps the list from being drawn again while a row is held. The
 * bubble uses it too, for its 今天 list (bubble.ts). */
export function sortable(
  lists: HTMLElement,
  o: {
    row?: string;
    hold(on: boolean): void;
    drop(id: number, to: Drop): void;
  },
) {
  const rowSel = o.row ?? ".todo-row";
  lists.addEventListener("pointerdown", (e) => {
    const grip = (e.target as HTMLElement).closest<HTMLElement>(".todo-grip");
    if (!grip || e.button !== 0) return;
    const row = grip.closest<HTMLElement>(rowSel)!;
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY;
    let moved = false;
    let to: (Drop & { same: boolean }) | null = null;
    o.hold(true);

    const marks = () =>
      lists.querySelectorAll<HTMLElement>("[data-drop], [data-drop-into]");
    const unmark = () => {
      for (const x of marks()) {
        delete x.dataset.drop;
        delete x.dataset.dropInto;
      }
    };
    /** Where a row let go at `y` lands: the group under it (or the nearest
     * one), before the first row whose middle is below `y`. */
    const place = (y: number) => {
      const groups = [
        ...lists.querySelectorAll<HTMLElement>(
          '.todo-group[data-group="today"], .todo-group[data-group="later"]',
        ),
      ];
      if (!groups.length) return null;
      const group =
        groups.find((g) => {
          const r = g.getBoundingClientRect();
          return y >= r.top && y <= r.bottom;
        }) ??
        (y < groups[0].getBoundingClientRect().top
          ? groups[0]
          : groups[groups.length - 1]);
      const rows = [
        ...group.querySelectorAll<HTMLElement>(`${rowSel}[data-state="open"]`),
      ].filter((r) => r !== row);
      const next = rows.find((r) => {
        const b = r.getBoundingClientRect();
        return y < b.top + b.height / 2;
      });
      if (next) next.dataset.drop = "before";
      else group.dataset.drop = "end";
      const into = group.dataset.group!;
      if (into !== row.dataset.group) group.dataset.dropInto = "";
      // Let go where it already was: nothing to save.
      const after = row.nextElementSibling as HTMLElement | null;
      const same =
        into === row.dataset.group &&
        (next ? next === after : !after?.matches(rowSel));
      return {
        today: into === "today",
        before: next ? Number(next.dataset.id) : null,
        same,
      };
    };
    const move = (ev: PointerEvent) => {
      const dy = ev.clientY - startY;
      if (!moved && Math.abs(dy) < 4) return;
      moved = true;
      row.dataset.dragging = "";
      row.style.translate = `0 ${dy}px`;
      unmark();
      to = place(ev.clientY);
    };
    const end = () => {
      grip.removeEventListener("pointermove", move);
      grip.removeEventListener("pointerup", end);
      grip.removeEventListener("pointercancel", end);
      unmark();
      delete row.dataset.dragging;
      row.style.translate = "";
      o.hold(false);
      if (moved && to && !to.same)
        o.drop(Number(row.dataset.id), { today: to.today, before: to.before });
    };
    grip.addEventListener("pointermove", move);
    grip.addEventListener("pointerup", end);
    grip.addEventListener("pointercancel", end);
  });
}
