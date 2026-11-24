import { t } from "./locale.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";

const waiting = new Map<
  string,
  { token: string; finish: (value: string) => void }
>();

export function answerQuestion(token: string, id: string, value: string) {
  const request = waiting.get(id);
  if (
    !request ||
    request.token !== token ||
    !value.trim() ||
    value.length > 2000
  )
    return false;
  request.finish(value.trim());
  return true;
}

export function clarifyTool(
  token: string,
  notify: (method: string, data: object) => void,
  onAnswer: (question: string, answer: string) => void,
): AgentTool {
  return {
    name: "clarify",
    label: t("step.clarify"),
    description:
      "需要用户决定且答案会改变结果时提问。给出简短选项，推荐项放第一，界面提供自填。小事自行判断。把回答用于当前任务，只有长期偏好才写入记忆。",
    parameters: {
      type: "object",
      properties: {
        question: { type: "string" },
        options: { type: "array", items: { type: "string" }, maxItems: 4 },
      },
      required: ["question", "options"],
    },
    execute: async (_id, args, signal) => {
      const { question, options } = args as {
        question: string;
        options: string[];
      };
      if (
        !question?.trim() ||
        !Array.isArray(options) ||
        options.length > 4 ||
        options.some((v) => typeof v !== "string" || !v.trim())
      )
        throw Error("问题或选项无效");
      const id = crypto.randomUUID();
      let cancel: () => void = () => {};
      try {
        const answer = await new Promise<string>((resolve, reject) => {
          cancel = () => reject(Error("stopped"));
          if (signal?.aborted) {
            cancel();
            return;
          }
          signal?.addEventListener("abort", cancel, { once: true });
          waiting.set(id, { token, finish: resolve });
          notify("chat.question", { id, question, options });
        });
        onAnswer(question, answer);
        return { content: [{ type: "text", text: answer }], details: {} };
      } finally {
        waiting.delete(id);
        signal?.removeEventListener("abort", cancel);
        notify("chat.questionClosed", { id });
      }
    },
  };
}
