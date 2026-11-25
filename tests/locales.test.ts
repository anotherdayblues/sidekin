// plan/15 + extensible i18n: registry integrity, table parity, and fallback chains.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  DEFAULT_LOCALE,
  LOCALES,
  SYSTEM_FALLBACK_LOCALE,
  getLocale,
  lookupText,
  matchLocaleTags,
  registry,
  resolveLocaleChoice,
  resolveLocaleFromPath,
  type LocaleRegistry,
} from "../apps/shared/locales/index.ts";

const load = (lang: string) =>
  JSON.parse(
    readFileSync(`apps/shared/locales/${lang}.json`, "utf8"),
  ) as Record<string, string>;
const holes = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("locale 注册表结构合法且与词典文件一致", () => {
  const ids = LOCALES.map((l) => l.id);
  assert.equal(new Set(ids).size, ids.length, "locale id 重复");
  assert.ok(ids.includes(DEFAULT_LOCALE), "default 不在 locales 中");
  assert.ok(
    ids.includes(SYSTEM_FALLBACK_LOCALE),
    "systemFallback 不在 locales 中",
  );
  const paths = new Set<string>();
  const guidePaths = new Set<string>();
  for (const locale of LOCALES) {
    assert.ok(locale.nativeName.trim(), `${locale.id} 缺少 nativeName`);
    assert.ok(locale.matchTags.length > 0, `${locale.id} 缺少 matchTags`);
    assert.ok(locale.fallback.length > 0, `${locale.id} 缺少 fallback`);
    assert.equal(locale.fallback[0], locale.id, `${locale.id} fallback 首项应为自身`);
    for (const fb of locale.fallback)
      assert.ok(ids.includes(fb), `${locale.id} 引用了未知 fallback: ${fb}`);
    assert.ok(!paths.has(locale.websitePath), `websitePath 重复: ${locale.websitePath}`);
    paths.add(locale.websitePath);
    assert.ok(!guidePaths.has(locale.guidePath), `guidePath 重复: ${locale.guidePath}`);
    guidePaths.add(locale.guidePath);
    assert.doesNotThrow(() => load(locale.id), `缺少词典文件: ${locale.id}.json`);
    assert.doesNotThrow(
      () => new RegExp(locale.brain.selfPattern, "i"),
      `${locale.id} brain.selfPattern 非法正则`,
    );
  }
});

test("所有注册语言表与默认中文表的 key 和占位符一一对应", () => {
  const zh = load(DEFAULT_LOCALE);
  const base = (k: string) => k.replace(/\.(zero|one|two|few|many|other)$/, "");
  const zhBase = new Set(Object.keys(zh).map(base));

  for (const [k, v] of Object.entries(zh)) {
    assert.ok(v.trim(), "中文为空：" + k);
  }

  for (const locale of LOCALES) {
    if (locale.id === DEFAULT_LOCALE) continue;
    const tbl = load(locale.id);
    const tblBase = new Set(Object.keys(tbl).map(base));
    assert.deepEqual([...tblBase].sort(), [...zhBase].sort(), locale.id);
    for (const [k, v] of Object.entries(zh)) {
      const other = tbl[k] ?? tbl[base(k) + ".other"];
      if (other === undefined) continue;
      // "Every second" for one: a plural form may leave the count out.
      if (/\.(zero|one|two)$/.test(k))
        assert.ok(
          holes(other).every((h) => holes(v).includes(h)),
          `${locale.id} 占位符多了：` + k,
        );
      else
        assert.deepEqual(
          holes(other),
          holes(v),
          `${locale.id} 占位符不一致：` + k,
        );
    }
    for (const [k, v] of Object.entries(tbl)) {
      assert.ok(v.trim(), `${locale.id} 为空：` + k);
      if (locale.id === "en")
        assert.ok(!/\p{Script=Han}/u.test(v), "英文表里有中文：" + k);
      if (k.endsWith(".one")) assert.ok(tbl[base(k) + ".other"], `${locale.id}: ${k}`);
    }
  }
});

test("代码里用到的计数 key 都在表里", () => {
  const zh = load(DEFAULT_LOCALE);
  const files: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true }))
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.name.endsWith(".ts")) files.push(join(d, e.name));
  };
  walk("apps/desktop/src");
  for (const f of files)
    for (const m of readFileSync(f, "utf8").matchAll(/\btn\("([^"]+)"/g))
      assert.ok(zh[m[1] + ".other"], `${f}: ${m[1]}.other`);
});

