// 从手机传 (plan/20): right-click the pet, pick 从手机传, scan the code with
// the phone, pick photos and send; say 收下 on the computer and the photos
// fly onto the pet's pile.
import { t, tn } from "../i18n.ts";
import type { Demo } from "./demoTypes.ts";
import {
  bubbleState,
  click,
  hop,
  petWithBubble,
  piece,
  timeline,
} from "./demoParts.ts";

const menu = () =>
  `<div class="demo-menu demo-focus-menu" data-part="menu">
    <p>${t("focus.start")}</p>
    <p data-part="menu-item">${t("phone.menu.start")}</p>
    <p>${t("menu.openChat")}</p>
  </div>`;
const phone = () =>
  `<div class="demo-phone" data-part="phone" data-step="scan">
    <i class="demo-phone-island"></i>
    <div class="demo-phone-scan"><i></i></div>
    <div class="demo-phone-app">
      <b>${t("phone.page.title", { pet: "" }).trim()}</b>
      <div class="demo-phone-tiles"><span data-part="tile"><i></i><i></i><i></i></span><span></span><span></span></div>
      <p class="demo-phone-state" data-part="phone-state"></p>
    </div>
  </div>`;
const qr = () => `<div class="demo-qr" data-part="qr"></div>`;
const choices = () =>
  `<span class="demo-choices" data-part="choices"><b data-part="accept">${t("phone.accept")}</b><i>${t("phone.reject")}</i></span>`;
const flyers = () =>
  [0, 1, 2].map((i) => `<i class="demo-fly" data-part="fly${i}"></i>`).join("");
const pile = () =>
  `<div class="demo-pile" data-part="pile"><i></i><i></i><b data-part="count">0</b></div>`;

export const phoneDemo: Demo = {
  id: "phone",
  length: 9200,
  captions: () => [
    { at: 0, text: t("demo.phone.step1", { item: t("phone.menu.start") }) },
    { at: 2600, text: t("demo.phone.step2") },
    { at: 4700, text: t("demo.phone.step3") },
  ],
  stills: [2400, 4300, 7600],
  markup: () =>
    phone() +
    petWithBubble(qr() + piece.text + choices()) +
    menu() +
    pile() +
    flyers(),
  cues() {
    const { cues, at } = timeline();
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
    at(1300, (s) => s.pointAt(s.part("menu-item"), "middle"));
    at(1700, (s) => (s.part("menu-item").dataset.hot = ""));
    // The code in the bubble.
    at(2100, (s) => {
      click(s);
      delete s.part("menu").dataset.show;
      delete s.part("pointer").dataset.show;
      s.part("qr").dataset.show = "";
      s.part("text").textContent = t("phone.scan");
      bubbleState(s, "answer");
    });
    // ② The phone scans, opens the page, picks three photos and sends.
    at(2700, (s) => (s.part("phone").dataset.show = ""));
    at(3400, (s) => (s.part("phone").dataset.step = "app"));
    at(4000, (s) => (s.part("tile").dataset.picked = ""));
    at(4500, (s) => {
      s.part("phone").dataset.step = "wait";
      s.part("phone-state").textContent = t("phone.page.waiting", { pet: "" });
    });
    // ③ The pet asks; 收下; the photos fly onto its pile.
    at(4700, (s) => {
      delete s.part("qr").dataset.show;
      s.part("text").textContent = t("phone.ask", {
        device: t("phone.page.aPhone"),
        what: tn("phone.photos", 3),
      });
      s.part("choices").dataset.show = "";
      s.part("pointer").dataset.show = "";
      s.pointAt(s.part("accept"), "middle");
    });
    at(5500, (s) => {
      click(s);
      s.part("accept").dataset.hot = "";
      s.part("phone").dataset.step = "send";
      s.pet.play("waving");
    });
    at(5800, (s) => {
      delete s.part("bubble").dataset.show;
      delete s.part("pointer").dataset.show;
    });
    [0, 1, 2].forEach((i) =>
      at(6000 + i * 160, (s) => {
        s.part(`fly${i}`).dataset.show = "";
        if (i === 0) s.part("pile").dataset.show = "";
      }),
    );
    [1, 2, 3].forEach((n) =>
      at(
        6600 + (n - 1) * 160,
        (s) => (s.part("count").textContent = String(n)),
      ),
    );
    at(7100, (s) => {
      hop(s);
      s.pet.play("jumping");
      s.part("phone").dataset.step = "done";
      s.part("phone-state").textContent = t("phone.page.done", { pet: "" });
    });
    return cues;
  },
};
