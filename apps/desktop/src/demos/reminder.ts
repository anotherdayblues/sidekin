// 提醒 (plan/17 3.7, plan/30): ask for a reminder in one line; it goes on
// the to-dos with a time, the clock runs on to it, and the pet pops up with
// the real to-do alert: 完成, or 稍后提醒 with its short list.
import "../todo/todo.css";
import "../todo/todo-bubble.css";
import "../styles/demo-todo.css";
import { dateLocale, t, type Key } from "../i18n.ts";
import type { Demo } from "./demoTypes.ts";
import {
  answer,
  bubbleState,
  hop,
  petWithBubble,
  piece,
  pointAndClick,
  timeline,
  typeAndSend,
} from "./demoParts.ts";

const clock = (minute: number) =>
  new Date(2026, 0, 1, 14, minute).toLocaleTimeString(dateLocale, {
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  });
/** The snoozes as the alert lists them at 15:00 (todo/api.ts snoozes). */
const SNOOZES: [Key, string][] = [
  ["todo.in10", "15:10"],
  ["todo.in60", "16:00"],
  ["todo.tonight", "20:00"],
  ["todo.tomorrowMorning", "9:00"],
];

// The real alert card (todo/bubble.ts due).
const due = () =>
  `<div data-todo data-part="due">
    <div class="todo-card-head"><strong>${t("todo.dueTitle")}</strong></div>
    <ul class="todo-card-list todo-card-due"><li><span class="todo-card-title">${t("demo.reminder.what")}</span><small class="todo-card-time">15:00</small></li></ul>
    <div class="todo-card-actions"><button type="button" tabindex="-1" class="todo-primary">${t("todo.complete")}</button><button type="button" tabindex="-1" class="todo-later" data-part="later">${t("todo.snooze")}</button></div>
    <ul class="todo-snoozes" data-part="snoozes" hidden>${SNOOZES.map(
      ([key, at]) =>
        `<li><button type="button" tabindex="-1" class="todo-snooze"><span>${t(key)}</span><small>${at}</small></button></li>`,
    ).join("")}</ul>
  </div>`;

export const reminder: Demo = {
  id: "reminder",
  length: 10000,
  captions: () => [
    { at: 0, text: t("demo.reminder.step1") },
    { at: 2100, text: t("demo.reminder.step2") },
    { at: 3800, text: t("demo.reminder.step3") },
  ],
  stills: [1200, 3300, 7400],
  markup: () =>
    `<div class="demo-clock" data-part="clock">${clock(58)}</div>` +
    petWithBubble(
      piece.mine + piece.dots + piece.text + piece.compose() + due(),
      "chat",
    ),
  cues() {
    const { cues, at } = timeline();
    at(150, (s) => bubbleState(s, "input"));
    const sent = typeAndSend(at, t("demo.reminder.say"), 500, 12);
    answer(at, t("demo.reminder.reply"), Math.max(sent + 600, 2100), 900);
    // ③ The bubble goes away and the clock runs on to the time.
    at(3800, (s) => {
      delete s.part("bubble").dataset.show;
      s.part("clock").dataset.fast = "";
    });
    at(4300, (s) => (s.part("clock").textContent = clock(59)));
    at(4800, (s) => {
      s.part("clock").textContent = clock(60);
      s.part("clock").dataset.due = "";
    });
    at(5100, (s) => {
      hop(s);
      s.pet.play("jumping", false);
      bubbleState(s, "todo");
    });
    // 稍后提醒 opens its short list: how long, and the time it rings.
    pointAndClick(at, "later", 6200, (s) => {
      s.part("snoozes").hidden = false;
      s.part("clock").dataset.done = "";
    });
    at(7000, (s) => s.pet.play("idle"));
    at(8600, (s) => delete s.part("pointer").dataset.show);
    return cues;
  },
};
