import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import DOMPurify from "dompurify";
import { markdown } from "./replyMarkdown.ts";
import { native } from "./bridge.ts";
import "./styles/reply.css";

function decorate(block: HTMLElement, ready: boolean) {
  for (const link of block.querySelectorAll("a")) {
    if (!/^https?:\/\//i.test(link.getAttribute("href") ?? "")) {
      link.replaceWith(...link.childNodes);
      continue;
    }
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    if (native)
      link.onclick = (event) => {
        event.preventDefault();
        void invoke("open_bubble_link", { url: link.href });
      };
  }
  for (const el of block.querySelectorAll<HTMLElement>(
    ".inlineMath, .displayMath",
  )) {
    void import("./replyMath.ts")
      .then(({ typeset }) => typeset(el))
      .catch(() => {});
  }
  for (const code of block.querySelectorAll<HTMLElement>("pre > code")) {
    const source = (code.textContent ?? "").replace(/\n$/, "");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "code-copy";
    button.textContent = t("common.copy");
    button.onclick = async () => {
      await navigator.clipboard.writeText(source);
      button.textContent = t("common.copied");
      setTimeout(() => (button.textContent = t("common.copy")), 1500);
    };
    code.parentElement!.append(button);
    const language = code.className.replace(/^language-/, "");
    if (ready && language === "mermaid") {
      void import("./replyDiagram.ts")
        .then(({ diagram }) => diagram(code, source))
        .catch(() => {});
    } else if (ready && language) {
      void import("highlight.js/lib/common")
        .then(({ default: hljs }) => {
          if (hljs.getLanguage(language)) hljs.highlightElement(code);
        })
        .catch(() => {});
    }
  }
}

const previous = new WeakMap<Element, string>();
export function renderText(el: HTMLElement, text: string, streaming = false) {
  el.classList.add("rich-reply");
  let index = 0;
  for (const token of markdown.lexer(text)) {
    if (token.type === "space") continue;
    const html = markdown.parser([token]);
    const fence =
      token.type === "code" && token.raw.match(/^ {0,3}(`{3,}|~{3,})/);
    const closed =
      !fence ||
      new RegExp(
        "\\n {0,3}" + fence[1][0] + "{" + fence[1].length + ",}[ \\t]*\\n?$",
      ).test(token.raw);
    const ready = !streaming || closed;
    const key = html + String(ready);
    const old = el.children[index++];
    if (old && previous.get(old) === key) continue;
    const block = document.createElement("div");
    block.innerHTML = DOMPurify.sanitize(html, {
      ALLOWED_TAGS: [
        "p",
        "br",
        "h1",
        "h2",
        "h3",
        "h4",
        "h5",
        "h6",
        "hr",
        "em",
        "strong",
        "del",
        "span",
        "a",
        "blockquote",
        "ul",
        "ol",
        "li",
        "table",
        "thead",
        "tbody",
        "tr",
        "th",
        "td",
        "pre",
        "code",
        "input",
      ],
      ALLOWED_ATTR: [
        "href",
        "title",
        "class",
        "start",
        "align",
        "type",
        "disabled",
        "checked",
      ],
    });
    if (old) old.replaceWith(block);
    else el.append(block);
    previous.set(block, key);
    decorate(block, ready);
  }
  while (el.children.length > index) el.lastElementChild!.remove();
}
