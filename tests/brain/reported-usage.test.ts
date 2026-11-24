import assert from "node:assert/strict";
import test from "node:test";
import { reportedUsage } from "../../apps/brain/src/reportedUsage.ts";

test("模型缺少用量字段时保留未知，缓存读取不重复计入总量", () => {
  const chat = reportedUsage("openai-completions");
  assert.equal(chat.tokens, null);
  chat.observe({ usage: { total_tokens: 42 } });
  assert.equal(chat.tokens, 42);
  assert.equal(chat.cacheRead, null);
  chat.observe({ usage: { prompt_cache_hit_tokens: 0 } });
  assert.equal(chat.cacheRead, 0);

  const claude = reportedUsage("anthropic-messages");
  claude.observe({
    type: "message_start",
    message: {
      usage: {
        input_tokens: 5,
        output_tokens: 1,
        cache_read_input_tokens: 20,
        cache_creation_input_tokens: 10,
      },
    },
  });
  claude.observe({ type: "message_delta", usage: { output_tokens: 6 } });
  assert.equal(claude.tokens, 41);
  assert.equal(claude.cacheRead, 20);

  const responses = reportedUsage("openai-responses");
  responses.observe({
    response: {
      usage: {
        input_tokens: 32,
        output_tokens: 8,
        input_tokens_details: { cached_tokens: 27 },
      },
    },
  });
  assert.equal(responses.tokens, 40);
  assert.equal(responses.cacheRead, 27);

  const gemini = reportedUsage("google-generative-ai");
  gemini.observe({
    usageMetadata: { totalTokenCount: 70, cachedContentTokenCount: 48 },
  });
  assert.equal(gemini.tokens, 70);
  assert.equal(gemini.cacheRead, 48);
});
