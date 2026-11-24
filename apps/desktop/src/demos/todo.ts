// 待办 (plan/27, 30, 31): right-click the pet and pick 待办; one line with a
// time in it is understood (the words marked, a 🔔 tag); a pasted paragraph
// is read into a few to-dos to tick and add. Drawn with the real to-do
// card's classes, so it looks like the bubble the user will get.
import "../todo/todo.css";
import "../todo/todo-bubble.css";
import "../todo/quick.css";
import "../todo/todo-ai.css";
import "../styles/demo-todo.css";
import { dateLocale, t, type Key } from "../i18n.ts";
import { dayLabel, today } from "../todo/api.ts";
import type { Demo } from "./demoTypes.ts";
import { typeIn } from "./demoTypes.ts";
import {
  bubbleState,
  click,
  petWithBubble,
  pointAndClick,
  timeline,
} from "./demoParts.ts";

const menu = () =>
  `<div class="demo-menu demo-focus-menu" data-part="menu">
    <p data-part="menu-item">${t("todo.menuOpen")}</p>
    <p>${t("focus.start")}</p>
    <p>${t("menu.openChat")}</p>
  </div>`;

/** 今天's card: the line on top, today's list under it. */
const card = () => {
  const date = new Date().toLocaleDateString(dateLocale, {
    month: "short",
    day: "numeric",
    weekday: "short",
  });
  const drafts = [1, 2, 3]
    .map(
      (n) =>
        `<li><label><i class="demo-todo-box"></i><span class="todo-drafts-title">${t(`demo.todo.draft${n}` as Key)}</span><small class="todo-drafts-when">${t(`demo.todo.draft${n}When` as Key)}</small></label></li>`,
    )
    .join("");
  return `<div data-todo data-part="todo">
    <div class="todo-card-head"><strong>${t("todo.today")}</strong><small>${date}</small></div>
    <div class="todo-quick">
      <div class="todo-quick-field">
        <p class="demo-field demo-todo-field" data-part="field" data-placeholder="${t("todo.quickPlaceholder")}"><span data-part="draft"></span><i class="demo-caret"></i></p>
        <button type="button" tabindex="-1" class="todo-quick-tidy" data-part="tidy" hidden><span>${t("todo.aiTidy")}</span></button>
      </div>
      <div class="todo-quick-chip" data-part="chip" data-remind hidden><span class="todo-quick-when">${dayLabel(today(1))} 15:00</span></div>
    </div>
    <div class="todo-drafts" data-part="drafts" hidden>
      <p class="todo-drafts-lead" data-part="lead">${t("todo.aiThinking")}</p>
      <ul class="todo-drafts-list" data-part="draft-list" hidden>${drafts}</ul>
      <div class="todo-drafts-keys" data-part="draft-keys" hidden><button type="button" tabindex="-1" class="todo-drafts-go" data-part="go">${t("todo.aiAdd", { n: 3 })}</button><button type="button" tabindex="-1" class="todo-drafts-cancel">${t("todo.aiCancel")}</button></div>
    </div>
    <small class="todo-card-note" data-part="note" hidden></small>
    <ul class="todo-card-list" data-part="list">
      <li class="todo-card-row"><i class="todo-check"></i><span class="todo-card-title">${t("demo.todo.row1")}</span></li>
      <li class="todo-card-row"><i class="todo-check"></i><span class="todo-card-title">${t("demo.reminder.what")}</span><small class="todo-card-time">15:00</small></li>
    </ul>
  </div>`;
};

export const todo: Demo = {
  id: "todo",
  length: 12500,
  captions: () => [
    { at: 0, text: t("demo.todo.step1", { item: t("todo.menuOpen") }) },
    { at: 2100, text: t("demo.todo.step2") },
    { at: 5600, text: t("demo.todo.step3", { tidy: t("todo.aiTidy") }) },
  ],
  stills: [1600, 4300, 9600],
  markup: () => petWithBubble(card()) + menu(),
  cues() {
    const { cues, at } = timeline();
    // ① Right-click the pet, pick 待办: today's card opens.
    at(300, (s) => {
      const pointer = s.part("pointer");
      pointer.dataset.shape = "arrow";
      pointer.dataset.show = "";
      s.pointAt(s.part("pet").querySelector("canvas")!, "middle");
    });
    at(900, (s) => {
      click(s);
      s.part("menu").dataset.show = "";
    });
    at(1200, (s) => s.pointAt(s.part("menu-item"), "middle"));
    at(1450, (s) => (s.part("menu-item").dataset.hot = ""));
    at(1750, (s) => {
      click(s);
      delete s.part("menu").dataset.show;
      bubbleState(s, "todo");
    });
    // ② One line with a time in it: the words are marked, a tag shows.
    pointAndClick(at, "field", 2100);
    const say = t("demo.todo.say");
    // Typed in at most 1.4 s, so a longer sentence (English) is done in time.
    const ms = Math.min(1000 / 13, 1400 / [...say].length);
    for (const cue of typeIn("draft", say, 2800, ms)) at(cue.at, cue.run);
    const typed = 2800 + [...say].length * ms;
    at(typed + 250, (s) => {
      const when = t("demo.todo.sayWhen");
      const draft = s.part("draft");
      draft.textContent = "";
      const [before, after] = say.split(when);
      const mark = document.createElement("mark");
      mark.textContent = when;
      draft.append(before, mark, after);
      s.part("chip").hidden = false;
    });
    at(typed + 1300, (s) => {
      s.part("draft").textContent = "";
      s.part("chip").hidden = true;
      const note = s.part("note");
      note.textContent = t("todo.added", { title: t("demo.todo.title") });
      note.hidden = false;
    });
    // ③ A pasted paragraph: 整理成几条, tick, add.
    at(5600, (s) => {
      s.part("note").hidden = true;
      s.part("draft").textContent = t("demo.todo.paragraph");
      s.part("field").dataset.paragraph = "";
      s.part("tidy").hidden = false;
    });
    pointAndClick(at, "tidy", 6200, (s) => {
      s.part("tidy").hidden = true;
      s.part("draft").textContent = "";
      delete s.part("field").dataset.paragraph;
      s.part("list").hidden = true;
      s.part("drafts").hidden = false;
      s.pet.play("running", false);
    });
    at(7600, (s) => {
      s.part("lead").textContent = t("todo.aiTidyLead", { n: 3 });
      s.part("draft-list").hidden = false;
      s.part("draft-keys").hidden = false;
      s.pet.play("idle");
    });
    pointAndClick(at, "go", 8600, (s) => {
      s.part("drafts").hidden = true;
      s.part("list").hidden = false;
      const note = s.part("note");
      note.textContent = t("todo.aiAdded", { n: 3 });
      note.hidden = false;
    });
    at(9900, (s) => delete s.part("pointer").dataset.show);
    return cues;
  },
};
