// 待办 in the bubble (plan/27). One card at a time, each with one thing to
// do and the rest as quiet links, after the small windows of mature to-do
// apps (Things' Quick Entry, TickTick's menu-bar list, the task picker and
// session-done screen of Super Productivity's focus mode):
//   today     the line to add one, over today's list to tick off and
//             drag into order by the ⋮⋮ (drag.ts, as on the page);
//   pick      which one a tomato is on;
//   due       an alert: 完成, or 稍后提醒, which opens a short list in the
//             card, each row saying when it rings again (Gmail's snooze
//             menu, iOS 26.5); the × closes it, the to-do stays.
import { emit } from "@tauri-apps/api/event";
import { showStudio } from "../bridge.ts";
import { focusState } from "../focus.ts";
import { dateLocale, t, tn } from "../i18n.ts";
import { carriedLabel, snoozes, todos, type Answer, type Todo } from "./api.ts";
import { quickLine } from "./quick.ts";
import {
  edit,
  LEAVE_MS,
  removeLater,
  rowKeys,
  under,
  type RowHooks,
} from "./row.ts";
import { openRowMenu } from "./rowActions.ts";
import { tidy } from "./drafts.ts";
import { sortable } from "./drag.ts";
import "./todo.css";
import "./todo-bubble.css";

export type TodoAsk = "today" | "pick" | "due";
/** Rows shown in the bubble before the rest go to the page. */
const ROWS = 6;
/** How long a short acknowledgment stays. */
const SAID_MS = 2400;
/** How long an unanswered question stays (the alert stays on the list). */
const STAYS_MS = 60_000;

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
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
  if (act) b.dataset.todoAct = act;
  return b;
}
function head(title: string, note = "") {
  const h = el("div", "todo-card-head");
  h.append(el("strong", "", title));
  if (note) h.append(el("small", "", note));
  return h;
}
/** Beside a title: 昨天的 for one carried on, else the reminder time (drawn
 * with a bell). */
function when(x: Todo): [string, string] | null {
  if (x.carried && x.day) return ["todo-card-carried", carriedLabel(x.day)];
  return x.time ? ["todo-card-time", x.time] : null;
}
/** A round check that strikes the row through, then completes it after a
 * moment; a second click in that moment takes it back. With `hooks` (the
 * 今天 list), a ⋮⋮ to drag it by, and under the pointer the pencil and the
 * × of the 待办 page: edited in place, deleted with 撤销 for a moment. */
function checkRow(x: Todo, done: () => void, hooks?: RowHooks) {
  const li = el("li", "todo-card-row");
  li.dataset.state = "open";
  li.dataset.id = String(x.id);
  li.dataset.group = x.group;
  if (hooks) {
    const grip = button("todo-grip", "");
    grip.setAttribute("aria-label", t("todo.drag"));
    grip.title = t("todo.drag");
    li.append(grip);
  }
  const check = el("button", "todo-check");
  check.type = "button";
  check.setAttribute("role", "checkbox");
  check.setAttribute("aria-checked", "false");
  check.setAttribute("aria-label", t("todo.complete"));
  li.append(check, el("span", "todo-card-title", x.title));
  const w = when(x);
  if (w) li.append(el("small", w[0], w[1]));
  if (hooks) {
    const acts = el("span", "todo-acts");
    acts.append(...rowKeys(false));
    acts.onclick = (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>("[data-act]")
        ?.dataset.act;
      if (act === "edit") edit(li, x, hooks);
      if (act === "more") hooks.menu?.(li, x, under(e.target as HTMLElement));
      if (act === "delete")
        removeLater(li, x.id, { done, hold: hooks.editing });
    };
    li.append(acts);
    // A right click opens the same menu, as on the 待办 page.
    li.addEventListener("contextmenu", (e) => {
      if (!hooks.menu || li.dataset.state === "editing") return;
      e.preventDefault();
      hooks.menu(li, x, { x: e.clientX, y: e.clientY });
    });
  }
  let leaving = 0;
  check.onclick = () => {
    if (leaving) {
      clearTimeout(leaving);
      leaving = 0;
      li.dataset.state = "open";
      check.setAttribute("aria-checked", "false");
      return;
    }
    li.dataset.state = "leaving";
    check.setAttribute("aria-checked", "true");
    leaving = window.setTimeout(() => {
      void todos.complete(x.id).then(done, done);
    }, LEAVE_MS);
  };
  return li;
}
const openPage = async () => {
  await showStudio();
  await emit("studio-block", "reminders");
};

