// What the user reads, in their language (plan/15). One table per language in
// apps/shared/locales; Chinese is the source and the fallback.
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type zhLocale from "../../shared/locales/zh.json";
import { fillText, type Vars } from "../../shared/localeText.ts";

export type Lang = "zh" | "en";
export type Key = keyof typeof zhLocale;

// The browser preview and its tests stay Chinese unless ?lang=en asks; so do
// unit tests that load a page module in Node.
async function current(): Promise<Lang> {
  if (typeof location === "undefined") return "zh";
  if (isTauri())
    return (await invoke("app_language").catch(() => "")) === "en"
      ? "en"
      : "zh";
  if (new URLSearchParams(location.search).get("lang") === "en") return "en";
  if (location.pathname === "/en" || location.pathname.startsWith("/en/"))
    return "en";
  return "zh";
}
export const lang = await current();
const table: Record<string, string> =
  lang === "en"
    ? (await import("../../shared/locales/en.json")).default
    : (await import("../../shared/locales/zh.json")).default;
/** For dates and times shown to the user. */
export const dateLocale = lang === "zh" ? "zh-CN" : "en-US";
if (typeof document !== "undefined")
  document.documentElement.lang = lang === "zh" ? "zh-CN" : "en";

/** `{name}` in the text is replaced by `vars.name`. */
export function t(key: Key, vars: Vars = {}) {
  return fillText(table[key] ?? "", vars);
}
/** A name from a shared catalog (a service, say), in the user's language
 * when the table has it, else as the catalog writes it. */
export function named(key: string, fallback: string) {
  return table[key] ?? fallback;
}
/** A count: `key.one` / `key.other` by the language's plural rule; `{n}` is the count. */
export function tn(key: string, n: number, vars: Vars = {}) {
  const form = new Intl.PluralRules(lang).select(n);
  const pick = key + "." + form in table ? form : "other";
  return t((key + "." + pick) as Key, { n, ...vars });
}

// Every window follows a change of language by reloading itself.
if (isTauri())
  void listen("companion-settings", async () => {
    if ((await current()) !== lang) location.reload();
  });
