// 聊天侧边栏: press the panel shortcut and the whole conversation slides in
// at the screen's edge; press it again and it tucks away.
import { t } from "../i18n.ts";
import type { Demo } from "./demoTypes.ts";
import { barePet, docWindow, hop, keycaps, keysDone, pressKeys, timeline } from "./demoParts.ts";

const sidebar = () =>
  `<aside class="demo-sidebar" data-part="sidebar"><b>${t("demo.panel.title")}</b>
    <p class="bubble-mine">${t("demo.panel.msg1")}</p>
    <p class="demo-theirs">${t("demo.panel.msg2")}</p>
    <p class="bubble-mine">${t("demo.panel.msg3")}</p>
    <p class="demo-field" data-placeholder="${t("chat.placeholder")}"><span></span><i class="demo-caret"></i></p>
  </aside>`;

export const panel: Demo = {
  id: "panel",
  length: 7000,
  captions: (c) => [
    { at: 0, text: t("demo.panel.step1", { key: c.label("panel") }) },
    { at: 1700, text: t("demo.panel.step2") },
    { at: 4300, text: t("demo.panel.step3") },
  ],
  stills: [1200, 3000, 6000],
  markup: (c) =>
    docWindow(`<p class="demo-doc">${t("demo.chatShortcut.doc")}</p>`) +
    keycaps(c.keys("panel")) +
    barePet() +
    sidebar(),
  cues(c) {
    const { cues, at } = timeline();
    const n = c.keys("panel").length;
    const up = pressKeys(at, n, 600);
    at(up + 50, (s) => {
      s.part("sidebar").dataset.show = "";
      hop(s);
      s.pet.setGaze({ x: 1, y: -0.2 });
    });
    // Again: it tucks away.
    const again = pressKeys(at, n, 4300);
    at(again + 50, (s) => {
      delete s.part("sidebar").dataset.show;
      s.pet.setGaze(null);
    });
    at(again + 700, keysDone);
    return cues;
  },
};
