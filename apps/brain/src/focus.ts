import { t } from "./locale.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hostCall } from "./host.ts";
import { text } from "./texts.ts";

const actions = ["start", "pause", "resume", "stop", "rest", "status"] as const;

/** 番茄钟 (plan/19 §9.8): the host owns the timer; this only asks it. */
export function focusTool(token: string): AgentTool {
  return {
    name: "focus_timer",
    label: t("step.focus"),
    description: text("tool-focus"),
    parameters: {
      type: "object",
      additionalProperties: false,
      required: ["action"],
      properties: {
        action: { type: "string", enum: [...actions] },
        minutes: {
          type: "integer",
          minimum: 1,
          maximum: 180,
          description: "只在 start 时用，用户说了时长才填。",
        },
        todo_id: {
          type: "integer",
          minimum: 1,
          description:
            "只在 start 时用：专注做待办里的哪一条（todo 工具 list 结果里的 id）。",
        },
      },
    },
    execute: async (_id, args) => {
      const { action, minutes, todo_id } = args as {
        action: string;
        minutes?: number;
        todo_id?: number;
      };
      if (!(actions as readonly string[]).includes(action))
        throw Error("未知计时操作");
      const data = await hostCall("host.focus", {
        token,
        action,
        ...(action === "start" && minutes ? { minutes } : {}),
        ...(action === "start" && todo_id ? { todo_id } : {}),
      });
      return {
        content: [{ type: "text" as const, text: JSON.stringify(data) }],
        details: {},
      };
    },
  };
}
