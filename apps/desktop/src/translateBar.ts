// The translation bar (plan/41): 中文 ⇄ 对方语言, and 语气. Your language goes
// into theirs and theirs comes back into yours, so one choice covers a whole
// chat. 对方语言 is the settings' translationTarget, shared by every window;
// 语气 is kept in this browser only, so older builds never see a new setting.
// The bubble and the 翻译 page both use it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import { lang, t, type Key } from "./i18n.ts";
import "./styles/translate.css";

export type Tone = "auto" | "formal" | "casual";
const TONES: Tone[] = ["auto", "formal", "casual"];
const TONE_KEY = "suiban.translationTone";
// The other side's language, in the reader's words; the brain reads either.
const LANGUAGES: Key[] = [
  "lang.english",
  "lang.chinese",
  "lang.japanese",
  "lang.korean",
  "lang.french",
  "lang.german",
  "lang.spanish",
];
const own = t(lang === "en" ? "lang.english" : "lang.chinese");
/** 对方语言 when none was picked: English for a Chinese reader, and back. */
const fallback = t(lang === "en" ? "lang.chinese" : "lang.english");

function savedTone(): Tone {
  try {
    const v = localStorage.getItem(TONE_KEY);
    return TONES.includes(v as Tone) ? (v as Tone) : "auto";
  } catch {
    return "auto";
  }
}

export interface TranslateBar {
  el: HTMLElement;
  tone(): Tone;
  /** 对方语言 as saved: "auto" or a language name. */
  partner(): string;
  /** Called after either choice changes and is saved. */
  onChange(fn: () => void): void;
}

export function translateBar(): TranslateBar {
  const el = document.createElement("div");
  el.className = "translate-bar";
  el.innerHTML = `<span class="tb-mine"></span><span class="tb-both" aria-hidden="true">⇄</span><select class="tb-partner" aria-label="${t("translate.partner")}" title="${t("translate.partnerHint")}"></select><label class="tb-tone"><span>${t("translate.tone")}</span><select aria-label="${t("translate.tone")}"></select></label>`;
  el.querySelector(".tb-mine")!.textContent = own;
  const partner = el.querySelector<HTMLSelectElement>(".tb-partner")!;
  const tone = el.querySelector<HTMLSelectElement>(".tb-tone select")!;
  for (const id of TONES)
    tone.add(new Option(t(`translate.tone.${id}` as Key), id));
  tone.value = savedTone();
  let saved = "auto";
  const listeners: (() => void)[] = [];

  /** Lists the languages, with a saved one not in the list kept too. */
  function fill(value: string) {
    saved = value || "auto";
    const shown = saved === "auto" ? fallback : saved;
    const names = LANGUAGES.map((k) => t(k)).filter((n) => n !== own);
    if (!names.includes(shown)) names.unshift(shown);
    partner.replaceChildren(...names.map((n) => new Option(n, n)));
    partner.value = shown;
  }
  fill("auto");
  if (native) {
    void invoke<{ translationTarget: string }>("companion_settings").then((s) =>
      fill(s.translationTarget),
    );
    void listen<{ translationTarget: string }>("companion-settings", (e) =>
      fill(e.payload.translationTarget),
    );
  }
  partner.onchange = async () => {
    saved = partner.value;
    if (native)
      await invoke("set_translation_partner", { target: saved }).catch(
        () => {},
      );
    for (const fn of listeners) fn();
  };
  tone.onchange = () => {
    try {
      localStorage.setItem(TONE_KEY, tone.value);
    } catch {
      // Private storage: the choice lasts until the window closes.
    }
    for (const fn of listeners) fn();
  };
  return {
    el,
    tone: () => tone.value as Tone,
    partner: () => saved,
    onChange: (fn) => listeners.push(fn),
  };
}
