// 今天的待办, the first card on the pet page (plan/27, plan/35): today's
// to-dos, a line to write one (always there while there are none, opened
// by the card's + otherwise), and a key to the page.
// The card's title and count sit above it (homeWidgets.ts). Plain DOM and
// CSS; drawn again only when the to-dos change, and at midnight.
import { t, tn } from "../i18n.ts";
import { carriedLabel, onTodos, todos, today, type Todo } from "./api.ts";
import { quickLine } from "./quick.ts";
import { LEAVE_MS, removeLater } from "./row.ts";
import "./todo.css";
import "./note.css";

/** Open lines on the card before the rest go to the page. */
const LINES = 5;

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
const doneToday = (x: Todo) =>
  !!x.doneAt && new Date(x.doneAt).toDateString() === new Date().toDateString();

/** `meta` is the count the card shows beside its title. */
export function mountTodayNote(slot: HTMLElement, meta: HTMLElement) {
  const paper = el("div", "today-note");
  const lines = el("ul", "today-note-lines");
  const empty = el("p", "today-note-empty", t("todo.noteEmpty"));
  const line = quickLine({
    addKey: true,
    placeholder: t("todo.notePlaceholder"),
  });
  const more = el("button", "today-note-more hc-act");
  more.type = "button";
  paper.append(lines, empty, line.el, more);
  slot.replaceChildren(paper);

  // Opened by write(): stays while one is being typed, closes when left empty.
  let writing = false;
  let hold = 0;
  const holding = (on: boolean) => (hold = Math.max(0, hold + (on ? 1 : -1)));
  function lineFor(x: Todo) {
    const li = el("li", "today-note-line");
    li.dataset.state = x.doneAt ? "done" : "open";
    if (x.carried) li.dataset.carried = "";
    const item = el("button", "today-note-item");
    item.type = "button";
    item.setAttribute("role", "checkbox");
    item.setAttribute("aria-checked", String(!!x.doneAt));
    const mark = el("span", "today-note-mark");
    mark.setAttribute("aria-hidden", "true");
    item.append(mark, el("span", "today-note-text", x.title));
    li.append(item);
    // Carried on from an earlier day: said quietly; else the reminder time.
    if (x.carried && x.day)
      li.append(el("span", "today-note-carried", carriedLabel(x.day)));
    else if (x.time) li.append(el("span", "today-note-time", x.time));
    const del = el("button", "today-note-del");
    del.type = "button";
    del.setAttribute("aria-label", t("common.delete"));
    del.title = t("common.delete");
    li.append(del);
    // Struck through at once, done after a moment; a second click in that
    // moment takes it back. A struck one clicked comes back.
    let leaving = 0;
    item.onclick = () => {
      if (x.doneAt) return void todos.reopen(x.id).then(draw);
      if (leaving) {
        clearTimeout(leaving);
        leaving = 0;
        holding(false);
        li.dataset.state = "open";
        item.setAttribute("aria-checked", "false");
        return;
      }
      li.dataset.state = "leaving";
      item.setAttribute("aria-checked", "true");
      holding(true);
      leaving = window.setTimeout(() => {
        holding(false);
        void todos.complete(x.id).then(draw, draw);
      }, LEAVE_MS);
    };
    del.onclick = () => removeLater(li, x.id, { done: draw, hold: holding });
    return li;
  }
  async function draw() {
    if (hold) return;
    const all = await todos.list().catch(() => [] as Todo[]);
    if (hold) return;
    const open = all.filter((x) => x.group === "today");
    const done = all.filter(doneToday);
    lines.replaceChildren(...open.slice(0, LINES).map(lineFor));
    // Nothing left: said so, the done ones counted when there are some.
    empty.hidden = open.length > 0;
    empty.textContent = done.length
      ? tn("todo.allDone", done.length)
      : t("todo.noteEmpty");
    paper.toggleAttribute("data-all-done", !open.length && done.length > 0);
    line.el.hidden = open.length > 0 && !writing;
    more.textContent =
      open.length > LINES
        ? tn("todo.moreOnPage", open.length - LINES)
        : t("todo.openPage");
    paper.dataset.left = String(open.length);
    meta.textContent = open.length ? tn("home.todoCount", open.length) : "";
    meta.setAttribute("aria-label", tn("todo.leftToday", open.length));
  }
  line.onSubmit(async (f) => {
    await todos.add({ day: today(), ...f });
    line.clear();
    line.input.focus();
    await draw();
  });
  const stopWriting = () => {
    if (!writing) return;
    writing = false;
    void draw();
  };
  line.input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") stopWriting();
  });
  line.input.addEventListener("blur", () => {
    // A click on the add key keeps it open; an empty line closes.
    setTimeout(() => {
      if (!line.el.contains(document.activeElement) && !line.input.value)
        stopWriting();
    });
  });
  more.onclick = () =>
    paper.dispatchEvent(
      new CustomEvent("show-block", { detail: "reminders", bubbles: true }),
    );
  function atMidnight() {
    const next = new Date();
    next.setHours(24, 0, 1, 0);
    setTimeout(() => {
      void draw();
      atMidnight();
    }, next.getTime() - Date.now());
  }
  atMidnight();
  void onTodos(() => void draw());
  void draw();
  return {
    /** Opens the line to write one and puts the cursor there. */
    async write() {
      writing = true;
      await draw();
      line.input.focus();
    },
  };
}
