// What 伙伴大脑 drafted for 待办 (plan/31), for the user to check before
// anything is added: each one ticked, untick the ones not wanted, then one
// key adds the rest (Todoist's Ramble shows its list the same way). While
// it thinks, a line with the pet's face says so.
import "./todo-ai.css";
import { t } from "../i18n.ts";
import { dayLabel, today, todos, type Draft, type Todo } from "./api.ts";
import { petMark } from "./petMark.ts";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** "伙伴在想…" with the pet's face. */
export function thinking() {
  const p = el("p", "todo-drafts-thinking");
  p.append(petMark(), el("span", "", t("todo.aiThinking")));
  return p;
}

/** The drafts with a tick each; `go` gets the ticked ones. `key` names the
 * add key for a count ("加入 {n} 件"). */
export function draftList(
  drafts: Draft[],
  o: {
    lead: string;
    key: (n: number) => string;
    note?: string;
    go(picked: Draft[]): void;
    cancel(): void;
  },
) {
  const box = el("div", "todo-drafts");
  if (!drafts.length) {
    const none = el("p", "todo-drafts-none");
    none.append(petMark(), el("span", "", t("todo.aiNone")));
    const back = el("button", "todo-drafts-cancel", t("todo.aiCancel"));
    back.type = "button";
    back.onclick = o.cancel;
    box.append(none, back);
    return box;
  }
  const lead = el("p", "todo-drafts-lead");
  lead.append(petMark(), el("span", "", o.lead));
  const list = el("ul", "todo-drafts-list");
  const picked = drafts.map(() => true);
  const go = el("button", "todo-drafts-go");
  go.type = "button";
  const count = () => {
    const n = picked.filter(Boolean).length;
    go.textContent = o.key(n);
    go.disabled = n === 0;
  };
  drafts.forEach((d, i) => {
    const li = el("li");
    const label = el("label");
    const box = el("input");
    box.type = "checkbox";
    box.checked = true;
    box.onchange = () => {
      picked[i] = box.checked;
      li.toggleAttribute("data-off", !box.checked);
      count();
    };
    const title = el("span", "todo-drafts-title", d.title);
    if (d.note) title.append(el("small", "", d.note));
    label.append(box, title);
    const when = [d.day ? dayLabel(d.day) : "", d.time ?? ""]
      .filter(Boolean)
      .join(" ");
    if (when) {
      const w = el("small", "todo-drafts-when", when);
      if (d.time) w.dataset.remind = "";
      label.append(w);
    }
    li.append(label);
    list.append(li);
  });
  const keys = el("div", "todo-drafts-keys");
  const cancel = el("button", "todo-drafts-cancel", t("todo.aiCancel"));
  cancel.type = "button";
  keys.append(go, cancel);
  if (o.note) keys.append(el("small", "todo-drafts-note", o.note));
  go.onclick = () => o.go(drafts.filter((_, i) => picked[i]));
  cancel.onclick = o.cancel;
  count();
  box.append(lead, list, keys);
  return box;
}

/** 整理成几条: the paragraph read into to-dos in `slot`, added once picked.
 * `done` gets how many were added (0 when given up). */
export async function tidy(
  slot: HTMLElement,
  text: string,
  o: { source?: string; done(n: number): void },
) {
  slot.hidden = false;
  slot.replaceChildren(thinking());
  let drafts: Draft[] = [];
  try {
    drafts = await todos.plan(text, "split");
  } catch {
    drafts = [];
  }
  const end = (n: number) => {
    slot.replaceChildren();
    slot.hidden = true;
    o.done(n);
  };
  slot.replaceChildren(
    draftList(drafts, {
      lead: t("todo.aiTidyLead", { n: drafts.length }),
      key: (n) => t("todo.aiAdd", { n }),
      async go(picked) {
        for (const d of picked)
          await todos.add(
            { title: d.title, day: d.day ?? "", time: d.time ?? "" },
            o.source,
          );
        end(picked.length);
      },
      cancel: () => end(0),
    }),
  );
}

/** 帮我拆一下: `todo` as steps in `slot`. Picked, they take its place, in
 * its group, and `done` is told so the row can go (with 撤销). */
export async function breakDown(
  slot: HTMLElement,
  todo: Todo,
  done: (replaced: boolean) => void,
) {
  slot.hidden = false;
  slot.replaceChildren(thinking());
  let drafts: Draft[] = [];
  try {
    drafts = await todos.plan(todo.title, "break");
  } catch {
    drafts = [];
  }
  const end = (replaced: boolean) => {
    slot.replaceChildren();
    slot.hidden = true;
    done(replaced);
  };
  slot.replaceChildren(
    draftList(drafts, {
      lead: t("todo.aiBreakLead", { n: drafts.length }),
      key: (n) => t("todo.aiReplace", { n }),
      note: t("todo.aiReplaceNote"),
      async go(picked) {
        const inToday = todo.group === "today";
        for (const d of picked) {
          const added = await todos.add({
            title: d.title,
            day: inToday ? today() : (todo.day ?? ""),
          });
          await todos.move(added.id, inToday, todo.id);
        }
        end(true);
      },
      cancel: () => end(false),
    }),
  );
}
