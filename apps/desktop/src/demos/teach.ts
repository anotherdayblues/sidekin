// 让 AI 教新本领: copy the note from 教它新本领, paste it to an AI assistant
// with what to learn, and the new trick arrives in 新本领 to try and keep.
import { t } from "../i18n.ts";
import type { Demo } from "./demoTypes.ts";
import { aiWindow, askAI, barePet, copyCard, copyNote, hop, pointAndClick, timeline } from "./demoParts.ts";

const studio = () =>
  `<div class="demo-window demo-app" data-part="window"><i class="demo-titlebar"></i>
    <header><b>${t("studio.actions")}</b><button type="button" tabindex="-1" data-part="teach-btn" aria-label="${t("studio.teach")}">+</button></header>
    <div class="demo-trick" data-part="trick"><b>${t("demo.teach.trick")}</b><span class="demo-new">${t("studio.new")}</span>
      <button type="button" tabindex="-1" data-part="try">${t("demo.teach.try")}</button><button type="button" tabindex="-1" data-part="keep">${t("demo.teach.keep")}</button></div>
    ${copyCard()}
  </div>`;

export const teach: Demo = {
  id: "teach",
  length: 10000,
  captions: () => [
    { at: 0, text: t("demo.teach.step1", { button: "+" }) },
    { at: 2400, text: t("demo.teach.step2") },
    { at: 6400, text: t("demo.teach.step3") },
  ],
  stills: [2000, 5800, 8000],
  markup: () => studio() + aiWindow() + barePet(),
  cues() {
    const { cues, at } = timeline();
    pointAndClick(at, "teach-btn", 300, (s) => (s.part("pop").dataset.show = ""));
    copyNote(at, 1400);
    const done = askAI(at, t("demo.teach.ask"), t("demo.teach.working"), t("demo.ai.done"), 2400);
    // ③ Back in 随伴: the new trick waits in 新本领.
    at(Math.max(done + 300, 6400), (s) => {
      delete s.part("ai").dataset.show;
      delete s.part("pop").dataset.show;
      s.part("trick").dataset.show = "";
    });
    pointAndClick(at, "try", 6800, (s) => {
      hop(s);
      s.pet.play("jumping");
    });
    pointAndClick(at, "keep", 8200, (s) => (s.part("trick").dataset.kept = ""));
    return cues;
  },
};
