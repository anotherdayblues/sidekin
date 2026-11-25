// What the brain says to the user itself (step names, fallback replies), in
// their language (plan/15 + registry SSOT). Core prompts and tool results stay Chinese.
import zh from "../../shared/locales/zh.json" with { type: "json" };
import en from "../../shared/locales/en.json" with { type: "json" };
import zhTW from "../../shared/locales/zh-TW.json" with { type: "json" };
import ja from "../../shared/locales/ja.json" with { type: "json" };
import ko from "../../shared/locales/ko.json" with { type: "json" };
import { fillText, type Vars } from "../../shared/localeText.ts";
import {
  DEFAULT_LOCALE,
  getLocale,
  isLocale,
  lookupText,
  type LocaleEntry,
} from "../../shared/locales/index.ts";

type Key = keyof typeof zh;
const tables: Record<string, Record<string, string>> = { zh, en, "zh-TW": zhTW, ja, ko };
let currentId: string = DEFAULT_LOCALE;

/** From the host's configuration: any registered locale id (defaults to registry.default). */
export function setLocale(locale?: string) {
  currentId = isLocale(locale) ? locale : DEFAULT_LOCALE;
}

/** Active locale metadata from the shared registry. */
export function currentLocale(): LocaleEntry {
  return getLocale(currentId);
}

export function t(key: Key, vars?: Vars) {
  return fillText(lookupText(key, currentId, tables) ?? zh[key], vars);
}

/** Whether a message from the host carries this text, in any registered language. */
export function says(message: string, key: Key) {
  return Object.values(tables).some(
    (table) => !!table[key] && message.includes(table[key]),
  );
}
