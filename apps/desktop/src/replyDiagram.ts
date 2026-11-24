import { t } from "./i18n.ts";
import mermaid from "mermaid";
import DOMPurify from "dompurify";

mermaid.initialize({
  startOnLoad: false,
  securityLevel: "strict",
  htmlLabels: false,
  flowchart: { htmlLabels: false },
  suppressErrorRendering: true,
});
let serial = 0;
export async function diagram(code: HTMLElement, source: string) {
  if (
    !code.isConnected ||
    source.length > 20000 ||
    /%%\s*\{|^\s*---/.test(source)
  )
    return;
  const result = await mermaid.render("replyGraph" + ++serial, source);
  if (!code.isConnected) return;
  const figure = document.createElement("figure");
  figure.innerHTML = DOMPurify.sanitize(result.svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    FORBID_TAGS: ["a", "image", "foreignObject"],
  });
  if (figure.querySelector("svg")) {
    const pre = code.parentElement!;
    const details = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = t("chat.diagramCode");
    pre.replaceWith(figure, details);
    details.append(summary, pre);
  }
}
