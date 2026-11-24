import { t } from "../i18n.ts";
import generic from "./vendor/material-icons/generic.svg?url";
import folder from "./vendor/material-icons/folder.svg?url";
import pdf from "./vendor/material-icons/pdf.svg?url";
import image from "./vendor/material-icons/image.svg?url";
import video from "./vendor/material-icons/video.svg?url";
import audio from "./vendor/material-icons/audio.svg?url";
import archive from "./vendor/material-icons/archive.svg?url";
import word from "./vendor/material-icons/word.svg?url";
import sheet from "./vendor/material-icons/sheet.svg?url";
import slides from "./vendor/material-icons/slides.svg?url";
import code from "./vendor/material-icons/code.svg?url";
import json from "./vendor/material-icons/json.svg?url";
import markdown from "./vendor/material-icons/markdown.svg?url";
export interface FileMeta {
  path: string;
  isDirectory: boolean;
  exists: boolean;
  /** Bytes; null for folders and missing paths. */
  size?: number | null;
}
const icons = {
  generic,
  folder,
  pdf,
  image,
  video,
  audio,
  archive,
  word,
  sheet,
  slides,
  code,
  json,
  markdown,
};
type Kind = keyof typeof icons;
const groups: Record<string, Kind> = {};
for (const [kind, list] of Object.entries({
  pdf: "pdf",
  image: "png jpg jpeg gif webp svg bmp heic heif tif tiff avif ico",
  video: "mp4 mov mkv avi webm m4v",
  audio: "mp3 wav flac aac m4a ogg",
  archive: "zip rar 7z tar gz bz2 xz dmg iso",
  word: "doc docx odt rtf",
  sheet: "xls xlsx xlsm csv ods",
  slides: "ppt pptx odp",
  code: "js jsx ts tsx py rs go java c h cpp cs html css sh ps1 yaml yml toml",
  json: "json jsonc",
  markdown: "md markdown",
}))
  for (const ext of list.split(" ")) groups[ext] = kind as Kind;
const labels: Record<Kind, string> = {
  generic: t("kind.generic"),
  folder: t("kind.folder"),
  pdf: t("kind.pdf"),
  image: t("kind.image"),
  video: t("kind.video"),
  audio: t("kind.audio"),
  archive: t("kind.archive"),
  word: t("kind.word"),
  sheet: t("kind.sheet"),
  slides: t("kind.slides"),
  code: t("kind.code"),
  json: "JSON",
  markdown: "Markdown",
};
export function fileType(path: string, meta?: FileMeta) {
  const name = path.split(/[\\/]/).pop() ?? path;
  const ext = name.includes(".") ? name.split(".").pop()!.toLowerCase() : "";
  const kind: Kind = meta?.isDirectory ? "folder" : (groups[ext] ?? "generic");
  const type = labels[kind] + (!meta?.isDirectory && ext ? " · ." + ext : "");
  return {
    kind,
    icon: icons[kind],
    label: type,
    kindLabel: labels[kind],
    extension: ext,
    name,
  };
}
