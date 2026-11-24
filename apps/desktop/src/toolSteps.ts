import { t, tn } from "./i18n.ts";
import type { ToolStep } from "../../shared/toolSteps.ts";
import { sourceLinks } from "./sourceLinks.ts";
import "./styles/tool-steps.css";

function brief(value = "") {
  const chars = Array.from(value.replace(/\s+/g, " "));
  return chars.length > 45 ? chars.slice(0, 44).join("") + "…" : chars.join("");
}

export function stepSummary(steps: ToolStep[]) {
  const active = steps
    .slice()
    .reverse()
    .find((s) => s.status === "running");
  if (active) {
    if (active.name === "web_search")
      return t("steps.searching", { what: brief(active.argument) });
    if (active.name === "web_read")
      return t("steps.reading", { what: brief(active.argument) });
    return t("steps.running", { label: active.label });
  }
  const searches = steps.filter(
    (s) => s.name === "web_search" && s.status !== "skipped",
  ).length;
  const reads = steps.filter(
    (s) => s.name === "web_read" && s.status === "ok",
  ).length;
  const failed = steps.filter(
    (s) => s.name === "web_read" && s.status === "failed",
  ).length;
  const other = steps.filter(
    (s) => !["web_search", "web_read"].includes(s.name),
  );
  return [
    steps.some((s) => s.status === "skipped") && t("steps.noSearch"),
    searches && tn("steps.searched", searches),
    reads && tn("steps.read", reads),
    failed && tn("steps.readFailed", failed),
    other.length === 1
      ? other[0].label
      : other.length && tn("steps.tools", other.length),
  ]
    .filter(Boolean)
    .join(t("steps.joiner"));
}
export function disclosure(
  label: string,
  content: HTMLElement,
  open: boolean,
  toggle: (open: boolean) => void,
) {
  const wrap = document.createElement("div");
  wrap.className = "tool-fold";
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  const panel = document.createElement("div");
  panel.className = "tool-panel";
  panel.append(content);
  const set = (value: boolean) => {
    wrap.dataset.open = String(value);
    button.setAttribute("aria-expanded", String(value));
    panel.inert = !value;
  };
  set(open);
  button.onclick = () => {
    const next = wrap.dataset.open !== "true";
    set(next);
    toggle(next);
  };
  wrap.append(button, panel);
  return wrap;
}
function icon(name: string) {
  if (name === "web_search") return "🔍";
  if (name === "web_read") return "📄";
  if (name.startsWith("reminder")) return "◷";
  if (name.startsWith("library")) return "▤";
  if (name === "memory" || name === "search_history") return "✎";
  return "⚙";
}
export function stepList(steps: ToolStep[]) {
  const list = document.createElement("ol");
  for (const step of steps) {
    const item = document.createElement("li");
    const mark = document.createElement("span");
    mark.setAttribute("aria-hidden", "true");
    mark.textContent = icon(step.name) + " ";
    item.append(mark, step.label);
    if (step.argument && (step.name !== "web_read" || !step.pages?.length)) {
      item.append(" · " + brief(step.argument));
      item.title = step.argument;
    }
    if (step.status === "failed") item.append(" · " + step.reason);
    if (step.pages?.length) item.append(sourceLinks(step.pages));
    list.append(item);
  }
  return list;
}
export function bubbleSteps(steps: ToolStep[], open?: () => void) {
  const line = document.createElement(open ? "button" : "small");
  line.className = "tool-line";
  line.textContent = stepSummary(steps);
  if (open) line.onclick = open;
  return line;
}
