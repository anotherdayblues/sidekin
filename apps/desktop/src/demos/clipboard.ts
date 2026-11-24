// 剪贴板: matches the website's clipFilm craft — clean chat card on the left,
// keycaps below, pet on the right, and a realistic clipboard history popup
// showing a pinned link, an OCR image thumbnail, and copied text that filters
// live as you type and pastes straight back on Enter.
import { t } from "../i18n.ts";
import { typeIn, type Demo } from "./demoTypes.ts";
import { barePet, hop, keycaps, keysDone, pressKeys, timeline } from "./demoParts.ts";

const SEARCH_SVG = `<svg class="demo-clip-ico" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"><circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/></svg>`;
const LINK_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6.8 9.2a2.8 2.8 0 0 0 4 0l1.6-1.6a2.8 2.8 0 0 0-4-4l-.9.9"/><path d="M9.2 6.8a2.8 2.8 0 0 0-4 0L3.6 8.4a2.8 2.8 0 0 0 4 4l.9-.9"/></svg>`;
const TEXT_SVG = `<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><path d="M3 4.5h10M3 8h10M3 11.5h6.5"/></svg>`;
const PIN_SVG = `<svg class="demo-clip-pin" viewBox="0 0 16 16" fill="currentColor"><path d="M9.8 2.2 13.8 6.2l-1.1 1.1-.8-.3-2.1 2.1.4 2.2-1 1-2.3-2.3-2.7 2.7-.8-.8 2.7-2.7-2.3-2.3 1-1 2.2.4 2.1-2.1-.3-.8 1.1-1.1Z"/></svg>`;
const THUMB_SVG = `<svg class="demo-clip-thumb" viewBox="0 0 44 30" aria-hidden="true"><rect width="44" height="30" rx="5" fill="#eaf1fd"/><rect x="4" y="4" width="36" height="22" rx="3" fill="#fff" stroke="#cfddf6"/><rect x="8" y="8" width="12" height="3" rx="1.5" fill="#3b72f6"/><rect x="8" y="14" width="22" height="2.5" rx="1" fill="#334155"/><rect x="8" y="19" width="14" height="2" rx="1" fill="#94a3b8"/></svg>`;

const chatCard = () =>
  `<section class="demo-clip-card" data-part="card">
    <header class="demo-clip-head"><i class="demo-clip-dot"></i><b>${t("demo.clipboard.room")}</b></header>
    <div class="demo-clip-body">
      <p class="demo-clip-ask">${t("demo.clipboard.ask")}</p>
      <div class="demo-clip-composer" data-part="composer">
        <p class="demo-field demo-clip-reply" data-placeholder="${t("demo.clipboard.placeholder")}"><span data-part="pasted-text"></span><i class="demo-caret"></i></p>
        <b class="demo-clip-badge" data-part="badge">${t("demo.clipboard.pasted")}</b>
      </div>
    </div>
  </section>`;

const panel = () =>
  `<aside class="demo-clip" data-part="clip">
    <div class="demo-clip-search-bar">${SEARCH_SVG}<p class="demo-field demo-clip-search" data-placeholder="${t("demo.clipboard.searchPlaceholder")}"><span data-part="query"></span><i class="demo-caret"></i></p></div>
    <div class="demo-clip-tabs"><b data-on>${t("demo.clipboard.all")}</b><span>${t("demo.clipboard.text")}</span><span>${t("demo.clipboard.image")}</span></div>
    <ul class="demo-clip-list">
      <li class="demo-clip-row" data-part="row1"><span class="demo-clip-kind link">${LINK_SVG}</span><span class="demo-clip-copy"><b>${t("demo.clipboard.link")}</b><small>${t("demo.clipboard.linkMeta")}</small></span>${PIN_SVG}</li>
      <li class="demo-clip-row" data-part="row2">${THUMB_SVG}<span class="demo-clip-copy"><b>${t("demo.clipboard.item2")}</b><small>${t("demo.clipboard.imgMeta")}</small></span></li>
      <li class="demo-clip-row" data-part="row3"><span class="demo-clip-kind">${TEXT_SVG}</span><span class="demo-clip-copy"><b>${t("demo.clipboard.item3")}</b><small>${t("demo.clipboard.item3Meta")}</small></span></li>
      <li class="demo-clip-row" data-part="hit" data-hide><span class="demo-clip-kind">${TEXT_SVG}</span><span class="demo-clip-copy"><b>${t("demo.clipboard.item1")}</b><small>${t("demo.clipboard.item1Meta")}</small></span></li>
    </ul>
  </aside>`;

export const clipboard: Demo = {
  id: "clipboard",
  length: 7400,
  captions: (c) => [
    { at: 0, text: t("demo.clipboard.step1", { key: c.label("clipboard") }) },
    { at: 1850, text: t("demo.clipboard.step2") },
    { at: 4700, text: t("demo.clipboard.step3") },
  ],
  stills: [1200, 3500, 6000],
  markup: (c) =>
    chatCard() +
    keycaps(c.keys("clipboard")) +
    barePet() +
    panel(),
  cues(c) {
    const { cues, at } = timeline();
    const n = c.keys("clipboard").length;
    const up = pressKeys(at, n, 520);
    at(up + 80, (s) => {
      s.part("clip").dataset.show = "";
      hop(s);
      s.pet.setGaze({ x: -0.25, y: -0.75 });
    });
    at(up + 650, keysDone);
    const query = t("demo.clipboard.query");
    for (const cue of typeIn("query", query, 2200, 240)) at(cue.at, cue.run);
    at(2200 + [...query].length * 240 + 220, (s) => {
      s.part("row1").dataset.hide = "";
      s.part("row2").dataset.hide = "";
      s.part("row3").dataset.hide = "";
      delete s.part("hit").dataset.hide;
      s.part("hit").dataset.on = "";
    });
    at(4700, (s) => {
      delete s.part("clip").dataset.show;
      s.part("pasted-text").textContent = t("demo.clipboard.item1");
      s.part("composer").dataset.flash = "";
      s.part("badge").dataset.show = "";
      hop(s);
      s.pet.setGaze({ x: -0.9, y: -0.2 });
    });
    at(5400, (s) => delete s.part("composer").dataset.flash);
    at(6000, (s) => s.pet.setGaze(null));
    return cues;
  },
};
