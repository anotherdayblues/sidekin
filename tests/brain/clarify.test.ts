import assert from "node:assert/strict";
import test from "node:test";
import { clarifyTool, answerQuestion } from "../../apps/brain/src/clarify.ts";
test("自填回答只交给发问的任务，保留原文", async () => {
  const remembered: string[] = [];
  const tool = clarifyTool(
    "cat",
    (method, p) => {
      if (method !== "chat.question") return;
      const { id } = p as { id: string };
      assert.equal(answerQuestion("wrong", id, "取消"), false);
      assert.equal(answerQuestion("cat", id, "只关注文具批发价"), true);
    },
    (q, a) => remembered.push(q, a),
  );
  const result = await tool.execute("ask", {
    question: "周报关注什么？",
    options: ["新品", "出口"],
  });
  assert.equal(result.content[0].text, "只关注文具批发价");
  assert.deepEqual(remembered, ["周报关注什么？", "只关注文具批发价"]);
});

import { instructions } from "../../apps/brain/src/prompt.ts";
test("北京时间的任务在纽约深夜使用义乌当地日期", () => {
  const now = new Date("2026-11-08T04:00:00Z");
  const prompt = instructions({}, now, "", {}, true, "Asia/Shanghai");
  assert.ok(prompt.includes("2026/11/8") && prompt.includes("Asia/Shanghai"));
});
