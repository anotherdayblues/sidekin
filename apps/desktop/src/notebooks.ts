// 记忆 (plan/29): what you wrote about yourself (关于你), and what the pet
// noted down itself (它记住的), one list with what it learned about you
// (你的情况) and how it does things (做事的经验), as the memory pages of
// ChatGPT, Pi and nanoMuse keep them: one line each, editable, removable,
// and a line to add one yourself. Both are shared by every pet.
import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import { profileEditor, type UserProfile } from "./userProfile.ts";
interface Notebook {
  entries: string[];
  used: number;
  limit: number;
}
interface View {
  petId: string;
  profile?: UserProfile;
  migration?: { overflow: number; backup: string };
  user: Notebook;
  notes: Notebook;
}
type Book = "user" | "notes";
const BOOK_LABEL: Record<Book, "memory.yourSituation" | "memory.notes"> = {
  user: "memory.yourSituation",
  notes: "memory.notes",
};

export function notebooks(root: HTMLElement) {
  const about = document.createElement("section");
  about.className = "memory-about";
  const remembered = document.createElement("section");
  remembered.className = "memory-remembered";
  root.append(about, remembered);
  let revision = 0;
  let filter: Book | "all" = "all";
  const el = <K extends keyof HTMLElementTagNameMap>(
    tag: K,
    cls = "",
    text = "",
  ) => {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text) n.textContent = text;
    return n;
  };
  async function refresh() {
    const seq = ++revision;
    let data: View;
    try {
      data = native
        ? await invoke("memory_view")
        : {
            petId: "fixture",
            profile: {
              text: "我叫小栗，在做一个叫随伴的桌面宠物项目。\n回答先说结论，尽量简短。",
              used: 39,
              limit: 2000,
            },
            user: {
              entries: ["喜欢乌龙茶。", "周报每周五下午交。"],
              used: 15,
              limit: 2000,
            },
            notes: {
              entries: ["翻译技术文档时保留英文术语，用户更容易对上原文。"],
              used: 24,
              limit: 2200,
            },
          };
    } catch (e) {
      remembered.textContent = t("memory.readFailed", { error: String(e) });
      return;
    }
    if (seq !== revision) return;

    // ---------- 关于你 ----------
    about.replaceChildren();
    profileEditor(
      about,
      data.petId,
      data.profile ?? { text: "", used: 0, limit: 2000 },
      refresh,
    );

    // ---------- 它记住的 ----------
    remembered.replaceChildren();
    const head = el("header", "memory-pane-head");
    head.append(
      el("h3", "", t("memory.itRemembers")),
      el("p", "", t("memory.itRemembersNote")),
    );
    remembered.append(head);
    if (data.migration?.overflow)
      remembered.append(
        el(
          "p",
          "memo-note",
          t("memory.overflow", {
            n: data.migration.overflow,
            path: `brain/${data.migration.backup}/overflow.json`,
          }),
        ),
      );
    // All, or one kind: chips with their counts.
    const chips = el("div", "memory-chips");
    chips.setAttribute("role", "group");
    for (const id of ["all", "user", "notes"] as const) {
      const n =
        id === "all"
          ? data.user.entries.length + data.notes.entries.length
          : data[id].entries.length;
      const b = el("button", "memory-chip");
      b.type = "button";
      b.dataset.filter = id;
      b.setAttribute("aria-pressed", String(filter === id));
      b.append(
        id === "all" ? t("memory.all") : t(BOOK_LABEL[id]),
        el("span", "", String(n)),
      );
      b.onclick = () => {
        filter = id;
        void refresh();
      };
      chips.append(b);
    }
    remembered.append(chips);
    for (const book of ["user", "notes"] as const)
      if (
        (filter === "all" || filter === book) &&
        data[book].used >= data[book].limit
      )
        remembered.append(
          el("p", "memo-note", t("memory.full", { book: t(BOOK_LABEL[book]) })),
        );

    const list = el("ul", "memory-list");
    remembered.append(list);
    const rows = (["user", "notes"] as const)
      .filter((book) => filter === "all" || filter === book)
      .flatMap((book) => data[book].entries.map((entry) => ({ book, entry })));
    if (!rows.length) list.append(el("li", "memo-empty", t("memory.empty")));
    for (const { book, entry } of rows) {
      const line = el("li", "memory-entry");
      line.dataset.book = book;
      list.append(line);
      const text = el("span", "memo-text", entry);
      const kind = el("small", "memory-kind", t(BOOK_LABEL[book]));
      const body = el("div", "memory-entry-body");
      body.append(text, kind);
      const acts = el("span", "memo-acts");
      line.append(body, acts);
      const button = (label: string, fn: () => void) => {
        const b = el("button", "link", label);
        b.type = "button";
        b.onclick = fn;
        acts.append(b);
      };
      const apply = async (action: "patch" | "remove", content?: string) => {
        try {
          await edit([{ book, action, old_text: entry, exact: true, content }]);
        } catch (e) {
          line.append(el("small", "memo-error", String(e)));
        }
      };
      button(t("common.edit"), () => {
        line.dataset.editing = "true";
        const input = el("textarea") as HTMLTextAreaElement;
        input.value = entry;
        text.replaceWith(input);
        input.focus();
        acts.replaceChildren();
        button(t("common.save"), () => void apply("patch", input.value));
        button(t("common.cancel"), () => void refresh());
      });
      button(t("common.delete"), () => {
        line.dataset.editing = "true";
        acts.replaceChildren();
        button(t("common.confirmDelete"), () => void apply("remove"));
        button(t("common.cancel"), () => void refresh());
      });
    }
    // One more, written by you: into the kind shown, else 你的情况.
    const add = el("form", "memory-add");
    const input = el("input") as HTMLInputElement;
    input.placeholder = t("memory.addOne");
    input.setAttribute("aria-label", t("memory.addOne"));
    input.maxLength = 400;
    add.append(input);
    add.onsubmit = async (e) => {
      e.preventDefault();
      const content = input.value.trim();
      if (!content) return;
      try {
        await edit([
          {
            book: filter === "notes" ? "notes" : "user",
            action: "add",
            content,
          },
        ]);
      } catch (err) {
        add.append(el("small", "memo-error", String(err)));
      }
    };
    remembered.append(add);

    async function edit(operations: object[]) {
      if (native)
        await invoke("memory_edit", { petId: data.petId, operations });
      await refresh();
    }
  }
  if (native)
    void listen("memory-changed", () => {
      if (
        root.isConnected &&
        !root.querySelector("[data-editing]") &&
        !document.activeElement?.closest(".memory-add")
      )
        void refresh();
    });
  return {
    refresh,
    /** The two parts, for the 记忆 page to place. */
    about,
    remembered,
  };
}
