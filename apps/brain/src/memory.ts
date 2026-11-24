import { t } from "./locale.ts";
import { text as promptText } from "./texts.ts";
// Instructions adapted from Hermes Agent's MIT-licensed two-notebook memory tool.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hostCall } from "./host.ts";
export const explicitMemory = (text: string) =>
  /(?:请|要|帮我|替我|你)?(?:记住|记下|别忘了|别忘记)|\b(?:remember (?:that|my|this)|don't forget)\b/i.test(
    text,
  ) &&
  !/(?:别忘了.{0,12}提醒|(?:别|不要|不用)记(?:住|下))|还记得|你记住了吗/.test(
    text,
  );
export function memoryTools(token: string, onWrite: () => void): AgentTool[] {
  const operation = {
    type: "object",
    properties: {
      book: { type: "string", enum: ["user", "notes"] },
      action: { type: "string", enum: ["add", "patch", "remove"] },
      old_text: { type: "string" },
      content: { type: "string" },
    },
    required: ["book", "action"],
    additionalProperties: false,
  };
  return [
    {
      name: "memory",
      label: t("step.memory"),
      description: promptText("tool-memory"),
      parameters: {
        type: "object",
        properties: {
          operations: {
            type: "array",
            items: operation,
            minItems: 1,
            maxItems: 64,
          },
        },
        required: ["operations"],
        additionalProperties: false,
      },
      execute: async (_id, args) => {
        const { operations } = args as { operations: unknown[] };
        const result = await hostCall("host.memory", { token, operations });
        onWrite();
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
          details: {},
        };
      },
    },
    {
      name: "search_history",
      label: t("step.history"),
      description: promptText("tool-search-history"),
      parameters: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
        additionalProperties: false,
      },
      execute: async (_id, args) => ({
        content: [
          {
            type: "text",
            text: JSON.stringify(
              (
                await hostCall<
                  { dateMs: number; question: string; answer: string }[]
                >("host.search", {
                  token,
                  query: (args as { query: string }).query,
                })
              ).map((t) => ({
                ...t,
                date: new Date(t.dateMs).toLocaleDateString("zh-CN"),
              })),
            ),
          },
        ],
        details: {},
      }),
    },
  ];
}
