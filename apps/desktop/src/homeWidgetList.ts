// Which cards the pet page shows and in what order (plan/35). Kept apart
// from homeWidgets.ts so the rule can be checked without a page.

export const WIDGETS = ["today", "focus", "memory", "chats"] as const;
export type WidgetId = (typeof WIDGETS)[number];
/** Before the user has changed anything. */
export const DEFAULT_CARDS: readonly WidgetId[] = ["today", "focus", "memory"];
/** Shown only while 伙伴大脑 is on. */
export const NEEDS_BRAIN: readonly WidgetId[] = ["memory", "chats"];

const known = (id: string): id is WidgetId =>
  (WIDGETS as readonly string[]).includes(id);

/** The saved list, each known card once, in its order; the default when
 * nothing has been saved yet. Empty stays empty. */
export function shownCards(
  saved: readonly { id: string }[] | null | undefined,
): WidgetId[] {
  if (!saved) return [...DEFAULT_CARDS];
  const out: WidgetId[] = [];
  for (const c of saved) if (known(c.id) && !out.includes(c.id)) out.push(c.id);
  return out;
}

/** The 卡片 list: the shown ones in their order, then the rest. */
export function cardList(shown: readonly WidgetId[]) {
  return [
    ...shown.map((id) => ({ id, on: true })),
    ...WIDGETS.filter((id) => !shown.includes(id)).map((id) => ({
      id,
      on: false,
    })),
  ];
}

/** `list` with `id` moved one place up (-1) or down (1); as it was at an end. */
export function moved<T extends { id: WidgetId }>(
  list: readonly T[],
  id: WidgetId,
  step: -1 | 1,
): T[] {
  const at = list.findIndex((x) => x.id === id);
  const next = [...list];
  if (at < 0 || !next[at + step]) return next;
  [next[at], next[at + step]] = [next[at + step], next[at]];
  return next;
}
