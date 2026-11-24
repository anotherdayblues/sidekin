// What the brain says to the user itself (step names, fallback replies), in
// their language (plan/15). Prompts and tool results stay in Chinese.
import zh from "../../shared/locales/zh.json" with { type: "json" };
import en from "../../shared/locales/en.json" with { type: "json" };
import { fillText, type Vars } from "../../shared/localeText.ts";

type Key = keyof typeof zh;
const tables: Record<string, Record<string, string>> = { zh, en };
let current = tables.zh;

/** From the host's configuration: "zh" or "en". */
export function setLocale(locale?: string) {
  current = locale === "en" ? tables.en : tables.zh;
}
/** The user's language, as the host configured it. */
export function english() {
  return current === tables.en;
}
export function t(key: Key, vars?: Vars) {
  return fillText(current[key] ?? zh[key], vars);
}
/** Whether a message from the host carries this text, in either language. */
export function says(message: string, key: Key) {
  return [tables.zh[key], tables.en[key]].some(
    (s) => !!s && message.includes(s),
  );
}
