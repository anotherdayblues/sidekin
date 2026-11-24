// Past topics, newest first, with a search box, opened over the messages of
// the chat panel (plan/29). As the history of ChatGPT's and Claude's
// sidebars: grouped by day, each with the face of the pet it was with and
// its time; 翻译记录 at the foot. A new topic is the header's key.
import { t, dateLocale, type Key } from "./i18n.ts";
import type { LinkedTask, Topic } from "./chatBackend.ts";

interface Options {
  showTranslations?: () => void;
  /** The face of the pet a topic was with. */
  face(pet: string): Promise<string>;
  load(query: string): Promise<Topic[]>;
  linked(id: number): Promise<LinkedTask[]>;
  remove(id: number, removeTasks: boolean, expected: number[]): Promise<void>;
  open(id: number): Promise<void>;
}
function icon(
  button: HTMLButtonElement,
  kind: "trash" | "check",
  label: string,
) {
  button.title = label;
  button.setAttribute("aria-label", label);
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("width", "16");
  svg.setAttribute("height", "16");
  svg.setAttribute("aria-hidden", "true");
  const line = document.createElementNS(svg.namespaceURI, "path");
  line.setAttribute(
    "d",
    kind === "check"
      ? "M5 12l4 4L19 6"
      : "M3 6h18M9 6V3h6v3M6 6l1 15h10l1-15M10 10v7m4-7v7",
  );
  line.setAttribute("fill", "none");
  line.setAttribute("stroke", "currentColor");
  line.setAttribute("stroke-width", "1.7");
  line.setAttribute("stroke-linecap", "round");
  line.setAttribute("stroke-linejoin", "round");
  svg.append(line);
  button.append(svg);
}
const DAY = 86_400_000;
type Bucket = "today" | "yesterday" | "week" | "earlier";
function bucket(at: number): Bucket {
  const start = new Date().setHours(0, 0, 0, 0);
  if (at >= start) return "today";
  if (at >= start - DAY) return "yesterday";
  if (at >= start - 6 * DAY) return "week";
  return "earlier";
}
/** Its time within the day's group: the hour today and yesterday, the
 * weekday this week, the date before. */
export function topicTime(at: number) {
  const d = new Date(at);
  switch (bucket(at)) {
    case "today":
    case "yesterday":
      return d.toLocaleTimeString(dateLocale, {
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
    case "week":
      return d.toLocaleDateString(dateLocale, { weekday: "short" });
    default:
      return d.toLocaleDateString(dateLocale, {
        month: "short",
        day: "numeric",
      });
  }
}

export function chatTopics(root: HTMLElement, o: Options) {
  const panel = document.createElement("aside");
  panel.className = "chat-topics";
  panel.setAttribute("aria-label", t("chat.topics"));
  panel.innerHTML = `<input type="search" placeholder="${t("chat.searchTopics")}" aria-label="${t("chat.searchTopics")}"><ul></ul>`;
  if (o.showTranslations) {
    const entry = document.createElement("button");
    entry.type = "button";
    entry.className = "chat-translations-entry";
    entry.textContent = t("chat.translations");
    entry.onclick = o.showTranslations;
    panel.append(entry);
  }
  root.append(panel);
  const search = panel.querySelector("input")!,
    list = panel.querySelector("ul")!;
  let current: number | null = null;
  let timer = 0;
  async function refresh() {
    let topics: Topic[];
    try {
      topics = await o.load(search.value);
    } catch (e) {
      list.innerHTML = "";
      list.append(
        Object.assign(document.createElement("li"), {
          className: "chat-topics-empty",
          textContent: String(e),
        }),
      );
      return;
    }
    let group = "";
    list.replaceChildren(
      ...topics.flatMap((topic) => {
        const li = document.createElement("li");
        li.className = "chat-topic";
        const b = document.createElement("button");
        b.type = "button";
        b.className = "topic-open";
        b.setAttribute("aria-current", String(topic.id === current));
        const face = document.createElement("img");
        face.className = "topic-face";
        face.alt = "";
        void o.face(topic.pet).then((url) => {
          if (url) face.src = url;
        });
        const title = document.createElement("span");
        title.textContent = topic.title || t("chat.emptyTopic");
        const meta = document.createElement("small");
        meta.textContent = topicTime(topic.lastAt);
        b.append(face, title, meta);
        b.onclick = () => void o.open(topic.id);
        const remove = document.createElement("button");
        remove.type = "button";
        remove.className = "topic-remove";
        icon(remove, "trash", t("chat.deleteTopic", { title: topic.title }));
        remove.onclick = async () => {
          remove.disabled = true;
          let tasks: LinkedTask[];
          try {
            tasks = await o.linked(topic.id);
          } catch (e) {
            remove.disabled = false;
            const error = document.createElement("small");
            error.textContent = String(e);
            li.append(error);
            return;
          }
          const panel = document.createElement("fieldset");
          panel.className = "topic-delete-confirm";
          const heading = document.createElement("legend");
          heading.textContent = t("chat.deleteAsk", { title: topic.title });
          panel.append(heading);
          let removeTasks = false;
          if (tasks.length) {
            const names = document.createElement("ul");
            names.setAttribute("aria-label", t("chat.linkedTasks"));
            for (const task of tasks) {
              const item = document.createElement("li");
              item.textContent = task.name;
              names.append(item);
            }
            panel.append(names);
            for (const [i, text] of [
              t("chat.deleteChatOnly"),
              t("chat.deleteBoth"),
            ].entries()) {
              const label = document.createElement("label"),
                radio = document.createElement("input");
              radio.type = "radio";
              radio.name = "topic-delete-" + topic.id;
              radio.checked = i === 0;
              radio.onchange = () => {
                removeTasks = i === 1;
              };
              label.append(radio, text);
              panel.append(label);
            }
          }
          const controls = document.createElement("div");
          const confirm = document.createElement("button"),
            cancel = document.createElement("button");
          confirm.type = cancel.type = "button";
          confirm.className = "topic-remove is-confirm";
          icon(confirm, "check", t("common.confirmDelete"));
          cancel.textContent = t("common.cancel");
          const error = document.createElement("small");
          error.setAttribute("role", "alert");
          controls.append(confirm, cancel);
          panel.append(controls, error);
          li.replaceChildren(panel);
          cancel.focus();
          cancel.onclick = () => void refresh();
          confirm.onclick = async () => {
            panel.disabled = true;
            try {
              await o.remove(
                topic.id,
                removeTasks,
                tasks.map((task) => task.id),
              );
              await refresh();
            } catch (e) {
              panel.disabled = false;
              error.textContent = String(e);
            }
          };
        };
        li.append(b, remove);
        // A heading where the day's group changes.
        const day = bucket(topic.lastAt);
        if (day === group) return [li];
        group = day;
        const head = document.createElement("li");
        head.className = "chat-topics-day";
        head.textContent = t(`chat.day.${day}` as Key);
        return [head, li];
      }),
    );
    if (!topics.length)
      list.append(
        Object.assign(document.createElement("li"), {
          className: "chat-topics-empty",
          textContent: search.value ? t("chat.noMatch") : t("chat.noTopics"),
        }),
      );
  }
  search.oninput = () => {
    clearTimeout(timer);
    timer = window.setTimeout(() => void refresh(), 200);
  };
  return {
    el: panel,
    refresh,
    mark(id: number | null) {
      current = id;
      for (const b of list.querySelectorAll(".topic-open"))
        b.setAttribute("aria-current", "false");
      void refresh();
    },
  };
}
