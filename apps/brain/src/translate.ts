import { requests } from "./runtime.ts";
import { fill, text } from "./texts.ts";
import { currentLocale } from "./locale.ts";
import { selectionPrompt } from "./localePrompts.ts";
import type { LocaleEntry } from "../../shared/locales/index.ts";
import { normalizeContext } from "@earendil-works/pi-ai";
import { modelFor, streamModel, fault, type Connection } from "./models.ts";
export type SelectionAction = "translate" | "explain" | "polish" | "summarize";
/** 语气 (plan/41): auto leaves the target language as it is. */
const TONES: Record<string, string> = {
  formal: "语气正式、礼貌",
  casual: "语气随意、口语",
};
/** Canonical language code -> Chinese target label used inside translate.md. */
const CANONICAL_TARGET_ZH: Record<string, string> = {
  en: "英文",
  zh: "中文",
  "zh-cn": "简体中文",
  "zh-hans": "简体中文",
  "zh-tw": "繁體中文（台灣用語）",
  "zh-hant": "繁體中文（台灣用語）",
  ja: "日文",
  ko: "韩文",
  fr: "法文",
  de: "德文",
  es: "西班牙文",
  pt: "葡萄牙文",
  ru: "俄文",
  it: "意大利文",
  ar: "阿拉伯文",
  th: "泰文",
  vi: "越南文",
};

/** Legacy localized human names across all 5 locales -> canonical code. */
const LEGACY_PARTNER_CODE: Record<string, string> = {
  en: "en",
  english: "en",
  英文: "en",
  英语: "en",
  英語: "en",
  영어: "en",
  zh: "zh",
  chinese: "zh",
  中文: "zh",
  汉语: "zh",
  漢語: "zh",
  中国語: "zh",
  중국어: "zh",
  "zh-cn": "zh-cn",
  "zh-hans": "zh-hans",
  简体中文: "zh-hans",
  簡體中文: "zh-hans",
  "simplified chinese": "zh-hans",
  "zh-tw": "zh-tw",
  "zh-hant": "zh-hant",
  繁體中文: "zh-tw",
  繁体中文: "zh-tw",
  "繁體中文（台灣用語）": "zh-tw",
  "traditional chinese": "zh-tw",
  ja: "ja",
  jp: "ja",
  japanese: "ja",
  日文: "ja",
  日语: "ja",
  日語: "ja",
  日本語: "ja",
  일본어: "ja",
  ko: "ko",
  kr: "ko",
  korean: "ko",
  韩文: "ko",
  韩语: "ko",
  韓文: "ko",
  韓語: "ko",
  韓国語: "ko",
  한국어: "ko",
  fr: "fr",
  french: "fr",
  法文: "fr",
  法语: "fr",
  法語: "fr",
  フランス語: "fr",
  프랑스어: "fr",
  de: "de",
  german: "de",
  德文: "de",
  德语: "de",
  德語: "de",
  ドイツ語: "de",
  독일어: "de",
  es: "es",
  spanish: "es",
  español: "es",
  西班牙文: "es",
  西班牙语: "es",
  西班牙語: "es",
  スペイン語: "es",
  스페인어: "es",
};

/**
 * Resolve a canonical language code (e.g. "ja", "zh-TW") or legacy localized
 * display name (e.g. "日文", "日本語", "Japanese", "일본어") into a canonical
 * code and clear Chinese target label. Unknown custom values pass through verbatim.
 */
export function resolvePartnerLanguage(raw: string): {
  code?: string;
  labelZh: string;
} {
  const trimmed = raw.trim();
  const key = trimmed.toLowerCase().replaceAll("_", "-");
  const code =
    LEGACY_PARTNER_CODE[key] ?? (CANONICAL_TARGET_ZH[key] ? key : undefined);
  return {
    code,
    labelZh: (code && CANONICAL_TARGET_ZH[code]) || trimmed,
  };
}

function isSelfPartner(
  raw: string,
  resolved: { code?: string; labelZh: string },
  locale: LocaleEntry,
  selfRe: RegExp,
): boolean {
  if (selfRe.test(raw) || selfRe.test(resolved.labelZh)) return true;
  if (resolved.code && selfRe.test(resolved.code)) return true;
  // Both zh and zh-TW treat generic "zh" ("中文") as own language so Chinese UI never translates Chinese ⇄ Chinese.
  if (locale.id === "zh-TW" && resolved.code === "zh") return true;
  return false;
}

