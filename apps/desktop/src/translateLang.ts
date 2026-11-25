// Canonical language codes for translation partner persistence (plan/41 + 5-locale audit).
// Always persists canonical codes ("auto", "en", "zh", "zh-TW", "ja", "ko", "fr", "de", "es")
// or a free-typed custom language string, while normalizing any legacy saved localized name
// (e.g. "日文", "英文", "日本語", "English") so switching UI language never produces "日本語 ⇄ 日文".
import type { Key } from "./i18n.ts";

export type CanonicalTranslationLang =
  | "en"
  | "zh"
  | "zh-TW"
  | "ja"
  | "ko"
  | "fr"
  | "de"
  | "es";

export const PARTNER_LANG_CODES: readonly CanonicalTranslationLang[] = [
  "en",
  "zh",
  "ja",
  "ko",
  "fr",
  "de",
  "es",
];

const LABEL_KEY: Record<CanonicalTranslationLang, Key> = {
  en: "lang.english",
  zh: "lang.chinese",
  "zh-TW": "lang.chinese",
  ja: "lang.japanese",
  ko: "lang.korean",
  fr: "lang.french",
  de: "lang.german",
  es: "lang.spanish",
};

const ALIAS_TO_CODE: Record<string, "auto" | CanonicalTranslationLang> = {
  // auto
  auto: "auto",
  自动: "auto",
  自動: "auto",
  自動選択: "auto",
  자동: "auto",

  // en
  en: "en",
  "en-us": "en",
  "en-gb": "en",
  english: "en",
  英文: "en",
  英语: "en",
  英語: "en",
  영어: "en",

  // zh-TW (must be distinct from zh before generic Chinese aliases)
  "zh-tw": "zh-TW",
  "zh-hant": "zh-TW",
  "zh-hant-tw": "zh-TW",
  "zh-hk": "zh-TW",
  "zh-mo": "zh-TW",
  "traditional chinese": "zh-TW",
  "traditional chinese (taiwan)": "zh-TW",
  繁体中文: "zh-TW",
  繁體中文: "zh-TW",
  "繁體中文（台灣用語）": "zh-TW",
  繁体: "zh-TW",
  繁體: "zh-TW",
  繁体字: "zh-TW",
  繁體字: "zh-TW",
  台湾中文: "zh-TW",
  台灣中文: "zh-TW",
  台湾华语: "zh-TW",
  台灣華語: "zh-TW",
  "중국어 번체": "zh-TW",
  繁体中国語: "zh-TW",

  // zh
  zh: "zh",
  "zh-cn": "zh",
  "zh-hans": "zh",
  "zh-hans-cn": "zh",
  "zh-sg": "zh",
  chinese: "zh",
  "simplified chinese": "zh",
  中文: "zh",
  汉语: "zh",
  漢語: "zh",
  简体中文: "zh",
  簡體中文: "zh",
  中国語: "zh",
  중국어: "zh",

  // ja
  ja: "ja",
  jp: "ja",
  "ja-jp": "ja",
  japanese: "ja",
  日文: "ja",
  日语: "ja",
  日語: "ja",
  日本語: "ja",
  일본어: "ja",

  // ko
  ko: "ko",
  kr: "ko",
  "ko-kr": "ko",
  korean: "ko",
  韩文: "ko",
  韩语: "ko",
  韓文: "ko",
  韓語: "ko",
  한국어: "ko",
  韓国語: "ko",

  // fr
  fr: "fr",
  "fr-fr": "fr",
  french: "fr",
  français: "fr",
  法文: "fr",
  法语: "fr",
  法語: "fr",
  フランス語: "fr",
  프랑스어: "fr",

  // de
  de: "de",
  "de-de": "de",
  german: "de",
  deutsch: "de",
  德文: "de",
  德语: "de",
  德語: "de",
  ドイツ語: "de",
  독일어: "de",

  // es
  es: "es",
  "es-es": "es",
  spanish: "es",
  español: "es",
  西班牙文: "es",
  西班牙语: "es",
  西班牙語: "es",
  スペイン語: "es",
  스페인어: "es",
};

/** Normalize any saved/entered partner language (canonical code or legacy localized name). */
export function normalizeTranslationTarget(
  raw: string | null | undefined,
): string {
  const trimmed = (raw ?? "").trim();
  if (!trimmed) return "auto";
  const key = trimmed.replaceAll("_", "-").toLowerCase();
  return ALIAS_TO_CODE[key] ?? trimmed;
}

export function ownTranslationLang(uiLang: string): CanonicalTranslationLang {
  if (
    uiLang === "zh" ||
    uiLang === "zh-TW" ||
    uiLang === "en" ||
    uiLang === "ja" ||
    uiLang === "ko"
  ) {
    return uiLang;
  }
  return "zh";
}

export function fallbackPartnerLang(uiLang: string): CanonicalTranslationLang {
  return uiLang === "en" ? "zh" : "en";
}

/** True when `code` refers to the same language as the active UI locale. */
export function isOwnTranslationLang(code: string, uiLang: string): boolean {
  const norm = normalizeTranslationTarget(code);
  const own = ownTranslationLang(uiLang);
  if (norm === own) return true;
  if (
    (own === "zh" || own === "zh-TW") &&
    (norm === "zh" || norm === "zh-TW")
  ) {
    return true;
  }
  return false;
}

/** Localized label for a canonical code, legacy name, "auto", or custom free text. */
export function formatTranslationTarget(
  value: string | null | undefined,
  lookup: (key: Key) => string,
): string {
  const norm = normalizeTranslationTarget(value);
  if (norm === "auto") return lookup("settings.auto");
  if (norm === "zh-TW") return "繁體中文";
  if (norm in LABEL_KEY) {
    return lookup(LABEL_KEY[norm as CanonicalTranslationLang]);
  }
  return norm;
}

/** Localized label for the UI user's own language on the left side of the translation bar. */
export function ownTranslationLabel(
  uiLang: string,
  lookup: (key: Key) => string,
): string {
  const own = ownTranslationLang(uiLang);
  return lookup(LABEL_KEY[own]);
}

/** Localized label for the `into` language badge in bubbles and translation history. */
export function formatIntoLang(
  into: string | null | undefined,
  lookup: (key: Key) => string,
): string {
  const trimmed = (into ?? "").trim();
  if (!trimmed) return "";
  const norm = normalizeTranslationTarget(trimmed);
  if (norm === "auto") return trimmed;
  return formatTranslationTarget(norm, lookup);
}

/** Resolve dropdown options and selected canonical code for the translation bar. */
export function resolvePartnerBar(
  saved: string | null | undefined,
  uiLang: string,
  lookup: (key: Key) => string,
): {
  options: { value: string; label: string }[];
  selected: string;
  normalized: string;
} {
  const normalized = normalizeTranslationTarget(saved);
  const selected =
    normalized === "auto" || isOwnTranslationLang(normalized, uiLang)
      ? fallbackPartnerLang(uiLang)
      : normalized;
  const options: { value: string; label: string }[] = PARTNER_LANG_CODES.filter(
    (code) => !isOwnTranslationLang(code, uiLang),
  ).map((code) => ({
    value: code,
    label: formatTranslationTarget(code, lookup),
  }));
  if (!options.some((o) => o.value === selected)) {
    options.unshift({
      value: selected,
      label: formatTranslationTarget(selected, lookup),
    });
  }
  return { options, selected, normalized };
}
