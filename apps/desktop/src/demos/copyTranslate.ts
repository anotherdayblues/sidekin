// 连按两次复制翻译 (plan/17 3.7): select a sentence, copy twice, and the
// translation appears in the pet's bubble.
import { t } from "../i18n.ts";
import type { Demo } from "./demoTypes.ts";
import {
  answer,
  bubbleState,
  docWindow,
  hop,
  keycaps,
  keysDone,
  petWithBubble,
  piece,
  selectable,
  selectSentence,
  timeline,
} from "./demoParts.ts";

export const copyTranslate: Demo = {
  id: "copy-translate",
  length: 8000,
  captions: (c) => [
    { at: 0, text: t("demo.copyTranslate.step1") },
    { at: 1500, text: t("demo.copyTranslate.step2", { key: c.mac ? "⌘C" : "Ctrl+C" }) },
    { at: 4500, text: t("demo.copyTranslate.step3") },
  ],
  stills: [1450, 2450, 6400],
  markup: (c) =>
    docWindow(selectable(t("demo.copyTranslate.source"))) +
    keycaps([c.mac ? "⌘" : "Ctrl", "C"]) +
    petWithBubble(piece.dots + piece.text + piece.copy()),
  cues() {
    const { cues, at } = timeline();
    // ① Drag across the sentence.
    selectSentence(at, t("demo.copyTranslate.source"), 400, 1400);
    // ② Copy twice: hold the modifier, C down and up twice.
    at(1600, (s) => (s.part("keys").dataset.show = ""));
    at(1850, (s) => s.part("key0").toggleAttribute("data-down", true));
    for (const down of [2050, 2400]) {
      at(down, (s) => s.part("key1").toggleAttribute("data-down", true));
      at(down + 150, (s) => s.part("key1").removeAttribute("data-down"));
    }
    at(2750, (s) => s.part("key0").removeAttribute("data-down"));
    // The pet notices and starts thinking.
    at(3000, (s) => {
      s.pet.setGaze(null);
      hop(s);
      s.pet.play("running", false);
    });
    at(3250, (s) => bubbleState(s, "thinking"));
    // ③ The translation arrives.
    at(4500, keysDone);
    const done = answer(at, t("demo.copyTranslate.result"), 4500, 1500);
    at(done + 100, (s) => (s.part("copy").dataset.show = ""));
    at(6500, (s) => s.pet.play("jumping"));
    return cues;
  },
};
