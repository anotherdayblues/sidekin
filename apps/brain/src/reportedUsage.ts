// Only examine protocol usage envelopes. Pi's normalized usage fills missing counters with 0.
import type { Api } from "@earendil-works/pi-ai";

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : {};
}
function count(value: unknown) {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0
    ? value
    : undefined;
}
export function reportedUsage(api: Api) {
  let total: number | undefined,
    input: number | undefined,
    output: number | undefined;
  let cached: number | undefined, written: number | undefined;
  return {
    observe(event: unknown) {
      const e = object(event);
      if (api === "google-generative-ai") {
        const u = object(e.usageMetadata);
        total = count(u.totalTokenCount) ?? total;
        cached = count(u.cachedContentTokenCount) ?? cached;
        input = count(u.promptTokenCount) ?? input;
        output = count(u.candidatesTokenCount) ?? output;
      } else if (api === "anthropic-messages") {
        const u = object(
          e.type === "message_start" ? object(e.message).usage : e.usage,
        );
        input = count(u.input_tokens) ?? input;
        output = count(u.output_tokens) ?? output;
        cached = count(u.cache_read_input_tokens) ?? cached;
        written = count(u.cache_creation_input_tokens) ?? written;
      } else {
        const responses = api === "openai-responses";
        const u = object(responses ? object(e.response).usage : e.usage);
        total = count(u.total_tokens) ?? total;
        input = count(responses ? u.input_tokens : u.prompt_tokens) ?? input;
        output =
          count(responses ? u.output_tokens : u.completion_tokens) ?? output;
        const details = object(
          responses ? u.input_tokens_details : u.prompt_tokens_details,
        );
        cached =
          count(details.cached_tokens) ??
          count(u.prompt_cache_hit_tokens) ??
          count(u.cached_tokens) ??
          cached;
      }
    },
    get cacheRead() {
      return cached ?? null;
    },
    get itemized() {
      return input !== undefined && output !== undefined;
    },
    get tokens() {
      if (total !== undefined) return total;
      if (
        input === undefined ||
        output === undefined ||
        api === "google-generative-ai"
      )
        return null;
      return (
        input +
        output +
        (api === "anthropic-messages" ? (cached ?? 0) + (written ?? 0) : 0)
      );
    },
  };
}
