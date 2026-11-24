import { createHash } from "node:crypto";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { normalizeContext, type Api, type Model } from "@earendil-works/pi-ai";
import { streamModel, type Connection } from "./models.ts";
import { splitHistory } from "./prompt.ts";
import { text } from "./texts.ts";
interface CompressionState {
  last?: { model: string; input: number };
  checkpoint?: { count: number; hash: string; summary: string };
}
let active:
  { topic: number; model: string; state: CompressionState } | undefined;
const modelKey = (model: Model<Api>) =>
  JSON.stringify([model.provider, model.id, model.baseUrl]);
export function compressionState(
  topic: number | undefined,
  model: Model<Api>,
): CompressionState {
  if (topic === undefined) return {};
  const key = modelKey(model);
  if (active?.topic !== topic || active.model !== key)
    active = { topic, model: key, state: {} };
  return active.state;
}
export function recordInput(
  state: CompressionState,
  model: Model<Api>,
  message: AgentMessage,
) {
  state.last = undefined;
  if (
    message.role !== "assistant" ||
    message.stopReason === "error" ||
    message.stopReason === "aborted"
  )
    return;
  // Pi separates uncached input, cache reads and cache writes; all occupy context.
  const { input, cacheRead, cacheWrite } = message.usage;
  const tokens = input + cacheRead + cacheWrite;
  if (Number.isSafeInteger(tokens) && tokens > 0)
    state.last = { model: modelKey(model), input: tokens };
}
const digest = (m: AgentMessage[]) =>
  createHash("sha256").update(JSON.stringify(m)).digest("hex");
const checkpoint = (summary: string, earlier: AgentMessage[]) => ({
  role: "user" as const,
  content: [
    { type: "text" as const, text: text("checkpoint") + "\n" + summary },
    ...earlier.flatMap((m) =>
      m.role === "user" && Array.isArray(m.content)
        ? m.content.filter((part) => part.type === "image")
        : [],
    ),
  ],
  timestamp: 0,
});
export async function compress(
  messages: AgentMessage[],
  model: Model<Api>,
  c: Connection,
  state: CompressionState,
  signal?: AbortSignal,
) {
  const body = messages.filter((m) => m.role !== "system");
  let current = messages;
  const cached = state.checkpoint;
  if (cached) {
    if (
      cached.count <= body.length &&
      cached.hash === digest(body.slice(0, cached.count))
    ) {
      current = [
        ...messages.filter((m) => m.role === "system"),
        checkpoint(cached.summary, body.slice(0, cached.count)),
        ...body.slice(cached.count),
      ];
    } else {
      // The previous measurement included a summary that no longer fits this transcript.
      state.checkpoint = undefined;
      state.last = undefined;
    }
  }
  const reuse = state.checkpoint;
  const actual =
    state.last?.model === modelKey(model) ? state.last.input : undefined;
  const split = splitHistory(current, model.contextWindow, actual);
  if (!split) return current;
  const { system, earlier, tail } = split;
  const remaining = reuse ? earlier.slice(1) : earlier;
  if (!remaining.length) return current;
  let summary = reuse?.summary ?? "";
  // This byte cap only batches a summary already requested by splitHistory.
  const limit = Math.max(256, Math.floor(model.contextWindow * 0.28));
  let block = "",
    bytes = 0;
  async function flush() {
    if (!block) return;
    const result = await streamModel(
      model,
      normalizeContext({
        systemPrompt: text("compact"),
        messages: [
          {
            role: "user",
            content: [summary, block].filter(Boolean).join("\n"),
            timestamp: 0,
          },
        ],
      }),
      {
        apiKey: c.apiKey || "local",
        signal,
        maxRetries: 0,
        maxTokens: Math.min(
          2048,
          Math.max(128, Math.floor(model.contextWindow * 0.15)),
        ),
      },
    );
    const message = await result.result();
    if (message.stopReason === "error" || message.stopReason === "aborted")
      throw Error("model");
    summary = message.content
      .filter((x) => x.type === "text")
      .map((x) => x.text)
      .join("");
    block = "";
    bytes = 0;
    if (!summary) throw Error("model");
  }
  for (const m of remaining) {
    for (const char of JSON.stringify(m, (_key, value) =>
      value?.type === "image" ? { type: "text", text: "［图片］" } : value,
    ) + "\n") {
      const n = Buffer.byteLength(char);
      if (bytes + n > limit) await flush();
      block += char;
      bytes += n;
    }
  }
  await flush();
  const count = (reuse?.count ?? 0) + remaining.length;
  state.checkpoint = { count, hash: digest(body.slice(0, count)), summary };
  return [...system, checkpoint(summary, body.slice(0, count)), ...tail];
}