test("多语言 tag 匹配、路径解析与回退链可平滑扩展到 zh-TW / ja", () => {
  const baseLocales = registry.locales.filter(
    (l) => l.id === "zh" || l.id === "en",
  );
  const mockReg: LocaleRegistry = {
    default: "zh",
    systemFallback: "en",
    locales: [
      ...baseLocales,
      {
        id: "zh-TW",
        nativeName: "繁體中文",
        shortLabel: "繁",
        htmlLang: "zh-Hant-TW",
        hreflang: "zh-Hant-TW",
        dateLocale: "zh-TW",
        hour12: false,
        matchTags: ["zh-hant", "zh-tw", "zh-hk", "zh-mo"],
        fallback: ["zh-TW", "zh", "en"],
        websitePath: "/zh-tw/",
        guidePath: "/zh-tw/guide/",
        brain: {
          promptMode: "overlay",
          promptName: "Traditional Chinese (Taiwan)",
          promptNameZh: "繁體中文（台灣用語）",
          defaultPartnerZh: "英文",
          selfPattern: "繁體|繁体|台灣|台湾|traditional|^zh-?(tw|hant|hk)",
        },
      },
      {
        id: "ja",
        nativeName: "日本語",
        shortLabel: "日",
        htmlLang: "ja",
        hreflang: "ja",
        dateLocale: "ja-JP",
        hour12: false,
        matchTags: ["ja"],
        fallback: ["ja", "en", "zh"],
        websitePath: "/ja/",
        guidePath: "/ja/guide/",
        brain: {
          promptMode: "overlay",
          promptName: "Japanese",
          promptNameZh: "日文",
          defaultPartnerZh: "英文",
          selfPattern: "日文|日语|日本語|japanese|^ja$",
        },
      },
    ],
  };

  // 最长前缀匹配：zh-Hant-TW 优先命中 zh-TW 而不是 zh
  assert.equal(matchLocaleTags(["zh-Hant-TW"], mockReg), "zh-TW");
  assert.equal(matchLocaleTags(["zh_TW.UTF-8"], mockReg), "zh-TW");
  assert.equal(matchLocaleTags(["zh-HK"], mockReg), "zh-TW");
  assert.equal(matchLocaleTags(["zh-Hans-CN"], mockReg), "zh");
  assert.equal(matchLocaleTags(["zh_CN.UTF-8"], mockReg), "zh");
  assert.equal(matchLocaleTags(["ja-JP"], mockReg), "ja");
  // 遍历系统偏好列表：首项不支持时命中次优支持语言
  assert.equal(matchLocaleTags(["fr-FR", "ja-JP", "en-US"], mockReg), "ja");
  assert.equal(matchLocaleTags(["fr-FR", "de-DE"], mockReg), "en");
  assert.equal(resolveLocaleChoice("ja", ["zh-CN"], mockReg), "ja");
  assert.equal(resolveLocaleChoice("system", ["zh-Hant-TW"], mockReg), "zh-TW");
  assert.equal(getLocale("unknown", mockReg).id, "zh");

  // 路径解析（大小写不敏感，但保留规范 locale id）
  assert.equal(resolveLocaleFromPath("/", mockReg), "zh");
  assert.equal(resolveLocaleFromPath("/guide/", mockReg), "zh");
  assert.equal(resolveLocaleFromPath("/en/", mockReg), "en");
  assert.equal(resolveLocaleFromPath("/EN/guide/", mockReg), "en");
  assert.equal(resolveLocaleFromPath("/en/guide/", mockReg), "en");
  assert.equal(resolveLocaleFromPath("/ja", mockReg), "ja");
  assert.equal(resolveLocaleFromPath("/JA/guide/", mockReg), "ja");
  assert.equal(resolveLocaleFromPath("/ja/guide/", mockReg), "ja");
  assert.equal(resolveLocaleFromPath("/zh-tw/", mockReg), "zh-TW");
  assert.equal(resolveLocaleFromPath("/zh-TW/", mockReg), "zh-TW");
  assert.equal(resolveLocaleFromPath("/ZH-TW/guide/", mockReg), "zh-TW");
  assert.equal(getLocale("zh").nativeName, "简体中文");

  // 回退链：ja 缺词优先退 en 再退 zh；zh-TW 缺词优先退 zh
  const tables = {
    zh: { a: "中A", b: "中B", c: "中C" },
    en: { a: "EnA", b: "EnB" },
    ja: { a: "日A" },
    "zh-TW": { a: "繁A" },
  };
  assert.equal(lookupText("a", "ja", tables, mockReg), "日A");
  assert.equal(lookupText("b", "ja", tables, mockReg), "EnB");
  assert.equal(lookupText("c", "ja", tables, mockReg), "中C");
  assert.equal(lookupText("b", "zh-TW", tables, mockReg), "中B");
  assert.equal(lookupText("missing", "ja", tables, mockReg), undefined);
});
