// 文件中转: drop files on the pet, it holds them in a pile, and later the
// whole pile is dragged out into a chat. The originals stay where they were.
import { t } from "../i18n.ts";
import type { Demo, Scene } from "./demoTypes.ts";
import { barePet, click, ghost, hop, timeline } from "./demoParts.ts";

const folder = () =>
  `<div class="demo-window demo-folder" data-part="window"><i class="demo-titlebar"></i><b>${t("demo.files.folder")}</b>
    <p class="demo-file" data-part="file1">${t("demo.files.file1")}</p>
    <p class="demo-file" data-part="file2">${t("demo.files.file2")}</p>
  </div>`;
const chat = () =>
  `<div class="demo-window demo-chatwin" data-part="chatwin"><i class="demo-titlebar"></i><div class="handoff-contact"><i aria-hidden="true"></i><strong>${t("demo.files.chat")}</strong></div>
    <div class="handoff-thread"><span>${t("demo.files.request")}</span><span>${t("demo.files.reply")}</span></div>
    <div class="demo-drop" data-part="drop"><small>${t("demo.files.compose")}</small><span class="demo-chip">${t("demo.files.file1")}</span><span class="demo-chip">${t("demo.files.file2")}</span></div>
  </div>`;
const pile = () => `<div class="demo-pile" data-part="pile"><i></i><i></i><b data-part="count">0</b></div>`;

const petBody = (s: Scene) => s.part("pet").querySelector("canvas")!;

export const fileTransfer: Demo = {
  id: "file-transfer",
  length: 9000,
  captions: () => [
    { at: 0, text: t("demo.files.step1") },
    { at: 2200, text: t("demo.files.step2") },
    { at: 4400, text: t("demo.files.step3") },
  ],
  stills: [1700, 3800, 7600],
  markup: () => folder() + chat() + barePet() + pile() + ghost(),
  cues() {
    const { cues, at } = timeline();
    // Pick a file up, carry it over, drop it on the pet.
    const carry = (from: number, file: string, count: number) => {
      at(from, (s) => {
        const pointer = s.part("pointer");
        pointer.dataset.shape = "arrow";
        pointer.dataset.show = "";
        s.pointAt(s.part(file), "middle");
      });
      at(from + 600, (s) => {
        const g = s.part("ghost");
        g.textContent = s.part(file).textContent;
        g.dataset.show = "";
        s.part(file).dataset.lifted = "";
      });
      at(from + 700, (s) => s.pointAt(petBody(s), "middle"));
      at(from + 1400, (s) => {
        delete s.part("ghost").dataset.show;
        delete s.part(file).dataset.lifted;
        s.part("pile").dataset.show = "";
        s.part("count").textContent = String(count);
        hop(s);
        s.pet.play("jumping");
      });
    };
    carry(200, "file1", 1);
    carry(2200, "file2", 2);
    // ③ The chat opens; drag the whole pile into it.
    at(4400, (s) => {
      s.part("window").hidden = true;
      s.part("chatwin").dataset.show = "";
      s.pointAt(s.part("pile"), "middle");
    });
    at(5100, (s) => {
      click(s);
      const g = s.part("ghost");
      g.textContent = t("demo.files.both");
      g.dataset.show = "";
    });
    at(5200, (s) => s.pointAt(s.part("drop"), "middle"));
    at(6000, (s) => {
      delete s.part("ghost").dataset.show;
      s.part("drop").dataset.show = "";
      s.pet.play("waving");
    });
    return cues;
  },
};
