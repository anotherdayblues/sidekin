// Media prefix markers stored in chat turns / topic titles across all 5 locales.
// Recognizes both legacy Simplified Chinese markers ("［图片］", "［截图］", "［文件：...］")
// and localized markers from all 5 supported locales, and renders them in the active UI locale.
import type { Key } from "./i18n.ts";

const SNIP_RE =
  /^(?:［截图］|［截圖］|\[Screenshot\]|\[スクリーンショット\]|\[스크린샷\])/;
const IMAGE_RE = /^(?:［图片］|［圖片］|\[Image\]|\[画像\]|\[이미지\])/;
const FILE_RE =
  /^(?:［(?:文件|檔案)：([^］]+)］|\[(?:File|ファイル|파일):\s*([^\]]+)\])/;

export interface ParsedMediaPrefix {
  hadSnip: boolean;
  hadImage: boolean;
  files?: string[];
  rest: string;
}

/** Strip leading media markers (screenshot / image / file) from a turn question or topic title. */
export function parseMediaPrefix(
  raw: string,
  hasThumbnail = false,
): ParsedMediaPrefix {
  let rest = raw;
  let hadSnip = false;
  if (hasThumbnail) {
    const snipMatch = rest.match(SNIP_RE);
    if (snipMatch) {
      hadSnip = true;
      rest = rest.slice(snipMatch[0].length);
    }
  }
  const imageMatch = rest.match(IMAGE_RE);
  const hadImage = Boolean(imageMatch);
  if (imageMatch) rest = rest.slice(imageMatch[0].length);

  const fileMatch = rest.match(FILE_RE);
  const rawNames = fileMatch?.[1] ?? fileMatch?.[2];
  const files = rawNames
    ? rawNames
        .split("、")
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;
  if (fileMatch) rest = rest.slice(fileMatch[0].length);

  return { hadSnip, hadImage, files, rest };
}

/** Localize any leading media placeholders in a topic title for display in the active UI language. */
export function localizeTopicTitle(
  raw: string,
  lookup: (key: Key, vars?: Record<string, string | number>) => string,
): string {
  if (!raw) return raw;
  let rest = raw;
  const parts: string[] = [];

  const snipMatch = rest.match(SNIP_RE);
  if (snipMatch) {
    parts.push(lookup("host.topicMedia.snip"));
    rest = rest.slice(snipMatch[0].length);
  }
  const imageMatch = rest.match(IMAGE_RE);
  if (imageMatch) {
    parts.push(lookup("host.topicMedia.image"));
    rest = rest.slice(imageMatch[0].length);
  }
  const fileMatch = rest.match(FILE_RE);
  if (fileMatch) {
    const name = (fileMatch[1] ?? fileMatch[2] ?? "").trim();
    parts.push(lookup("host.topicMedia.file", { name }));
    rest = rest.slice(fileMatch[0].length);
  }
  if (!parts.length) return raw;
  const trimmedRest = rest.trimStart();
  const prefix = parts.join("");
  if (!trimmedRest) return prefix;
  const sep =
    prefix.endsWith("］") || /^[.,!?;:，。！？；：]/.test(trimmedRest)
      ? ""
      : " ";
  return prefix + sep + trimmedRest;
}
