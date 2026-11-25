import { t } from "./locale.ts";
import { text as promptText } from "./texts.ts";
// Instructions adapted from Hermes Agent's MIT-licensed two-notebook memory tool.
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hostCall } from "./host.ts";
export const explicitMemory = (text: string) =>
  /(?:[请請]|要|[帮幫]我|替我|你)?(?:[记記]住|[记記]下|[别別]忘了|[别別]忘[记記])|\b(?:remember (?:that|my|this)|don['’]t forget)\b|覚えて(?:おいて|いて|ね|ください|くれ|て)|メモして(?:おいて|ください|ね)?|忘れないで(?:ね|ください)?|기억해(?:\s?줘|\s?주세요|\s?둬|\s?두세요|요)?|메모해(?:\s?줘|\s?주세요|요)?|잊지\s?마(?:세요|요)?/i.test(
    text,
  ) &&
  !/(?:[别別]忘了.{0,12}提醒|(?:[别別]|不要|不用)[记記](?:住|下))|[还還][记記]得|你[记記]住了[吗嗎]|\b(?:don['’]t remember|do you remember|remember to remind|don['’]t forget to remind)\b|覚えなくていい|覚えないで|覚えて(?:いる|る|ますか|るか)|リマインド|通知して|思い出(?:して|せる)|기억하지\s?마|기억할\s?필요\s?없|기억해\?|기억나|알려\s?줘|리마인드/i.test(
    text,
  );

export function extractRename(text: string): string | undefined {
  const trimmed = text.trim();
  return (
    trimmed.match(/^(?:[请請])?把我(?:的)?名字改成([^，。？?]{1,30})[。.]?$/u)?.[1] ??
    trimmed.match(
      /^(?:私の)?名前を([^、。？?]{1,30})(?:に変えて|にして)(?:ください)?[。.]?$/u,
    )?.[1] ??
    trimmed.match(
      /^(?:내|제)\s?이름을\s?([^,.？?]{1,30})(?:으로|로)\s?바꿔(?:\s?줘|\s?주세요)?[.。]?$/u,
    )?.[1] ??
    trimmed.match(/^(?:please\s+)?change my name to\s+([^,.?]{1,30})\.?$/i)?.[1]
  )?.trim();
}

export function extractExplicitFact(text: string): string | undefined {
  const trimmed = text.trim();
  const match =
    trimmed.match(
      /^(?:[请請]|[帮幫]我|替我)?(?:[记記]住|[记記]下|[别別]忘了|[别別]忘[记記])[：:，,\s]*([^？?]+)$/u,
    )?.[1] ??
    trimmed.match(
      /^(?:please\s+)?(?:remember(?:\s+that)?|don['’]t forget(?:\s+that)?)\s*[:,]?\s*([^?]+)$/i,
    )?.[1] ??
    trimmed.match(
      /^(?:覚えて(?:おいて|いて|ください|ね)|メモして(?:おいて|ください|ね)?|忘れないで(?:ね|ください)?)[：:、,\s]+([^？?]+)$/u,
    )?.[1] ??
    trimmed.match(
      /^([^？?]+?)(?:と|って|を)?(?:覚えて(?:おいて|いて|ください|ね)?|メモして(?:おいて|ください|ね)?)[。.]?$/u,
    )?.[1] ??
    trimmed.match(
      /^(?:기억해(?:\s?줘|\s?주세요|\s?둬|\s?두세요)?|메모해(?:\s?줘|\s?주세요)?|잊지\s?마(?:세요|요)?)[：:,\s]+([^？?]+)$/u,
    )?.[1] ??
    trimmed.match(
      /^([^？?]+?)[,\s]+(?:기억해(?:\s?줘|\s?주세요|\s?둬|\s?두세요)?|메모해(?:\s?줘|\s?주세요)?)[.。]?$/u,
    )?.[1];
  return match?.trim() || undefined;
}

export function isUnsafePrewrite(fact: string): boolean {
  return /(?:删除|删掉|刪除|刪掉|改成|替换|替換|提醒我)|\b(?:delete|remove|replace|change|remind me)\b|削除|消して|変更|リマインド|通知して|삭제|지워|바꿔|알려\s?줘|리마인드/i.test(
    fact,
  );
}
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
