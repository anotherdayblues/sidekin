import { requests } from "./runtime.ts";
import { fill, text } from "./texts.ts";
import { english } from "./locale.ts";
import { normalizeContext } from "@earendil-works/pi-ai";
import { modelFor, streamModel, fault, type Connection } from "./models.ts";
export type SelectionAction = "translate" | "explain" | "polish" | "summarize";
const CHINESE = /中文|汉语|漢語|chinese|^zh/i;
const ENGLISH = /英文|英语|english|^en$/i;
/** 语气 (plan/41): auto leaves the target language as it is. */
const TONES: Record<string, string> = {
  formal: "语气正式、礼貌",
  casual: "语气随意、口语",
};
/**
 * Which language a text goes into. `partner` is 对方语言 (plan/41), the
 * language of the person on the other side: the user's own language goes into
 * it, anything else comes back into the user's language. `into` names the
 * language when the host can show it; an English reader's text is told apart
 * by the model, not by script, so then it is left out.
 */
export function translationTarget(
  text: string,
  partner?: string,
  tone?: string,
): { target: string; into?: string } {
  const en = english();
  let other = partner && partner !== "auto" ? partner : en ? "中文" : "英文";
  let target: string, into: string | undefined;
  if (en) {
    if (ENGLISH.test(other)) other = "中文";
    target = `英文（原文已经是英文时，译成${other}）`;
  } else {
    if (CHINESE.test(other)) other = "英文";
    const han = text.match(/\p{Script=Han}/gu)?.length ?? 0,
      letters = text.match(/\p{Letter}/gu)?.length ?? 0;
    into = han > 0 && han * 2 >= letters ? other : "中文";
    target = into;
  }
  const how = tone ? TONES[tone] : undefined;
  return { target: how ? `${target}，${how}` : target, into };
}
export function targetLanguage(text: string, partner?: string) {
  return translationTarget(text, partner).target;
}
/** The system prompt for one 选字 action; anything unknown is a translation. */
export function selectionSystemPrompt(prompt: {
  text: string;
  target?: string;
  tone?: string;
  action?: string;
}) {
  const en = english();
  if (prompt.action === "explain")
    return text(en ? "selection-explain.en" : "selection-explain");
  if (prompt.action === "polish") return text("selection-polish");
  // 待办 (plan/31): a pasted paragraph into to-dos, or one into steps.
  if (prompt.action === "todo-split") return text("todo-split");
  if (prompt.action === "todo-break") return text("todo-break");
  if (prompt.action === "summarize")
    return text(en ? "selection-summarize.en" : "selection-summarize");
  return fill(text("translate"), {
    目标语言: translationTarget(prompt.text, prompt.target, prompt.tone).target,
  });
}
export async function translate(
  c: Connection,
  prompt: { text: string; target?: string; tone?: string; action?: string },
  notify: (method: string, data: object) => void,
  signal: AbortSignal,
) {
  const model = modelFor(c);
  let result = "";
  const scope = requests.getStore();
  if (scope)
    scope.rewind = (count) => {
      const before = [...result];
      result = before.slice(0, Math.max(0, before.length - count)).join("");
      notify("chat.rewind", { text: result });
    };
  const output = await streamModel(
    model,
    normalizeContext({
      messages: [
        {
          role: "system",
          content: selectionSystemPrompt(prompt),
          timestamp: Date.now(),
        },
        { role: "user", content: prompt.text, timestamp: Date.now() },
      ],
    }),
    { apiKey: c.apiKey || "local", signal, maxRetries: 0 },
  );
  for await (const event of output) {
    if (event.type === "text_delta") {
      result += event.delta;
      notify("chat.delta", { delta: event.delta });
    }
    if (event.type === "error")
      throw new Error(
        signal.aborted ? "stopped" : fault(event.error.errorMessage ?? ""),
      );
  }
  if (!result) throw new Error("model");
  if (prompt.action && prompt.action !== "translate") return { text: result };
  const { into } = translationTarget(prompt.text, prompt.target, prompt.tone);
  return into ? { text: result, into } : { text: result };
}
