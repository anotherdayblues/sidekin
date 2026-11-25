// What the user reads, in their language (plan/15 + registry SSOT).
// One table per language in apps/shared/locales; fallback chain comes from registry.json.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type zhLocale from "../../shared/locales/zh.json";
import { fillText, type Vars } from "../../shared/localeText.ts";
import {
  DEFAULT_LOCALE,
  getLocale,
  isLocale,
  lookupText,
  resolveLocaleFromPath,
  type Lang,
} from "../../shared/locales/index.ts";

export { type Lang };
export type Key = keyof typeof zhLocale;

const LOADERS: Record<
  string,
  () => Promise<{ default: Record<string, string> }>
> = {
  zh: () => import("../../shared/locales/zh.json"),
  en: () => import("../../shared/locales/en.json"),
  "zh-TW": () => import("../../shared/locales/zh-TW.json"),
  ja: () => import("../../shared/locales/ja.json"),
  ko: () => import("../../shared/locales/ko.json"),
};

// The browser preview and its tests stay default Chinese unless ?lang=<id> or
// a locale path asks; so do unit tests that load a page module in Node.
async function current(): Promise<Lang> {
  if (typeof location === "undefined") return DEFAULT_LOCALE as Lang;
  if (isTauri()) {
    const raw = await invoke<string>("app_language").catch(() => "");
    return isLocale(raw) ? raw : (DEFAULT_LOCALE as Lang);
  }
  const asked = new URLSearchParams(location.search).get("lang");
  if (isLocale(asked)) return asked;
  return resolveLocaleFromPath(location.pathname) as Lang;
}

export const lang: Lang = await current();
const meta = getLocale(lang);

const tables: Record<string, Record<string, string>> = {};
const chain = [...new Set([...meta.fallback, DEFAULT_LOCALE])];
await Promise.all(
  chain.map(async (id) => {
    const load = LOADERS[id];
    if (load) tables[id] = (await load()).default;
  }),
);

/** For dates and times shown to the user. */
export const dateLocale = meta.dateLocale;

/** `{name}` in the text is replaced by `vars.name`. */
export function t(key: Key, vars: Vars = {}) {
  return fillText(lookupText(key, lang, tables) ?? "", vars);
}

/** Keep document language and localized window title aligned with the active locale. */
export function syncDocumentLocale() {
  if (typeof document === "undefined") return;
  document.documentElement.lang = meta.htmlLang;
  const isPet =
    typeof location !== "undefined" &&
    new URLSearchParams(location.search).has("pet");
  document.title = t(isPet ? "app.name" : "host.studioTitle");
}
syncDocumentLocale();
/** A name from a shared catalog (a service, say), in the user's language
 * when the table has it, else as the catalog writes it. */
export function named(key: string, fallback: string) {
  return lookupText(key, lang, tables) ?? fallback;
}
/** A count: `key.one` / `key.other` by the language's plural rule; `{n}` is the count. */
export function tn(key: string, n: number, vars: Vars = {}) {
  const form = new Intl.PluralRules(dateLocale).select(n);
  const candidate = key + "." + form;
  const pick =
    lookupText(candidate, lang, tables) !== undefined ? form : "other";
  return t((key + "." + pick) as Key, { n, ...vars });
}

// Every window follows a change of language by reloading itself.
if (isTauri())
  void listen("companion-settings", async () => {
    if ((await current()) !== lang) location.reload();
  });
