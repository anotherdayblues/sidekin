import { t, tn, dateLocale } from "./i18n.ts";
import { appendToolTimeline } from "./chatToolTimeline.ts";
import { openChatImage } from "./chatImage.ts";
import { disclosure, stepSummary, stepList } from "./toolSteps.ts";
// The message list, laid out like iMessage: your messages right, the pet's
// left, a tail only on the last of a run, and a time line after a long gap.
import { sourceLinks } from "./sourceLinks.ts";
import { renderText } from "./richText.ts";
import type { Turn } from "./chatBackend.ts";

export interface ChatMessage {
  id?: number;
  steps?: Turn["steps"];
  showSteps?: boolean;
  expandedGroups?: Set<number>;
  showSources?: boolean;
  sources?: Turn["sources"];
  role: "user" | "pet" | "note";
  text: string;
  at: number;
  /** A preview URL for a picture sent this session; history only keeps a marker. */
  image?: string;
  imageTurn?: number;
  hadImage?: boolean;
  files?: string[];
  streaming?: boolean;
  error?: boolean;
}
const IMAGE_MARK = "［图片］";
const FILE_RE = /^［文件：([^］]+)］/;
const GAP = 10 * 60_000;

export function fromTurns(turns: Turn[]): ChatMessage[] {
  return turns.flatMap((t) => {
    let rest = t.question;
    if (t.thumbnail && rest.startsWith("［截图］"))
      rest = rest.slice("［截图］".length);
    const hadImage = rest.startsWith(IMAGE_MARK);
    if (hadImage) rest = rest.slice(IMAGE_MARK.length);
    const fileMatch = rest.match(FILE_RE);
    const files = fileMatch
      ? fileMatch[1].split("、").filter(Boolean)
      : undefined;
    if (fileMatch) rest = rest.slice(fileMatch[0].length);
    const user: ChatMessage = {
      role: "user",
      text: rest,
      at: t.at,
      hadImage,
      image: t.thumbnail,
      imageTurn: t.id,
      files,
    };
    return t.answer || t.steps?.length
      ? [
          user,
          {
            role: "pet" as const,
            text: t.answer,
            id: t.id,
            steps: t.steps,
            sources: t.sources,
            at: t.at,
          },
        ]
      : [user];
  });
}
function timeLabel(at: number) {
  const d = new Date(at),
    today = new Date();
  const clock = d.toLocaleTimeString(dateLocale, {
    hour: "2-digit",
    minute: "2-digit",
  });
  if (d.toDateString() === today.toDateString())
    return t("chat.todayAt", { clock });
  return (
    d.toLocaleDateString(dateLocale, { month: "long", day: "numeric" }) +
    " " +
    clock
  );
}

