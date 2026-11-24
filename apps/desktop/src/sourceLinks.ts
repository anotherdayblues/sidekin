import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import "./styles/web-tools.css";

export function sourceLinks(
  items: { title: string; url: string }[],
  compact = false,
) {
  const box = document.createElement("div");
  box.className = compact ? "web-sources compact" : "web-sources";
  for (const item of compact ? items.slice(-1) : items) {
    let url: URL;
    try {
      url = new URL(item.url);
    } catch {
      continue;
    }
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      continue;
    const link = document.createElement("a");
    link.href = url.href;
    link.rel = "noopener noreferrer";
    link.target = "_blank";
    // A source is a small chip: where it came from, then what it is.
    const host = document.createElement("span"),
      title = document.createElement("span");
    host.className = "source-host";
    title.className = "source-title";
    host.textContent = compact
      ? t("chat.source")
      : url.hostname.replace(/^www\./, "");
    title.textContent = item.title || url.hostname;
    link.append(host, title);
    link.title = url.href;
    if (native)
      link.onclick = (e) => {
        e.preventDefault();
        void invoke("open_bubble_link", { url: url.href });
      };
    box.append(link);
  }
  return box;
}
