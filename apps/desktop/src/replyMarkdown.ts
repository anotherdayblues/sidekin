import { Marked, type TokenizerAndRendererExtension } from "marked";

function escape(text: string) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function math(
  name: string,
  level: "block" | "inline",
  pattern: RegExp,
): TokenizerAndRendererExtension {
  return {
    name,
    level,
    start(text) {
      return text.search(
        level === "block" ? /(?:^|\n)(?:\$\$|\\\[)/ : /\$|\\[([]/,
      );
    },
    tokenizer(text) {
      const match = pattern.exec(text);
      if (match)
        return {
          type: name,
          raw: match[0],
          text: match.slice(1).find((v) => v !== undefined),
        };
    },
    renderer(token) {
      return '<span class="' + name + '">' + escape(token.text) + "</span>";
    },
  };
}
export const markdown = new Marked({
  breaks: true,
  renderer: {
    html(token) {
      return escape(token.text);
    },
    image(token) {
      return escape(token.text);
    },
  },
  extensions: [
    math(
      "displayMath",
      "block",
      /^(?:\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]) *(?:\n|$)/,
    ),
    math(
      "inlineMath",
      "inline",
      /^(?:\$(?![\s$])([^\n$]*?\S)\$(?![\d$])|\\\((.+?)\\\)|\\\[([\s\S]+?)\\\])/,
    ),
  ],
});