export function chatMessages(root: HTMLElement, empty: string) {
  const log = document.createElement("div");
  log.className = "chat-log";
  log.setAttribute("role", "log");
  log.setAttribute("aria-live", "polite");
  root.append(log);
  let list: ChatMessage[] = [];
  let lastRow: HTMLElement | undefined;
  const nearBottom = () =>
    log.scrollHeight - log.scrollTop - log.clientHeight < 80;
  const toBottom = () => (log.scrollTop = log.scrollHeight);

  function row(m: ChatMessage, next?: ChatMessage) {
    if (m.role === "note") {
      const p = document.createElement("p");
      p.className = "chat-note";
      p.dataset.error = String(!!m.error);
      p.textContent = m.text;
      return p;
    }
    const r = document.createElement("div");
    r.className = "chat-row";
    r.dataset.from = m.role;
    r.dataset.tail = String(!next || next.role !== m.role);
    const msg = document.createElement("div");
    msg.className = "chat-msg";
    if (m.image) {
      const img = document.createElement("img");
      img.className = "chat-image";
      img.src = m.image;
      img.alt = t("chat.yourImage");
      const button = document.createElement("button");
      button.type = "button";
      button.className = "chat-image-open";
      button.setAttribute("aria-label", t("chat.zoomImage"));
      button.append(img);
      button.onclick = () => openChatImage(img.src, m.imageTurn);
      r.append(button);
    } else if (m.hadImage) {
      const tag = document.createElement("span");
      tag.className = "chat-image-tag";
      tag.textContent = t("chat.image");
      msg.append(tag);
    }
    if (m.files?.length) {
      for (const name of m.files) {
        const tag = document.createElement("span");
        tag.className = "chat-image-tag chat-file-tag";
        tag.textContent = `📄 ${name}`;
        msg.append(tag);
      }
    }
    const timeline =
      m.role === "pet" &&
      !!m.steps?.length &&
      m.steps.every(
        (s) => Number.isInteger(s.textOffset) && s.textOffset! >= 0,
      );
    const start = timeline
      ? appendToolTimeline(
          r,
          m.text,
          m.steps!,
          (m.expandedGroups ??= new Set()),
        )
      : 0;
    if (timeline) r.classList.add("chat-tool-turn");
    const body = document.createElement("div");
    body.className = "chat-text";
    body.dataset.replyStart = String(start);
    const tail = m.text.slice(start);
    if (m.role === "pet") renderText(body, tail, m.streaming);
    else body.textContent = m.text;
    if (m.id) r.dataset.turn = String(m.id);
    if (m.steps?.length === 1 && m.steps[0].status === "skipped") {
      const note = document.createElement("small");
      note.className = "tool-line";
      note.textContent = m.steps[0].label;
      msg.append(note);
    } else if (m.steps?.length && !timeline)
      msg.append(
        disclosure(
          stepSummary(m.steps),
          stepList(m.steps),
          !!m.showSteps,
          (open) => (m.showSteps = open),
        ),
      );
    msg.append(body);
    if (m.sources?.length)
      msg.append(
        disclosure(
          m.steps
            ? tn("chat.sources", m.sources.length)
            : t("chat.oldSources", { n: m.sources.length }),
          sourceLinks(m.sources),
          !!m.showSources,
          (open) => (m.showSources = open),
        ),
      );
    if (m.streaming) msg.dataset.streaming = "true";
    if (!timeline || tail.trim() || m.sources?.length || m.streaming)
      r.append(msg);
    if (m.role === "pet" && !m.streaming && (tail.trim() || m.text.trim())) {
      const copy = document.createElement("button");
      copy.type = "button";
      copy.className = "chat-copy";
      copy.textContent = t("common.copy");
      copy.onclick = () => {
        void navigator.clipboard?.writeText(tail.trim() ? tail : m.text);
        copy.textContent = t("common.copied");
        setTimeout(() => (copy.textContent = t("common.copy")), 1500);
      };
      r.append(copy);
    }
    return r;
  }
  function draw() {
    const stick = nearBottom();
    log.replaceChildren();
    if (!list.length) {
      const p = document.createElement("p");
      p.className = "chat-empty";
      p.textContent = empty;
      log.append(p);
    }
    let prev: ChatMessage | undefined;
    list.forEach((m, i) => {
      if (!prev || m.at - prev.at >= GAP) {
        const t = document.createElement("p");
        t.className = "chat-time";
        t.textContent = timeLabel(m.at);
        log.append(t);
      }
      lastRow = row(m, list[i + 1]);
      log.append(lastRow);
      prev = m;
    });
    if (stick) toBottom();
  }
  return {
    el: log,
    get messages() {
      return list;
    },
    set(next: ChatMessage[]) {
      list = next;
      draw();
      toBottom();
    },
    push(...m: ChatMessage[]) {
      list.push(...m);
      draw();
      // Only the new rows play the entrance motion.
      const rows = [
        ...log.querySelectorAll<HTMLElement>(".chat-row, .chat-note"),
      ];
      for (const r of rows.slice(-m.length)) r.dataset.enter = "";
      toBottom();
    },
    /** Redraw only the last row; used for every streamed piece. */
    patchLast(change: Partial<ChatMessage>) {
      const last = list.at(-1);
      if (!last) return;
      Object.assign(last, change);
      const stick = nearBottom();
      const body = lastRow?.querySelector<HTMLElement>(
        ".chat-text[data-reply-start]",
      );
      if (
        body &&
        last.role === "pet" &&
        last.streaming &&
        Object.keys(change).every((key) => key === "text")
      ) {
        renderText(
          body,
          last.text.slice(Number(body.dataset.replyStart)),
          true,
        );
        if (stick) toBottom();
        return;
      }
      const fresh = row(last);
      lastRow?.replaceWith(fresh);
      lastRow = fresh;
      if (stick) toBottom();
    },
    redraw: draw,
  };
}
