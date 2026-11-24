// 记忆 (plan/17 3.7): say "remember …", the pet confirms with an undo, and
// the new memory lights up in 记得的事.
import { t } from "../i18n.ts";
import type { Demo } from "./demoTypes.ts";
import { answer, bubbleState, petWithBubble, piece, timeline, typeAndSend } from "./demoParts.ts";

const panel = () =>
  `<div class="demo-panel" data-part="panel"><b>${t("memory.title")}</b><ul>
    <li>${t("demo.memory.item1")}</li><li>${t("demo.memory.item2")}</li><li data-part="fresh">${t("demo.memory.item3")}</li>
  </ul></div>`;

export const memory: Demo = {
  id: "memory",
  length: 8500,
  captions: () => [
    { at: 0, text: t("demo.memory.step1") },
    { at: 2300, text: t("demo.memory.step2") },
    { at: 4600, text: t("demo.memory.step3", { title: t("memory.title") }) },
  ],
  stills: [1200, 3800, 6500],
  markup: () =>
    panel() +
    petWithBubble(piece.mine + piece.dots + piece.text + piece.remembered() + piece.compose(), "chat"),
  cues() {
    const { cues, at } = timeline();
    at(150, (s) => bubbleState(s, "input"));
    const sent = typeAndSend(at, t("demo.memory.say"), 500, 12);
    const done = answer(at, t("demo.memory.reply"), Math.max(sent + 600, 2300), 1000);
    // ② The undo line, and the pet looks pleased with itself.
    at(done + 150, (s) => {
      s.part("remembered").dataset.show = "";
      s.pet.play("review");
    });
    // ③ Over in 记得的事, the new line lights up.
    at(4600, (s) => {
      s.part("panel").dataset.show = "";
      s.pet.setGaze({ x: -1, y: -0.2 });
    });
    at(5200, (s) => (s.part("fresh").dataset.on = ""));
    return cues;
  },
};
