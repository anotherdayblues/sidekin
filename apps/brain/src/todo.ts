import { t } from "./locale.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hostCall } from "./host.ts";
import { text } from "./texts.ts";

const actions = ["add", "list", "update", "complete", "remove"] as const;

/** 待办 (plan/27): the user's own to-dos; the host keeps them and rings at
 * their time, with or without the brain. Shaped after the to-do tools of
 * mature apps (Tasks.org's): list first, act by id, a repeating one moves
 * on when completed. */
export function todoTool(token: string): AgentTool {
  return {
    name: "todo",
    label: t("step.todo"),
    description: text("tool-todo"),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: [...actions] },
        id: {
          type: "integer",
          minimum: 1,
          description: "update、complete、remove 时必填，用 list 结果里的 id。",
        },
        title: { type: "string", description: "add 时必填。" },
        day: {
          type: "string",
          description: "YYYY-MM-DD。update 时填空字符串表示去掉日期。",
        },
        time: {
          type: "string",
          description:
            "24 小时制 HH:MM，到点提醒。update 时填空字符串表示去掉时间。",
        },
        repeat: {
          type: "string",
          enum: ["daily", "weekdays", "weekly", "none"],
        },
      },
    },
    execute: async (callId, args) => {
      const a = args as Record<string, unknown>;
      if (!(actions as readonly string[]).includes(String(a.action)))
        throw Error("未知待办操作");
      if (
        a.action === "add" &&
        !(typeof a.title === "string" && a.title.trim())
      )
        throw Error("新建待办需要 title");
      const data = await hostCall("host.todo", {
        token,
        ...a,
        // A retried call adds nothing twice.
        ...(a.action === "add" ? { key: callId } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        details: {},
      };
    },
  };
}
