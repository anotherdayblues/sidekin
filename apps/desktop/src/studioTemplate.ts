import { t } from "./i18n.ts";
export const TEMPLATE = `
<div id="dimmer" aria-hidden="true"></div>
<div class="studio" data-title="${t("studio.pet")}">
  <div class="titlebar" aria-hidden="true" data-titlebar></div>
  <nav class="rail" aria-label="${t("settings.companion")}">
    <div class="brand" aria-hidden="true" data-titlebar><span class="brand-word">${t("app.name")}</span></div>
    <div class="roster" id="roster" data-heading="${t("studio.myPets")}"></div>
    <div class="rail-foot">
      <button id="add" class="rail-key" aria-label="${t("studio.import")}" aria-haspopup="menu"><span class="plus"></span></button>
      <button type="button" id="skills-key" class="rail-key help-key" aria-label="${t("skills.title")}" title="${t("skills.title")}"><span aria-hidden="true">?</span></button>
    </div>
  </nav>
  <div class="shell">
  <header class="shell-head">
    <nav class="blocks" id="blocks" role="tablist" aria-label="${t("studio.blocks")}">
      <i class="blocks-key" aria-hidden="true"></i>
      <button role="tab" data-block="pet" aria-selected="true">${t("studio.pet")}<i class="block-dot" hidden></i></button>
      <button role="tab" data-block="memory" aria-selected="false">${t("memory.title")}</button>
      <button role="tab" data-block="reminders" aria-selected="false">${t("todo.title")}</button>
      <button role="tab" data-block="focus" aria-selected="false">${t("studio.focus")}</button>
      <button role="tab" data-block="settings" aria-selected="false">${t("studio.settings")}</button>
    </nav>
    <button class="appearance" id="theme-key" data-mode="system" aria-label="${t("studio.themeKey", { mode: t("theme.system") })}">
      <span class="brand-mark" aria-hidden="true"></span>
      <svg class="ap-glyph" viewBox="0 0 20 20" aria-hidden="true"><g class="ap-sun"><circle cx="10" cy="10" r="3.6"/><path d="M10 1.8v2.4M10 15.8v2.4M1.8 10h2.4M15.8 10h2.4M4.2 4.2l1.7 1.7M14.1 14.1l1.7 1.7M4.2 15.8l1.7-1.7M14.1 5.9l1.7-1.7"/></g><path class="ap-moon" d="M15.6 12.6A6.6 6.6 0 0 1 7.4 4.4a6.6 6.6 0 1 0 8.2 8.2z"/><g class="ap-auto"><circle cx="10" cy="10" r="6.6"/><path d="M10 3.4a6.6 6.6 0 0 1 0 13.2z"/></g></svg>
    </button>
  </header>
  <div class="block block-pet" data-for="pet">
  <main class="deck">
    <header class="deck-head" data-titlebar>
      <div class="title">
        <h1 id="name">${t("app.name")}</h1>
        <p id="desc"></p>
      </div>
      <div class="lcd" role="status" aria-live="polite"><span class="lcd-dot"></span><span id="lcd"></span></div>
    </header>
    <section class="window" id="window" aria-label="${t("studio.window")}">
      <div class="light" aria-hidden="true"></div>
      <div class="lamp" aria-hidden="true"></div>
      <div class="sun" aria-hidden="true"><i></i></div>
      <div class="pedestal" id="pedestal" aria-hidden="true"></div>
      <canvas id="stage" aria-label="${t("studio.stage")}"></canvas>
      <div class="empty" id="empty" hidden>
        <h2>${t("studio.noPet")}</h2>
        <p>${t("studio.noPetHow")}</p>
        <button id="meet" class="key primary">${t("studio.meet")}</button>
      </div>
      <button type="button" id="wardrobe-key" class="wardrobe-trigger" aria-controls="wardrobe-pane" aria-expanded="false" hidden><svg class="wardrobe-glyph" viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.2a1.5 1.5 0 0 1 1.5 1.5c0 .7-.45 1.15-1.05 1.45L8 5.4l5.4 3.45a1 1 0 0 1-.54 1.85H3.14a1 1 0 0 1-.54-1.85L8 5.4"/></svg><span id="wardrobe-key-label"></span></button>
      <div class="window-foot label"><span id="playing">${t("studio.idle")}</span></div>
      <div class="drop-import-cue" id="drop-import-cue" hidden><span>${t("studio.dropImportCue")}</span></div>
    </section>
    <div class="controls" id="controls">
      <div class="control"><span class="silk">${t("studio.desk")}</span><input class="slide-switch" type="checkbox" id="desk" role="switch" aria-label="${t("studio.desk")}"></div>
      <div class="control"><span class="silk">${t("studio.motion")}</span><input class="slide-switch" type="checkbox" id="motion" role="switch" aria-label="${t("studio.motion")}"></div>
      <div class="control knob-control"><span class="silk">${t("studio.size")}</span><div class="knob" id="size" role="slider" tabindex="0" aria-label="${t("studio.deskSize")}" aria-valuemin="80" aria-valuemax="280"><svg class="knob-ticks" viewBox="0 0 54 54" aria-hidden="true"><line x1="10.0" y1="44.0" x2="8.3" y2="45.7"/><line x1="4.2" y1="34.4" x2="1.8" y2="35.2"/><line x1="3.3" y1="23.2" x2="0.8" y2="22.9"/><line x1="7.6" y1="12.9" x2="5.6" y2="11.4"/><line x1="16.1" y1="5.6" x2="15.0" y2="3.4"/><line x1="27.0" y1="3.0" x2="27.0" y2="0.5"/><line x1="37.9" y1="5.6" x2="39.0" y2="3.4"/><line x1="46.4" y1="12.9" x2="48.4" y2="11.4"/><line x1="50.7" y1="23.2" x2="53.2" y2="22.9"/><line x1="49.8" y1="34.4" x2="52.2" y2="35.2"/><line x1="44.0" y1="44.0" x2="45.7" y2="45.7"/></svg><div class="knob-cap"><span class="knob-mark"></span></div></div><input type="range" class="size-range" id="size-range" min="80" max="280" step="20" value="160" aria-label="${t("studio.deskSize")}"><span class="knob-value mono" id="size-value">160</span></div>
    </div>
    <section class="tape" aria-label="${t("studio.actions")}">
      <div class="tape-head">
        <div class="tape-tabs" role="tablist" aria-label="${t("studio.actions")}">
          <button type="button" role="tab" data-group="base" aria-selected="true">${t("studio.baseActions")}<span class="tape-n" id="base-count"></span></button>
          <button type="button" role="tab" data-group="learned" aria-selected="false">${t("studio.learnedActions")}<span class="tape-n" id="learned-count"></span></button>
        </div>
        <button type="button" id="teach" class="teach-plus" aria-label="${t("studio.teach")}"><span aria-hidden="true">+</span></button>
        <div class="tape-tools" id="tape-tools"></div>
        <div class="tape-pager" id="tape-pager" hidden><button type="button" class="tape-page" data-dir="-1" aria-label="${t("studio.tapePrev")}" title="${t("studio.tapePrev")}"></button><button type="button" class="tape-page" data-dir="1" aria-label="${t("studio.tapeNext")}" title="${t("studio.tapeNext")}"></button></div>
      </div>
      <div class="tape-scroll" id="actions"></div>
    </section>
  </main>
  <aside class="side" aria-label="${t("studio.actions")}">
    <header class="side-head" data-titlebar>
      <h2 id="draft-heading" hidden>${t("studio.tricks")}</h2>
      <button type="button" class="cards-key" id="cards-key" aria-haspopup="dialog" aria-expanded="false">${t("home.cards")}</button>
    </header>
    <div class="slot" id="slot" hidden><div class="reader"><span class="reader-led" id="slit-led"></span><button class="reader-key" id="draft-prev" aria-label="${t("studio.prevDraft")}" hidden>‹</button><span class="reader-screen" id="reader-screen"></span><button class="reader-key" id="draft-next" aria-label="${t("studio.nextDraft")}" hidden>›</button><span class="slit"></span></div><div class="cards" id="cards"></div></div>
    <div class="side-body" id="side-body">
    <div class="widgets" id="widgets"></div>
    <footer class="versions" id="versions"></footer>
    </div>
    <section class="wardrobe-pane" id="wardrobe-pane" aria-label="${t("wardrobe.title")}" hidden></section>
  </aside>
  </div>
  <section class="block" data-for="memory" hidden></section>
  <section class="block" data-for="reminders" hidden></section>
  <section class="block" data-for="focus" hidden></section>
  <section class="block" data-for="settings" hidden></section>
  </div>
</div>
<div class="pop" id="pop" hidden></div>`;
