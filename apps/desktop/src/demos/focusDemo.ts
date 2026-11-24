// 陪我专注 (plan/19): right-click the pet, pick 陪我专注, and the clock
// appears above its head and a lamp light pools at its feet while it works;
// at the end it jumps, a ring of light runs out and confetti flies. Uses the
// real clock's and light's styles and the real confetti.
import "../styles/focus-clock.css";
import "../styles/focus-light.css";
import { burst } from "../confetti.ts";
import { t } from "../i18n.ts";
import type { Demo } from "./demoTypes.ts";
import {
  bubbleState,
  click,
  docWindow,
  hop,
  petWithBubble,
  piece,
  timeline,
} from "./demoParts.ts";

const menu = () =>
  `<div class="demo-menu demo-focus-menu" data-part="menu">
    <p data-part="menu-item">${t("focus.start")}</p>
    <p>${t("menu.openChat")}</p>
    <p>${t("menu.snip")}</p>
  </div>`;
const clock = () =>
  `<div class="focus-light" data-part="light" data-phase="idle"><i class="focus-pool"></i><i class="focus-ring"></i></div><div class="focus-clock" data-home="page" data-part="clock" data-phase="idle"><span class="clock-face"><span class="clock-read"><b class="clock-digits" data-part="digits">25:00</b><i class="clock-progress"></i></span></span></div><canvas class="focus-confetti" data-part="confetti"></canvas>`;

export const focusDemo: Demo = {
  id: "focus",
  length: 9500,
  captions: () => [
    { at: 0, text: t("demo.focus.step1", { item: t("focus.start") }) },
    { at: 2300, text: t("demo.focus.step2") },
    { at: 6200, text: t("demo.focus.step3") },
  ],
  stills: [1800, 4200, 7400],
  markup: () =>
    docWindow(`<p class="demo-doc">${t("demo.chatShortcut.doc")}</p>`) +
    petWithBubble(piece.text) +
    menu(),
  cues() {
    const { cues, at } = timeline();
    // The clock and confetti live with the pet, above its head.
    at(0, (s) => s.part("pet").insertAdjacentHTML("afterbegin", clock()));
    at(300, (s) => {
      const pointer = s.part("pointer");
      pointer.dataset.shape = "arrow";
      pointer.dataset.show = "";
      s.pointAt(s.part("pet").querySelector("canvas")!, "middle");
    });
    at(1000, (s) => {
      click(s);
      s.part("menu").dataset.show = "";
    });
    at(1400, (s) => s.pointAt(s.part("menu-item"), "middle"));
    at(1800, (s) => (s.part("menu-item").dataset.hot = ""));
    // ② Started: the clock comes up and the pet gets to work.
    at(2200, (s) => {
      click(s);
      delete s.part("menu").dataset.show;
      delete s.part("pointer").dataset.show;
      s.part("clock").dataset.phase = "focus";
      s.part("light").dataset.phase = "focus";
      s.part("light").dataset.lit = "";
      s.pet.play("running", false);
    });
    // The time runs, much faster than real.
    ["21:36", "16:12", "10:48", "5:24", "0:00"].forEach((left, i, all) =>
      at(2900 + i * 650, (s) => {
        s.part("digits").textContent = left;
        s.part("clock").style.setProperty("--p", String((i + 1) / all.length));
      }),
    );
    // ③ Done: a jump, confetti, and the bubble suggests a break.
    at(6200, (s) => {
      s.part("clock").dataset.phase = "done";
      s.part("clock").dataset.cheer = "";
      s.part("light").dataset.phase = "done";
      s.part("light").dataset.cheer = "";
      s.part("digits").textContent = "✓";
      hop(s);
      s.pet.play("jumping");
      burst(s.part("confetti") as HTMLCanvasElement, { x: 0.5, y: 0.25 });
    });
    at(6900, (s) => {
      s.part("text").textContent = t("focus.done", { n: 5 });
      bubbleState(s, "answer");
    });
    return cues;
  },
};
