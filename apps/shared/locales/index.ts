// Single source of truth for supported locales across Desktop, Rust Host,
// Brain, Phone LAN page, and Website.
import registryData from "./registry.json" with { type: "json" };

export interface BrainLocaleConfig {
  /** "core" keeps the Chinese base prompt verbatim; "overlay" adds a language layer. */
  promptMode: "core" | "overlay";
  /** English display name used in generic overlay prompt templates. */
  promptName: string;
  /** Chinese language name inserted into translate.md's {{目标语言}}. */
  promptNameZh: string;
  /** Default partner language (in Chinese, for translate.md) when user leaves target on auto. */
  defaultPartnerZh: string;
  /** Case-insensitive regex matching names of this locale itself (prevents translating to self). */
  selfPattern: string;
  /** Optional fast script heuristic when deciding translation direction locally. */
  scriptHeuristic?: "han";
}

export interface LocaleEntry {
  id: string;
  nativeName: string;
  shortLabel: string;
  htmlLang: string;
  hreflang: string;
  dateLocale: string;
  hour12: boolean;
  matchTags: readonly string[];
  fallback: readonly string[];
  websitePath: string;
  guidePath: string;
  brain: BrainLocaleConfig;
}

export interface LocaleRegistry {
  default: string;
  systemFallback: string;
  locales: readonly LocaleEntry[];
}

export const registry: LocaleRegistry = registryData as LocaleRegistry;
export const LOCALES = registry.locales;
export const DEFAULT_LOCALE = registry.default;
export const SYSTEM_FALLBACK_LOCALE = registry.systemFallback;

export type Lang = (typeof registryData.locales)[number]["id"];
export type LanguageChoice = "system" | Lang;

export const LOCALE_IDS: readonly Lang[] = registryData.locales.map(
  (item) => item.id,
) as Lang[];
export const LANGUAGE_CHOICES: readonly LanguageChoice[] = [
  "system",
  ...LOCALE_IDS,
];

export function isLocale(
  value: string | null | undefined,
  reg: LocaleRegistry = registry,
): value is Lang {
  return !!value && reg.locales.some((item) => item.id === value);
}

export function getLocale(
  id: string | null | undefined,
  reg: LocaleRegistry = registry,
): LocaleEntry {
  return (
    reg.locales.find((item) => item.id === id) ??
    reg.locales.find((item) => item.id === reg.default) ??
    reg.locales[0]
  );
}

/** Normalize an OS / BCP-47 tag like "zh_Hant_TW.UTF-8" -> "zh-hant-tw". */
export function normalizeLocaleTag(tag: string): string {
  return tag
    .trim()
    .split(/[.@]/, 1)[0]
    .replaceAll("_", "-")
    .toLowerCase();
}

function matchSingleTag(
  rawTag: string,
  reg: LocaleRegistry,
): string | undefined {
  const normalized = normalizeLocaleTag(rawTag);
  if (!normalized) return undefined;
  let bestId: string | undefined;
  let bestLen = -1;
  for (const locale of reg.locales) {
    for (const pattern of locale.matchTags) {
      const p = normalizeLocaleTag(pattern);
      if (!p) continue;
      if (normalized === p || normalized.startsWith(p + "-")) {
        if (p.length > bestLen) {
          bestLen = p.length;
          bestId = locale.id;
        }
      }
    }
  }
  return bestId;
}

/** Match an ordered list of preferred OS/browser language tags against the registry. */
export function matchLocaleTags(
  tags: readonly string[],
  reg: LocaleRegistry = registry,
): string {
  for (const tag of tags) {
    const matched = matchSingleTag(tag, reg);
    if (matched) return matched;
  }
  return reg.systemFallback;
}

/** Resolve a saved user preference ("system" or a locale id) to an active locale id. */
export function resolveLocaleChoice(
  choice: string | null | undefined,
  systemTags: readonly string[] = [],
  reg: LocaleRegistry = registry,
): string {
  if (choice && choice !== "system" && isLocale(choice, reg)) return choice;
  return matchLocaleTags(systemTags, reg);
}

/** Match a website/preview URL pathname (e.g. "/en/guide/" or "/ja/") to a locale id. */
export function resolveLocaleFromPath(
  pathname: string,
  reg: LocaleRegistry = registry,
): string {
  const clean = (pathname || "/").toLowerCase();
  const prefixed = reg.locales
    .filter((item) => item.websitePath !== "/")
    .sort((a, b) => b.websitePath.length - a.websitePath.length);
  for (const locale of prefixed) {
    const base = locale.websitePath.replace(/\/+$/, "").toLowerCase();
    if (clean === base || clean.startsWith(base + "/")) return locale.id;
  }
  return reg.default;
}

/** Look up a key across a locale's fallback chain in the supplied tables. */
export function lookupText(
  key: string,
  lang: string,
  tables: Record<string, Record<string, string> | undefined>,
  reg: LocaleRegistry = registry,
): string | undefined {
  const entry = getLocale(lang, reg);
  const chain = [...entry.fallback, reg.default];
  const tried = new Set<string>();
  for (const id of chain) {
    if (tried.has(id)) continue;
    tried.add(id);
    const value = tables[id]?.[key];
    if (value !== undefined) return value;
  }
  return undefined;
}
