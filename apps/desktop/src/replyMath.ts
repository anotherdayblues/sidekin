import katex from "katex";
import "katex/dist/katex.min.css";

export function typeset(el: HTMLElement) {
  katex.render(el.textContent ?? "", el, {
    displayMode: el.classList.contains("displayMath"),
    throwOnError: false,
    trust: false,
  });
}
