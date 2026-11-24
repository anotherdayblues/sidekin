// One stored answer, displayed in the order in which text and tool calls arrived.
import type { ToolStep } from "../../shared/toolSteps.ts";
import { disclosure, stepList, stepSummary } from "./toolSteps.ts";
import { renderText } from "./richText.ts";

export function appendToolTimeline(
  row: HTMLElement,
  text: string,
  steps: ToolStep[],
  expanded: Set<number>,
) {
  let start = 0;
  for (let i = 0; i < steps.length;) {
    const offset = Math.max(start, Math.min(steps[i].textOffset!, text.length));
    const prefix = text.slice(start, offset);
    if (prefix.trim()) {
      const msg = document.createElement("div");
      msg.className = "chat-msg";
      const body = document.createElement("div");
      body.className = "chat-text";
      renderText(body, prefix);
      msg.append(body);
      row.append(msg);
    }
    const first = i++;
    while (
      i < steps.length &&
      Math.min(steps[i].textOffset!, text.length) <= offset
    )
      i++;
    const group = steps.slice(first, i);
    row.append(
      disclosure(
        stepSummary(group),
        stepList(group),
        expanded.has(first),
        (open) => {
          if (open) expanded.add(first);
          else expanded.delete(first);
        },
      ),
    );
    start = offset;
  }
  return start;
}
