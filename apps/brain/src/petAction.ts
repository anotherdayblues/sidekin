import { t } from "./locale.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { text as promptText } from "./texts.ts";

/** One action the pet on the desktop can do, as Rust lists it. */
export interface ActionChoice {
  name: string;
  label: string;
  sleep?: boolean;
}
export interface PetActionPick {
  action: string;
  reason: "asked" | "feeling";
}

/**
 * Lets the model pick one action for the pet. Nothing plays here: the pick
 * rides along with the answer, and the desktop plays it once the answer is
 * done, so the "working" pose never hides it.
 */
export function petActionTool(
  choices: ActionChoice[],
  scheduled: boolean,
  onPick: (pick: PetActionPick) => void,
): AgentTool {
  let picked = false;
  const reasons = scheduled ? ["asked"] : ["asked", "feeling"];
  return {
    name: "pet_action",
    label: t("step.petAction"),
    description:
      promptText("tool-pet-action") +
      "\n可选的动作：\n" +
      choices.map((c) => `${c.name}：${c.label}`).join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: choices.map((c) => c.name) },
        reason: { type: "string", enum: reasons },
      },
      required: ["action", "reason"],
      additionalProperties: false,
    },
    execute: async (_id, args) => {
      const { action, reason } = args as Record<string, unknown>;
      const choice = choices.find((c) => c.name === action);
      if (!choice) throw Error("没有这个动作");
      if (!reasons.includes(String(reason))) throw Error("reason 无效");
      if (choice.sleep && reason !== "asked")
        throw Error("只有用户叫你睡时才能睡觉");
      if (picked) throw Error("这次回答已经做过动作了");
      picked = true;
      onPick({
        action: choice.name,
        reason: reason as PetActionPick["reason"],
      });
      return {
        content: [
          {
            type: "text",
            text: "已记下，回答说完后会做。已经回复过用户就不用再说话；还没回复就照常回复，不用提这个动作。",
          },
        ],
        details: {},
      };
    },
  };
}
