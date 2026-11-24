import { fill, text } from "./texts.ts";
import { english } from "./locale.ts";
import { attachedText, type AttachedFile } from "./attachments.ts";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Model, Api, Message } from "@earendil-works/pi-ai";
export interface PetContext {
  displayName?: string;
  description?: string;
  personality?: string;
}
export interface PastTurn {
  image_data?: string;
  question: string;
  answer: string;
  at: number;
  timeNote?: string;
  /** Files sent with this turn, kept with it (plan/14). */
  files?: AttachedFile[];
}
export interface ContextSections {
  profile?: string;
  user?: string;
  notes?: string;
  catalog?: string;
}
export function instructions(
  pet: PetContext = {},
  now = new Date(),
  model = "",
  sections: ContextSections = {},
  webSearch = false,
  zone = Intl.DateTimeFormat().resolvedOptions().timeZone,
  hasTools = false,
) {
  const persona =
    pet.personality ??
    [
      pet.description,
      text(english() ? "persona-default.en" : "persona-default"),
    ]
      .filter(Boolean)
      .join("\n");
  let core = text("core");
  const guidance: string[] = [];
  if (webSearch) guidance.push(text("web-guidance"));
  if (/deepseek/i.test(model)) {
    if (hasTools) guidance.push(text("hermes-tool-use"));
  } else if (/gpt|qwen|kimi|moonshot|glm|minimax/i.test(model)) {
    guidance.push(text("model-hints"));
  }
  // Hermes puts tool guidance after identity and before user context and memory.
  if (guidance.length)
    core = core.replace(
      "\n<关于你>\n",
      () => "\n" + guidance.join("\n\n") + "\n\n<关于你>\n",
    );
  // Chinese stays word for word; other languages add one block at the end.
  if (english()) core += "\n\n" + text("language.en");
  return fill(core, {
    宠物名: pet.displayName || "随伴",
    性格: Array.from(persona).slice(0, 1500).join(""),
    我写的: sections.profile ?? "",
    关于你: sections.user ?? "",
    笔记: sections.notes ?? "",
    资料库目录: sections.catalog ?? "",
    日期: now.toLocaleDateString("zh-CN", { timeZone: zone }),
    时区: zone,
  });
}
export function restore(turns: PastTurn[], model: Model<Api>): Message[] {
  const out: Message[] = [];
  for (const t of turns) {
    out.push({
      role: "user",
      content: [
        ...[t.timeNote, ...attachedText(t.files), t.question]
          .filter((s): s is string => !!s)
          .map((text) => ({ type: "text" as const, text })),
        ...(t.image_data && model.input.includes("image")
          ? [
              {
                type: "image" as const,
                mimeType: "image/png",
                data: t.image_data,
              },
            ]
          : []),
      ],
      timestamp: t.at,
    });
    if (t.answer)
      out.push({
        role: "assistant",
        content: [{ type: "text", text: t.answer }],
        timestamp: t.at,
        model: model.id,
        provider: model.provider,
        api: model.api,
        stopReason: "stop",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
      });
  }
  return out;
}
// Estimate only when the provider omits usage, and to choose the recent turns to keep.
function estimateTokens(message: AgentMessage) {
  let images = 0,
    wide = 0;
  const payload = JSON.stringify(message, (key, value) => {
    if (key === "timestamp" || key === "usage") return undefined;
    if (value?.type === "image" && typeof value.data === "string") {
      images++;
      return null;
    }
    return value;
  });
  const ascii = payload.replace(/[^\x00-\x7f]/gu, () => {
    wide++;
    return "";
  }).length;
  return Math.ceil(ascii / 4 + wide) + images * 1024;
}

// Keep the current user message and its tool exchanges together.
export function splitHistory(
  messages: AgentMessage[],
  window: number,
  lastInput?: number,
) {
  const budget = window * 0.75;
  if (lastInput !== undefined && lastInput < budget) return;
  const system = messages.filter((m) => m.role === "system"),
    body = messages.filter((m) => m.role !== "system");
  let start = body.map((m) => m.role).lastIndexOf("user");
  if (start < 1) return;
  const sizes = body.map(estimateTokens);
  const overhead = system.reduce((n, m) => n + estimateTokens(m), 0);
  const total = overhead + sizes.reduce((n, size) => n + size, 0);
  if (lastInput === undefined && total < budget) return;
  // Scale the estimated tail to the input count the provider actually reported.
  const keep = (budget * 0.55 * total) / (lastInput ?? total);
  let used = overhead + sizes.slice(start).reduce((n, size) => n + size, 0);
  for (let i = start - 1; i > 0; i--) {
    used += sizes[i];
    if (used > keep) break;
    if (body[i].role === "user") start = i;
  }
  return { system, earlier: body.slice(0, start), tail: body.slice(start) };
}
