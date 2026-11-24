import assert from "node:assert/strict";
import test from "node:test";
import { markdown } from "../apps/desktop/src/replyMarkdown.ts";

test("math keeps TeX syntax while code and unclosed formulas stay literal", () => {
  const html = String(
    markdown.parse(
      "公式 $x_i$、\\(a+b\\)。\n\n$$\n\\frac{a}{b}\n$$\n\n`$keep$` 和 $unfinished",
    ),
  );
  assert.match(html, /class="inlineMath">x_i</);
  assert.match(html, /class="inlineMath">a\+b</);
  assert.match(html, /class="displayMath">\n\\frac\{a\}\{b\}/);
  assert.match(html, /<code>\$keep\$<\/code>/);
  assert.match(html, /\$unfinished/);
});

test("historical replies keep table structure and display raw HTML as text", () => {
  const html = String(
    markdown.parse("| A | B |\n|---|---|\n| 1 | 2 |\n\n<div>literal</div>"),
  );
  assert.match(html, /<td>2<\/td>/);
  assert.match(html, /&lt;div&gt;literal&lt;\/div&gt;/);
});