/**
 * Which language a text goes into. `partner` is 对方语言 (plan/41), the
 * language of the person on the other side: the user's own language goes into
 * it, anything else comes back into the user's language. `into` names the
 * language when the host can show it; when a locale does not declare a fast
 * local script heuristic, the model decides direction so `into` is omitted.
 */
export function translationTarget(
  inputText: string,
  partner?: string,
  tone?: string,
  locale: LocaleEntry = currentLocale(),
): { target: string; into?: string } {
  const { promptNameZh, defaultPartnerZh, selfPattern, scriptHeuristic } =
    locale.brain;
  const selfRe = new RegExp(selfPattern, "i");
  const rawPartner = partner?.trim();
  let other = defaultPartnerZh;
  if (rawPartner && rawPartner.toLowerCase() !== "auto") {
    const resolved = resolvePartnerLanguage(rawPartner);
    if (!isSelfPartner(rawPartner, resolved, locale, selfRe)) {
      other = resolved.labelZh;
    }
  }

  let target: string;
  let into: string | undefined;
  if (scriptHeuristic === "han") {
    const han = inputText.match(/\p{Script=Han}/gu)?.length ?? 0;
    const letters = inputText.match(/\p{Letter}/gu)?.length ?? 0;
    into = han > 0 && han * 2 >= letters ? other : promptNameZh;
    target = into;
  } else {
    target = `${promptNameZh}（原文已经是${promptNameZh}时，译成${other}）`;
  }
  const how = tone ? TONES[tone] : undefined;
  return { target: how ? `${target}，${how}` : target, into };
}
export function targetLanguage(
  inputText: string,
  partner?: string,
  locale: LocaleEntry = currentLocale(),
) {
  return translationTarget(inputText, partner, undefined, locale).target;
}
/** The system prompt for one 选字 action; anything unknown is a translation. */
export function selectionSystemPrompt(
  prompt: {
    text: string;
    target?: string;
    tone?: string;
    action?: string;
  },
  locale: LocaleEntry = currentLocale(),
) {
  if (prompt.action === "explain") return selectionPrompt("explain", locale);
  if (prompt.action === "polish") return selectionPrompt("polish", locale);
  // 待办 (plan/31): a pasted paragraph into to-dos, or one into steps.
  if (prompt.action === "todo-split") return text("todo-split");
  if (prompt.action === "todo-break") return text("todo-break");
  if (prompt.action === "summarize")
    return selectionPrompt("summarize", locale);
  return fill(text("translate"), {
    目标语言: translationTarget(
      prompt.text,
      prompt.target,
      prompt.tone,
      locale,
    ).target,
  });
}
export async function translate(
  c: Connection,
  prompt: { text: string; target?: string; tone?: string; action?: string },
  notify: (method: string, data: object) => void,
  signal: AbortSignal,
) {
  const model = modelFor(c);
  let result = "";
  const scope = requests.getStore();
  if (scope)
    scope.rewind = (count) => {
      const before = [...result];
      result = before.slice(0, Math.max(0, before.length - count)).join("");
      notify("chat.rewind", { text: result });
    };
  const output = await streamModel(
    model,
    normalizeContext({
      messages: [
        {
          role: "system",
          content: selectionSystemPrompt(prompt),
          timestamp: Date.now(),
        },
        { role: "user", content: prompt.text, timestamp: Date.now() },
      ],
    }),
    { apiKey: c.apiKey || "local", signal, maxRetries: 0 },
  );
  for await (const event of output) {
    if (event.type === "text_delta") {
      result += event.delta;
      notify("chat.delta", { delta: event.delta });
    }
    if (event.type === "error")
      throw new Error(
        signal.aborted ? "stopped" : fault(event.error.errorMessage ?? ""),
      );
  }
  if (!result) throw new Error("model");
  if (prompt.action && prompt.action !== "translate") return { text: result };
  const { into } = translationTarget(prompt.text, prompt.target, prompt.tone);
  return into ? { text: result, into } : { text: result };
}
