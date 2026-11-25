// Canonical translation partner language persistence & localized topic media helpers.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { fillText } from "../apps/shared/localeText.ts";
import type { Key } from "../apps/desktop/src/i18n.ts";
import {
  formatIntoLang,
  formatTranslationTarget,
  normalizeTranslationTarget,
  ownTranslationLabel,
  resolvePartnerBar,
} from "../apps/desktop/src/translateLang.ts";
import {
  localizeTopicTitle,
  parseMediaPrefix,
} from "../apps/desktop/src/topicMedia.ts";

const tables: Record<string, Record<string, string>> = Object.fromEntries(
  ["zh", "en", "zh-TW", "ja", "ko"].map((id) => [
    id,
    JSON.parse(readFileSync(`apps/shared/locales/${id}.json`, "utf8")),
  ]),
);
const tFor =
  (lang: string) =>
  (key: Key, vars: Record<string, string | number> = {}) =>
    fillText(tables[lang][key] ?? "", vars);

test("normalizeTranslationTarget maps canonical codes and legacy localized names", () => {
  assert.equal(normalizeTranslationTarget(""), "auto");
  assert.equal(normalizeTranslationTarget("auto"), "auto");
  assert.equal(normalizeTranslationTarget("自动"), "auto");
  assert.equal(normalizeTranslationTarget("自動"), "auto");
  assert.equal(normalizeTranslationTarget("Auto"), "auto");
  assert.equal(normalizeTranslationTarget("자동"), "auto");

  assert.equal(normalizeTranslationTarget("en"), "en");
  assert.equal(normalizeTranslationTarget("EN-US"), "en");
  assert.equal(normalizeTranslationTarget("英文"), "en");
  assert.equal(normalizeTranslationTarget("English"), "en");
  assert.equal(normalizeTranslationTarget("英語"), "en");
  assert.equal(normalizeTranslationTarget("영어"), "en");

  assert.equal(normalizeTranslationTarget("zh"), "zh");
  assert.equal(normalizeTranslationTarget("中文"), "zh");
  assert.equal(normalizeTranslationTarget("中国語"), "zh");
  assert.equal(normalizeTranslationTarget("중국어"), "zh");

  assert.equal(normalizeTranslationTarget("zh-TW"), "zh-TW");
  assert.equal(normalizeTranslationTarget("zh_hant"), "zh-TW");
  assert.equal(normalizeTranslationTarget("繁體中文"), "zh-TW");

  assert.equal(normalizeTranslationTarget("ja"), "ja");
  assert.equal(normalizeTranslationTarget("日文"), "ja");
  assert.equal(normalizeTranslationTarget("日本語"), "ja");
  assert.equal(normalizeTranslationTarget("일본어"), "ja");

  assert.equal(normalizeTranslationTarget("ko"), "ko");
  assert.equal(normalizeTranslationTarget("韩文"), "ko");
  assert.equal(normalizeTranslationTarget("韓文"), "ko");
  assert.equal(normalizeTranslationTarget("한국어"), "ko");

  assert.equal(normalizeTranslationTarget("fr"), "fr");
  assert.equal(normalizeTranslationTarget("法文"), "fr");
  assert.equal(normalizeTranslationTarget("de"), "de");
  assert.equal(normalizeTranslationTarget("德文"), "de");
  assert.equal(normalizeTranslationTarget("es"), "es");
  assert.equal(normalizeTranslationTarget("西班牙文"), "es");

  // Unknown custom values pass through verbatim
  assert.equal(normalizeTranslationTarget("Italian"), "Italian");
});

test("switching UI language never produces 日本語 ⇄ 日文 or 中文 ⇄ 中文", () => {
  // User saved legacy "日文" in zh UI, then switched UI to ja
  const jaBar = resolvePartnerBar("日文", "ja", tFor("ja"));
  assert.equal(ownTranslationLabel("ja", tFor("ja")), "日本語");
  assert.equal(jaBar.normalized, "ja");
  assert.equal(jaBar.selected, "en");
  assert.ok(!jaBar.options.some((o) => o.value === "ja"));
  assert.equal(
    jaBar.options.find((o) => o.value === jaBar.selected)?.label,
    "英語",
  );

  // User saved legacy "英文" in zh UI, then switched UI to ja -> renders as 英語 with canonical value "en"
  const jaEnBar = resolvePartnerBar("英文", "ja", tFor("ja"));
  assert.equal(jaEnBar.selected, "en");
  assert.equal(
    jaEnBar.options.find((o) => o.value === "en")?.label,
    "英語",
  );

  // User saved legacy "英文" in zh UI, then switched UI to en -> falls back to "zh" ("Chinese")
  const enBar = resolvePartnerBar("英文", "en", tFor("en"));
  assert.equal(enBar.selected, "zh");
  assert.ok(!enBar.options.some((o) => o.value === "en"));
  assert.equal(
    enBar.options.find((o) => o.value === "zh")?.label,
    "Chinese",
  );

  // zh-TW UI treats both "zh" and "zh-TW" as own language -> falls back to "en"
  const twBar = resolvePartnerBar("zh", "zh-TW", tFor("zh-TW"));
  assert.equal(twBar.selected, "en");
  assert.ok(!twBar.options.some((o) => o.value === "zh"));

  // Custom free-text partner is preserved
  const customBar = resolvePartnerBar("Italian", "ko", tFor("ko"));
  assert.equal(customBar.selected, "Italian");
  assert.equal(customBar.options[0].value, "Italian");
  assert.equal(customBar.options[0].label, "Italian");
});

test("formatTranslationTarget and formatIntoLang localize canonical and legacy values", () => {
  assert.equal(formatTranslationTarget("auto", tFor("en")), "Auto");
  assert.equal(formatTranslationTarget("ja", tFor("en")), "Japanese");
  assert.equal(formatTranslationTarget("日文", tFor("ko")), "일본어");
  assert.equal(formatIntoLang("日文", tFor("zh")), "日文");
  assert.equal(formatIntoLang("ja", tFor("en")), "Japanese");
  assert.equal(formatIntoLang("zh", tFor("ja")), "中国語");
});

test("topicMedia parses and localizes image/screenshot/file prefixes across all 5 locales", () => {
  assert.equal(
    localizeTopicTitle("［图片］这是什么花？", tFor("en")),
    "[Image] 这是什么花？",
  );
  assert.equal(
    localizeTopicTitle("［截图］报错怎么修", tFor("ja")),
    "[スクリーンショット] 报错怎么修",
  );
  assert.equal(
    localizeTopicTitle("［文件：report.pdf］总结一下", tFor("ko")),
    "[파일: report.pdf] 总结一下",
  );
  assert.equal(
    localizeTopicTitle("[Image] What flower is this?", tFor("zh-TW")),
    "［圖片］What flower is this?",
  );

  const enTurn = parseMediaPrefix("[Image][File: a.pdf、b.md]Please read");
  assert.equal(enTurn.hadImage, true);
  assert.deepEqual(enTurn.files, ["a.pdf", "b.md"]);
  assert.equal(enTurn.rest, "Please read");

  const koSnip = parseMediaPrefix("[스크린샷]이거 뭐야?", true);
  assert.equal(koSnip.hadSnip, true);
  assert.equal(koSnip.rest, "이거 뭐야?");
});
