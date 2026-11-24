import assert from "node:assert/strict";
import { test } from "node:test";
import fs from "node:fs";
test("正式提示词文件齐全且非空（中文全文逐字校验见 zh-prompts.test.ts）", () => {
  const names = [
    "core",
    "user-example",
    "persona-default",
    "tool-memory",
    "tool-search-history",
    "review",
    "model-hints",
    "time-note",
    "translate",
    "selection-explain",
    "selection-polish",
    "selection-summarize",
    "snip-note",
    "image-note",
    "proactive",
    "proactive-gate",
    "compact",
    "checkpoint",
    "tool-web-search",
    "tool-web-read",
    "web-guidance",
    "search-now",
    "tool-library",
    "tool-pet-action",
    "voice-reply",
    "attached-file",
    "attached-file-omitted",
  ];
  for (const n of names) {
    const actual = fs.readFileSync("apps/brain/prompts/" + n + ".md", "utf8");
    assert.ok(actual.trim().length > 0, `prompt ${n} must not be empty`);
  }
});

test("DeepSeek tool guidance is a separate stable section before user context, only with tools", async () => {
  const { instructions } = await import("../../apps/brain/src/prompt.ts");
  const block = fs
    .readFileSync("apps/brain/prompts/hermes-tool-use.md", "utf8")
    .trimEnd();
  for (const hasTools of [false, true]) {
    const sys = instructions(
      {},
      new Date(),
      "deepseek-flash",
      {},
      true,
      undefined,
      hasTools,
    );
    assert.ok(sys.includes("- 用 <性格> 里的口吻说话。"));
    assert.equal(sys.split(block).length - 1, Number(hasTools));
    if (hasTools)
      assert.ok(
        sys.indexOf("</性格>") < sys.indexOf(block) &&
          sys.indexOf(block) < sys.indexOf("<关于你>"),
      );
  }
});