export function bubbleTodo(
  box: HTMLElement,
  o: { card: HTMLElement; hide(): void },
) {
  let timer = 0;
  const clear = () => {
    clearTimeout(timer);
    box.hidden = true;
    box.replaceChildren();
    box.onclick = null;
    delete box.dataset.kind;
  };
  /** Gone; and the bubble with it, if it opened for this alone. */
  const done = () => {
    const alone = o.card.dataset.state === "todo";
    clear();
    if (alone) o.hide();
  };
  const stay = (ms: number) => {
    clearTimeout(timer);
    timer = window.setTimeout(done, ms);
  };
  function open(kind: TodoAsk, ...children: HTMLElement[]) {
    clearTimeout(timer);
    box.onclick = null;
    box.replaceChildren(...children);
    box.dataset.kind = kind;
    box.hidden = false;
  }

  /** 今天: the line on top, today's list under it (TickTick's mini list;
   * Things' Quick Entry for the line). */
  async function todayCard() {
    const line = quickLine({ controls: true, tidy: todos.aiReady });
    const note = el("small", "todo-card-note");
    note.hidden = true;
    // 整理成几条 (plan/31): the drafts open under the line.
    const drafts = el("div", "todo-drafts-slot");
    drafts.hidden = true;
    const list = el("ul", "todo-card-list todo-group");
    list.dataset.group = "today";
    const lists = el("div", "todo-card-lists");
    lists.append(list);
    const empty = el("p", "todo-card-empty", t("todo.empty"));
    const more = button("todo-link", "", "page");
    const later = el("small", "todo-card-later");
    const foot = el("div", "todo-card-foot");
    foot.append(later, more);
    const date = new Date().toLocaleDateString(dateLocale, {
      month: "short",
      day: "numeric",
      weekday: "short",
    });
    open(
      "today",
      head(t("todo.today"), date),
      line.el,
      drafts,
      note,
      lists,
      empty,
      foot,
    );
    // While a row is held, edited or about to go, the list is not drawn
    // again (drag.ts, row.ts).
    let held = false;
    let shown: Todo[] = [];
    // 帮我拆一下 is in the menu only with 伙伴大脑 on.
    let ai = false;
    void todos.aiReady().then((on) => (ai = on));
    const rowHooks: RowHooks = {
      refresh: () => void fill(),
      editing(on) {
        held = on;
      },
      focusing: null,
      menu: (row, todo, at) => openRowMenu(row, todo, at, rowHooks, ai),
    };
    sortable(lists, {
      row: ".todo-card-row",
      hold(on) {
        held = on;
      },
      drop(id, to) {
        // Let go under the last row shown: it goes before the first one
        // left for the page, not to the very end.
        const before = to.before ?? shown[ROWS]?.id ?? null;
        void todos.move(id, true, before).then(fill, fill);
      },
    });
    async function fill() {
      if (held) return;
      const every = await todos.list();
      const all = every.filter((x) => x.group === "today");
      shown = all;
      const left = every.filter((x) => x.group === "later").length;
      list.replaceChildren(
        ...all.slice(0, ROWS).map((x) => checkRow(x, fill, rowHooks)),
      );
      empty.hidden = all.length > 0;
      later.textContent = left ? tn("todo.laterCount", left) : "";
      more.textContent =
        all.length > ROWS
          ? tn("todo.moreOnPage", all.length - ROWS)
          : t("todo.openPage");
    }
    line.onTidy((text) => {
      void tidy(drafts, text, {
        source: "bubble",
        done(n) {
          if (n) {
            line.clear();
            note.textContent = t("todo.aiAdded", { n });
            note.hidden = false;
          }
          void fill();
        },
      });
    });
    line.onSubmit(async (f) => {
      try {
        await todos.add(f, "bubble");
        line.clear();
        note.textContent = t("todo.added", { title: f.title ?? "" });
        note.hidden = false;
        line.input.focus();
        await fill();
      } catch (err) {
        note.textContent = String(err);
        note.hidden = false;
      }
    });
    box.onclick = (e) => {
      if ((e.target as HTMLElement).closest('[data-todo-act="page"]')) {
        done();
        void openPage();
      }
    };
    await fill();
    line.input.focus();
  }

  /** The timer starts only after a choice, including timer only. */
  async function pick() {
    const [{ candidates }, { settings }] = await Promise.all([
      todos.focusState(),
      focusState(),
    ]);
    const top = el("div", "todo-focus-summary");
    const duration = el(
      "strong",
      "todo-focus-duration",
      String(settings.focusMinutes),
    );
    duration.append(el("small", "", t("focus.unitMinutes")));
    top.append(
      el("span", "todo-focus-clock"),
      duration,
      button("todo-timer-only", t("focus.justTimer"), "none"),
    );
    const list = el("ul", "todo-card-list");
    for (const x of candidates) {
      const li = el("li");
      const b = el("button", "todo-card-pick");
      b.type = "button";
      b.dataset.todoPick = String(x.id);
      b.append(el("span", "todo-card-title", x.title));
      const w = when(x);
      if (w) b.append(el("small", w[0], w[1]));
      li.append(b);
      list.append(li);
    }
    const tasks = el("div", "todo-focus-tasks");
    tasks.hidden = !candidates.length;
    tasks.append(el("div", "todo-focus-label", t("todo.startFromTask")), list);
    open("pick", top, tasks);
    box.onclick = (e) => {
      const target = e.target as HTMLElement;
      const b = target.closest<HTMLElement>("[data-todo-pick]");
      const none = target.closest('[data-todo-act="none"]');
      if (!b && !none) return;
      const id = b ? Number(b.dataset.todoPick) : null;
      done();
      void todos.focus(id);
    };
    stay(STAYS_MS);
  }

  async function due() {
    const items = await todos.pending();
    if (!items.length) return done();
    const list = el("ul", "todo-card-list todo-card-due");
    for (const x of items) {
      const li = el("li");
      li.append(el("span", "todo-card-title", x.title));
      if (x.time) li.append(el("small", "todo-card-time", x.time));
      list.append(li);
    }
    // 完成 and 稍后提醒; the snoozes open under them as a menu-like list.
    const foot = el("div", "todo-card-actions");
    const more = button("todo-later", t("todo.snooze"), "later");
    more.setAttribute("aria-expanded", "false");
    foot.append(button("todo-primary", t("todo.complete"), "done"), more);
    const later = el("ul", "todo-snoozes");
    later.hidden = true;
    for (const [act, key, at] of snoozes()) {
      const li = el("li");
      const b = button("todo-snooze", "", act);
      b.append(el("span", "", t(key)), el("small", "", at));
      li.append(b);
      later.append(li);
    }
    open("due", head(t("todo.dueTitle")), list, foot, later);
    box.onclick = (e) => {
      const act = (e.target as HTMLElement).closest<HTMLElement>(
        "[data-todo-act]",
      )?.dataset.todoAct;
      if (act === "later") {
        later.hidden = !later.hidden;
        more.setAttribute("aria-expanded", String(!later.hidden));
        return;
      }
      if (!act) return;
      void todos.answer(
        items.map((x) => x.id),
        act as Answer,
      );
      if (act === "done") {
        open("due", el("p", "todo-card-say", t("todo.completed")));
        stay(SAID_MS);
      } else done();
    };
  }

  return {
    show(kind: TodoAsk) {
      if (kind === "today") void todayCard();
      if (kind === "pick") void pick();
      if (kind === "due") void due();
    },
    clear,
  };
}

/** Under 番茄钟's "done": the to-do the tomato was on, with a round check
 * to tick it off (Super Productivity's session-done screen names the task
 * the same way). Nothing when the tomato was on none. */
export async function focusTodoLine(slot: HTMLElement) {
  slot.hidden = true;
  slot.replaceChildren();
  const { current } = await todos.focusState().catch(() => ({ current: null }));
  if (!current) return;
  const list = el("ul", "todo-card-list");
  const row = checkRow(current, () =>
    slot.replaceChildren(el("p", "todo-card-say", t("todo.completed"))),
  );
  if (current.tomatoes)
    row.append(el("small", "", tn("todo.tomatoes", current.tomatoes)));
  list.append(row);
  slot.append(el("small", "todo-card-note", t("todo.focusOn")), list);
  slot.hidden = false;
}
