// The packaged sidecar embeds these same files at build time. Source-mode tests
// load only the named application assets, never a path supplied by a tool.
import { existsSync, readFileSync } from "node:fs";
declare const __COMPANION_TEXTS__: Record<string, string>;
const names = [
  "core",
  "persona-default",
  "tool-memory",
  "tool-search-history",
  "review",
  "model-hints",
  "hermes-tool-use",
  "time-note",
  "translate",
  "selection-explain",
  "selection-polish",
  "selection-summarize",
  "snip-note",
  "image-note",
  "proactive",
  "proactive-gate",
  "compact",
  "checkpoint",
  "tool-web-search",
  "tool-web-read",
  "web-guidance",
  "search-now",
  "tool-library",
  "tool-pet-action",
  "tool-focus",
  "tool-todo",
  "todo-split",
  "todo-break",
  "voice-reply",
  "attached-file",
  "attached-file-omitted",
  // The English layer (plan/15): only the pieces bound to a language.
  "language.en",
  "turn-language.en",
  "persona-default.en",
  "selection-explain.en",
  "selection-summarize.en",
] as const;
type Name = (typeof names)[number];
const source: Record<string, string> =
  typeof __COMPANION_TEXTS__ !== "undefined"
    ? __COMPANION_TEXTS__
    : Object.fromEntries(
        names.map((n) => [
          n,
          readFileSync(
            new URL("../prompts/" + n + ".md", import.meta.url),
            "utf8",
          ),
        ]),
      );
export function text(name: Name) {
  return source[name].trimEnd();
}
/**
 * Load an optional per-locale overlay prompt (e.g. `language.ja`, `persona-default.zh-TW`).
 * In packaged builds, scripts/build-brain.mjs embeds every *.md in apps/brain/prompts.
 */
export function optionalText(name: string): string | undefined {
  if (!/^[a-z0-9-]+(?:\.[a-zA-Z0-9-]+)*$/.test(name)) return undefined;
  if (Object.hasOwn(source, name)) return source[name].trimEnd();
  if (typeof __COMPANION_TEXTS__ !== "undefined") return undefined;
  const url = new URL("../prompts/" + name + ".md", import.meta.url);
  if (!existsSync(url)) return undefined;
  const content = readFileSync(url, "utf8");
  source[name] = content;
  return content.trimEnd();
}
export function fill(template: string, values: Record<string, string>) {
  return template.replace(/\{\{([^{}]+)\}\}/g, (original, k) =>
    Object.hasOwn(values, k) ? values[k] : original,
  );
}
export function timeNote(now: Date, last?: number, timeZone?: string) {
  const clock = now.toLocaleTimeString("en-GB", {
      timeZone,
      hour: "2-digit",
      minute: "2-digit",
    }),
    mins = Math.max(
      0,
      Math.floor((now.getTime() - (last ?? now.getTime())) / 60000),
    );
  const template =
    mins < 10
      ? text("time-note").replace("，{{星期}}。距上次说话 {{间隔}}", "")
      : text("time-note");
  return fill(template, {
    "时:分": clock,
    星期: now.toLocaleDateString("zh-CN", { weekday: "long", timeZone }),
    间隔:
      mins >= 1440
        ? Math.floor(mins / 1440) + " 天"
        : mins >= 60
          ? Math.floor(mins / 60) + " 小时"
          : mins + " 分钟",
  });
}
