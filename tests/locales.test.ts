// plan/15: the English table says the same things as the Chinese one.
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

const load = (lang: string) =>
  JSON.parse(
    readFileSync(`apps/shared/locales/${lang}.json`, "utf8"),
  ) as Record<string, string>;
const holes = (s: string) =>
  [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();

test("英文表和中文表的 key 和占位符一一对应", () => {
  const zh = load("zh"),
    en = load("en");
  const base = (k: string) => k.replace(/\.(zero|one|two|few|many|other)$/, "");
  const zhBase = new Set(Object.keys(zh).map(base));
  const enBase = new Set(Object.keys(en).map(base));
  assert.deepEqual([...enBase].sort(), [...zhBase].sort());
  for (const [k, v] of Object.entries(zh)) {
    assert.ok(v.trim(), "中文为空：" + k);
    const e = en[k] ?? en[base(k) + ".other"];
    if (e === undefined) continue;
    // "Every second" for one: a plural form may leave the count out.
    if (/\.(zero|one|two)$/.test(k))
      assert.ok(
        holes(e).every((h) => holes(v).includes(h)),
        "占位符多了：" + k,
      );
    else assert.deepEqual(holes(e), holes(v), "占位符不一致：" + k);
  }
  for (const [k, v] of Object.entries(en)) {
    assert.ok(v.trim(), "英文为空：" + k);
    assert.ok(!/\p{Script=Han}/u.test(v), "英文表里有中文：" + k);
    if (k.endsWith(".one")) assert.ok(en[base(k) + ".other"], k);
  }
});

test("代码里用到的计数 key 都在表里", () => {
  const zh = load("zh");
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
