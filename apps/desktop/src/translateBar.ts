// The translation bar (plan/41): 中文 ⇄ 对方语言, and 语气. Your language goes
// into theirs and theirs comes back into yours, so one choice covers a whole
// chat. 对方语言 is the settings' translationTarget, shared by every window;
// 语气 is kept in this browser only, so older builds never see a new setting.
// The bubble and the 翻译 page both use it.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import { lang, t, type Key } from "./i18n.ts";
import {
  normalizeTranslationTarget,
  ownTranslationLabel,
  resolvePartnerBar,
} from "./translateLang.ts";
import "./styles/translate.css";

export type Tone = "auto" | "formal" | "casual";
const TONES: Tone[] = ["auto", "formal", "casual"];
const TONE_KEY = "suiban.translationTone";
const own = ownTranslationLabel(lang, t);

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
  /** 对方语言 as saved: "auto", a canonical code ("en", "ja", ...), or a custom name. */
  partner(): string;
  /** Called after either choice changes and is saved. */
  onChange(fn: () => void): void;
}

/** Reads plain text currently on the system clipboard without touching clipboard history. */
export async function readClipboardText(): Promise<string> {
  if (native) {
    return (await invoke<string>("read_clipboard_text").catch(() => "")) ?? "";
  }
  try {
    return (await navigator.clipboard?.readText()) ?? "";
  } catch {
    return "";
  }
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

  /** Lists the languages with canonical option values and localized labels,
   * normalizing any legacy saved localized name cleanly. */
  function fill(value: string) {
    const resolved = resolvePartnerBar(value, lang, t);
    saved = resolved.normalized;
    partner.replaceChildren(
      ...resolved.options.map((o) => new Option(o.label, o.value)),
    );
    partner.value = resolved.selected;
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
    saved = normalizeTranslationTarget(partner.value);
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
