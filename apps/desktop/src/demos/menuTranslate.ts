// 右键翻译选中的字 (plan/17 3.7): select text, right-click the pet, pick
// 翻译选中的文字 from its menu, and the translation appears in the bubble.
import { t } from "../i18n.ts";
import type { Demo } from "./demoTypes.ts";
import {
  answer,
  bubbleState,
  click,
  docWindow,
  hop,
  petWithBubble,
  piece,
  selectable,
  selectSentence,
  timeline,
} from "./demoParts.ts";

// The pet's real menu, top part (petMenu.ts).
const menu = () =>
  `<div class="demo-menu" data-part="menu">
    <p>${t("menu.openChat")}</p>
    <p>${t("menu.snip")}</p>
    <p class="demo-menu-sub" data-part="menu-parent">${t("settings.translation")}
      <span class="demo-menu demo-submenu" data-part="submenu">
        <span data-part="menu-item">${t("menu.translateSelection")}</span>
        <span>${t("chat.translations")}</span>
      </span>
    </p>
    <p>${t("menu.petControls")}</p>
  </div>`;

export const menuTranslate: Demo = {
  id: "menu-translate",
  length: 8500,
  captions: () => [
    { at: 0, text: t("demo.menuTranslate.step1") },
    { at: 1700, text: t("demo.menuTranslate.step2", { item: t("menu.translateSelection") }) },
    { at: 5000, text: t("demo.menuTranslate.step3") },
  ],
  stills: [1450, 4100, 7000],
  markup: () =>
    docWindow(selectable(t("demo.menuTranslate.source"))) +
    petWithBubble(piece.dots + piece.text + piece.copy()) +
    menu(),
  cues() {
    const { cues, at } = timeline();
    selectSentence(at, t("demo.menuTranslate.source"), 400, 1400);
    // ② Over to the pet as an arrow, and right-click it.
    at(1700, (s) => {
      const pointer = s.part("pointer");
      delete pointer.dataset.drag;
      pointer.dataset.shape = "arrow";
      s.pointAt(s.part("pet").querySelector("canvas")!, "middle");
      s.pet.setGaze({ x: 1, y: 0.2 });
    });
    at(2500, (s) => {
      click(s);
      s.part("menu").dataset.show = "";
    });
    at(3000, (s) => s.pointAt(s.part("menu-parent"), "middle"));
    at(3350, (s) => {
      s.part("menu-parent").dataset.hot = "";
      s.part("submenu").dataset.show = "";
    });
    at(3700, (s) => s.pointAt(s.part("menu-item"), "middle"));
    at(4050, (s) => (s.part("menu-item").dataset.hot = ""));
    // ③ Picked: the menu closes and the pet gets to work.
    at(4250, click);
    at(4400, (s) => {
      delete s.part("menu").dataset.show;
      delete s.part("pointer").dataset.show;
      s.pet.setGaze(null);
      hop(s);
      s.pet.play("running", false);
      bubbleState(s, "thinking");
    });
    const done = answer(at, t("demo.menuTranslate.result"), 5000, 1300);
    at(done + 100, (s) => (s.part("copy").dataset.show = ""));
    at(done + 300, (s) => s.pet.play("jumping"));
    return cues;
  },
};
