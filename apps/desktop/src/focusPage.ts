// 专注: the main window's page for the 番茄钟 (plan/19, plan/29), now its
// records only. A tomato starts, pauses and ends on the desktop, from the
// pet; this page looks back, as the reports of Pomofocus, Super
// Productivity and TickTick do: three numbers, each day, today's sessions
// and what the week went on (focusRecord.ts). The timer's settings sit
// below the records. Everything else lives in focus.rs.
import "./styles/focus-page.css";
import * as api from "./bridge.ts";
import {
  focusState,
  onFocus,
  previewFocus,
  saveFocusSettings,
  type FocusSettings,
  type FocusState,
} from "./focus.ts";
import { mountFocusRecord } from "./focusRecord.ts";
import { t, type Key } from "./i18n.ts";

const AMBIENT: FocusSettings["ambient"][] = ["off", "noise", "rain", "pages"];

function toggle(
  key: "autoBreak" | "autoNext" | "holdReminders" | "chime" | "petTint",
) {
  return `<label><span>${t(`focus.${key}`)}</span><input type="checkbox" role="switch" class="slide-switch" data-setting="${key}"></label>`;
}

export function mountFocusPage(app: HTMLElement) {
  const block = app.querySelector<HTMLElement>('.block[data-for="focus"]');
  if (!block) return;
  block.insertAdjacentHTML(
    "beforeend",
    `<header class="block-head focus-head"><h2>${t("focus.title")}</h2><p class="silk">${t("focus.statsNote", { item: t("focus.start") })}</p>
    </header>
    <div class="focus-stats">
      <div class="focus-tiles" data-part="tiles"></div>
      <section class="focus-card focus-days" aria-label="${t("focus.chart")}">
        <header class="focus-card-head"><h3>${t("focus.chart")}</h3>
          <div class="focus-range" data-part="range" role="group"><button type="button" data-range="week">${t("focus.week")}</button><button type="button" data-range="month">${t("focus.month")}</button></div>
        </header>
        <ol class="focus-bars" data-part="chart"></ol>
      </section>
      <div class="focus-two">
        <section class="focus-card"><header class="focus-card-head"><h3>${t("focus.todayList")}</h3></header><div data-part="today"></div></section>
        <section class="focus-card"><header class="focus-card-head"><h3>${t("focus.spentTitle")}</h3></header><div data-part="spent"></div></section>
      </div>
      <section class="focus-settings" aria-labelledby="focus-settings-heading">
        <h3 id="focus-settings-heading">${t("focus.settings")}</h3>
        <div class="focus-card focus-times">
          <label>${t("focus.focusMinutes")}<input type="number" min="1" max="180" data-setting="focusMinutes"></label>
          <label>${t("focus.breakMinutes")}<input type="number" min="1" max="60" data-setting="breakMinutes"></label>
          <label>${t("focus.longBreakMinutes")}<input type="number" min="1" max="90" data-setting="longBreakMinutes"></label>
          <label>${t("focus.longEvery")}<input type="number" min="2" max="12" data-setting="longEvery"></label>
        </div>
        <div class="focus-two">
          <section class="focus-card focus-options"><h4>${t("focus.automation")}</h4>
            ${(["autoBreak", "autoNext", "holdReminders"] as const).map(toggle).join("")}
          </section>
          <section class="focus-card focus-options"><h4>${t("focus.soundGroup")}</h4>
            ${toggle("chime")}
          <label>${t("focus.ambient")}<select data-setting="ambient">${AMBIENT.map((a) => `<option value="${a}">${t(`focus.ambient.${a}` as Key)}</option>`).join("")}</select></label>
          <label>${t("focus.volume")}<input type="range" min="0" max="100" step="5" data-setting="volume"></label>
          </section>
        </div>
        <section class="focus-card focus-options"><h4>${t("focus.clockGroup")}</h4>
          ${toggle("petTint")}
        </section>
      </section>
    </div>`,
  );
  const part = (name: string) =>
    block.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  const record = mountFocusRecord({
    tiles: part("tiles"),
    chart: part("chart"),
    range: part("range"),
    today: part("today"),
    spent: part("spent"),
  });
  let state: FocusState | null = null;
  const draw = (s: FocusState) => {
    state = s;
    for (const input of block.querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >("[data-setting]")) {
      const key = input.dataset.setting as keyof FocusSettings;
      if (document.activeElement === input) continue;
      if (input instanceof HTMLInputElement && input.type === "checkbox")
        input.checked = Boolean(s.settings[key]);
      else input.value = String(s.settings[key]);
    }
    record.draw(s);
  };

  block.querySelector(".focus-settings")!.addEventListener("change", (e) => {
    // Not companion settings: keep these out of any form's save.
    e.stopPropagation();
    if (!state) return;
    const next = { ...state.settings };
    for (const input of block.querySelectorAll<
      HTMLInputElement | HTMLSelectElement
    >("[data-setting]")) {
      const key = input.dataset.setting as keyof FocusSettings;
      const value =
        input instanceof HTMLInputElement && input.type === "checkbox"
          ? input.checked
          : input instanceof HTMLInputElement
            ? Number(input.value)
            : input.value;
      Object.assign(next, { [key]: value });
    }
    void saveFocusSettings(next).then(draw);
  });

  // Screenshot scripts set the timer directly.
  if (!api.native) Object.assign(window, { __focus: previewFocus });
  void focusState().then(draw);
  void onFocus((s) => draw(s));
}
