// 让 AI 做新宠物: + → 让 AI 做一只新宠物, copy the note, describe the pet to
// an AI assistant, and the new pet arrives in the list and on the desktop.
// It shows the bundled example pet: the demo cannot draw a new one.
import { t } from "../i18n.ts";
import type { Demo } from "./demoTypes.ts";
import { aiWindow, askAI, barePet, copyCard, copyNote, hop, pointAndClick, timeline } from "./demoParts.ts";

const studio = () =>
  `<div class="demo-window demo-app" data-part="window"><i class="demo-titlebar"></i>
    <div class="make-layout"><div class="make-rail">
      <strong>${t("app.name")}</strong><small>${t("studio.myPets")}</small>
      <span class="make-arrival" data-part="newtile">${t("demo.makePet.name")}</span>
      <div class="make-tools"><button type="button" tabindex="-1" data-part="plus">＋</button><i aria-hidden="true">☷</i></div>
    </div><div class="make-workspace"><b>${t("studio.pet")}</b><div class="make-stage">
      <span>${t("studio.noPet")}</span><canvas width="192" height="208"></canvas>
    </div></div></div>
    <div class="demo-menu demo-add-menu" data-part="menu"><p data-part="make-item">${t("studio.makePetMenu")}</p><p>${t("studio.meetLizi")}</p></div>
    ${copyCard()}
  </div>`;

export const makePet: Demo = {
  id: "make-pet",
  length: 10500,
  examplePet: true,
  captions: () => [
    { at: 0, text: t("demo.makePet.step1", { item: t("studio.makePetMenu") }) },
    { at: 3000, text: t("demo.makePet.step2") },
    { at: 7400, text: t("demo.makePet.step3") },
  ],
  stills: [1100, 6800, 9200],
  markup: () => studio() + aiWindow() + barePet(),
  cues() {
    const { cues, at } = timeline();
    // The pet is not here yet.
    at(0, (s) => (s.part("pet").dataset.away = ""));
    pointAndClick(at, "plus", 300, (s) => (s.part("menu").dataset.show = ""));
    at(1300, (s) => s.pointAt(s.part("make-item"), "middle"));
    at(1600, (s) => (s.part("make-item").dataset.hot = ""));
    at(1900, (s) => {
      delete s.part("menu").dataset.show;
      s.part("pop").dataset.show = "";
    });
    copyNote(at, 2200);
    const done = askAI(at, t("demo.makePet.ask"), t("demo.makePet.working"), t("demo.ai.done"), 3000);
    // ③ It arrives: in the list, and on the desktop.
    at(Math.max(done + 300, 7400), (s) => {
      delete s.part("ai").dataset.show;
      delete s.part("pop").dataset.show;
      delete s.part("pointer").dataset.show;
      s.part("newtile").dataset.show = "";
      const portrait = s.part("window").querySelector("canvas")!;
      portrait.getContext("2d")?.drawImage(s.part("pet").querySelector("canvas")!, 0, 0, portrait.width, portrait.height);
    });
    at(Math.max(done + 900, 8000), (s) => {
      delete s.part("pet").dataset.away;
      hop(s);
      s.pet.play("waving");
    });
    return cues;
  },
};
