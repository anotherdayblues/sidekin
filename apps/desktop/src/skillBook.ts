// 它会的事 (plan/17 3.3): a book of what the pet can do, opened from the
// pet page's side panel, the pet's right-click menu, the guide and a tip's
// 看看怎么用. What the user has tried lights up; a card plays its demo.
import { invoke } from "@tauri-apps/api/core";
import { defaults, type CompanionSettings } from "../../shared/companion.ts";
import { native } from "./bridge.ts";
import { playDemo } from "./demos/index.ts";
import { t, type Key } from "./i18n.ts";
import { shortcutLabel } from "./shortcutRecorder.ts";
import "./styles/skill-book.css";
import {
  DEMO_FEATURES,
  FEATURES,
  GROUPS,
  WITH_TIPS,
  switchedOn,
  tipsLearned,
  tipsState,
  type TipsRecord,
} from "./tips.ts";

const settings = async (): Promise<CompanionSettings> =>
  native ? invoke("companion_settings") : defaults;

/** Where a feature without a demo is set up. */
const PLACE: Record<string, { block: string; section?: string; label: Key }> = {
  library: { block: "library", label: "skills.goLibrary" },
  web: { block: "settings", section: "set-online", label: "skills.goSearch" },
  todo: { block: "reminders", label: "skills.goTodo" },
};

export function mountSkillBook(app: HTMLElement) {
  // The entry: the ? at the foot of the left column, always there.
  const entry = app.querySelector<HTMLButtonElement>("#skills-key")!;

  const book = document.createElement("dialog");
  book.className = "skill-book";
  app.append(book);
  let record: TipsRecord | null = null,
    saved: CompanionSettings = defaults,
    demo: { destroy(): void } | null = null;

  // Learned: read about here, or used for real (plan/17 3.3).
  const learned = (id: string) =>
    Boolean(
      record?.used.includes(id) ||
      record?.learned.includes(id) ||
      (id === "web" && saved.search),
    );
  const allLearned = () => FEATURES.every(learned);
  const how = (id: string) =>
    id === "chat-shortcut" && !saved.chatShortcut
      ? t("skills.chat-shortcut.howClick")
      : t(`skills.${id}.how` as Key, {
          key: shortcutLabel(saved.chatShortcut),
          vision: shortcutLabel(saved.visionShortcut),
          panel: shortcutLabel(saved.panelShortcut),
          clipboard: shortcutLabel(saved.clipboardShortcut),
          copy:
            document.documentElement.dataset.platform === "mac"
              ? "⌘C"
              : "Ctrl+C",
          // The menu item each card names.
          item:
            id === "focus"
              ? t("focus.start")
              : id === "todo"
                ? t("todo.menuOpen")
                : id === "phone"
                  ? t("phone.menu.start")
                  : t("menu.translateSelection"),
        });
  const count = () =>
    t("skills.count", {
      n: FEATURES.filter(learned).length,
      total: FEATURES.length,
    });

  async function refresh() {
    [record, saved] = await Promise.all([tipsState(), settings()]);
    entry.title = `${t("skills.title")} · ${t("skills.exploreHint")} · ${count()}`;
    // A dot while some card is still unread.
    entry.toggleAttribute("data-new", !allLearned());
  }

  const stop = () => {
    demo?.destroy();
    demo = null;
  };
  // What the book shows now: the list, or one card. The list shows one
  // group at a time, picked from the tabs on top (plan/32).
  let showing = "";
  let group = "";

  const firstNew = () =>
    (GROUPS.find(([, ids]) =>
      ids.some((id) => !learned(id) && switchedOn(saved, id)),
    ) ?? GROUPS[0])[0];
  const list = () => {
    showing = "";
    stop();
    group ||= firstNew();
    book.innerHTML = `<header><h2>${t("skills.title")}</h2><small>${count()}</small><button type="button" data-close aria-label="${t("common.close")}"></button></header>
      <p class="skill-note">${t("skills.note")}</p>
      <nav class="skill-tabs" role="tablist">${GROUPS.map(
        ([g, ids]) =>
          `<button type="button" role="tab" data-group="${g}" aria-selected="${g === group}"${ids.some((id) => !learned(id) && switchedOn(saved, id)) ? " data-new" : ""}>${t(`skills.group.${g}` as Key)}</button>`,
      ).join("")}</nav>
      <ul class="skill-cards" role="tabpanel">${(
        GROUPS.find(([g]) => g === group)?.[1] ?? []
      )
        .map(
          (
            id,
          ) => `<li><button type="button" data-skill="${id}" data-learned="${learned(id)}" data-off="${!switchedOn(saved, id)}">
          <b>${t(`skills.${id}.name` as Key)}</b><span>${how(id)}</span>
          ${!switchedOn(saved, id) ? `<small>${t("skills.off")}</small>` : learned(id) ? "" : `<small>${t("skills.new")}</small>`}</button></li>`,
        )
        .join("")}</ul>`;
  };
  const card = (id: string) => {
    showing = id;
    stop();
    // Reading the card is learning it.
    if (!learned(id)) {
      tipsLearned(id);
      record?.learned.push(id);
      void refresh();
    }
    const off = !switchedOn(saved, id);
    const place = off
      ? {
          block: "settings",
          section: "set-abilities",
          label: "skills.turnOn" as Key,
        }
      : PLACE[id];
    book.innerHTML = `<header><button type="button" data-back aria-label="${t("common.back")}"></button><h2>${t(`skills.${id}.name` as Key)}</h2>${DEMO_FEATURES.includes(id) ? "" : `<button type="button" data-close aria-label="${t("common.close")}"></button>`}</header>
      <p class="skill-note">${how(id)}</p>
      ${
        WITH_TIPS.includes(id)
          ? `<div class="skill-tips"><b>${t("skills.tipsTitle")}</b><ul>${t(
              `skills.${id}.tips` as Key,
            )
              .split("\n")
              .map((line) => `<li>${line}</li>`)
              .join("")}</ul></div>`
          : ""
      }
      ${off ? `<p class="skill-off">${t("skills.offNote")}</p>` : ""}
      ${DEMO_FEATURES.includes(id) ? `<div class="skill-demo" data-demo-host></div>` : ""}
      ${place ? `<button type="button" class="primary" data-go="${id}" data-section="${place.section ?? ""}" data-block="${place.block}">${t(place.label)}</button>` : ""}`;
    const host = book.querySelector<HTMLElement>("[data-demo-host]");
    if (host)
      void playDemo(host, id).then((d) => {
        if (host.isConnected) demo = d;
        else d.destroy();
      });
  };

  async function open(feature?: string) {
    await refresh();
    group = feature
      ? (GROUPS.find(([, ids]) => (ids as string[]).includes(feature))?.[0] ??
        firstNew())
      : firstNew();
    if (feature && (FEATURES as readonly string[]).includes(feature))
      card(feature);
    else list();
    if (!book.open) book.showModal();
  }

  book.addEventListener("close", stop);
  book.onclick = (e) => {
    const target = e.target as HTMLElement;
    // A click on the backdrop lands on the dialog itself.
    if (target === book || target.closest("[data-close]")) return book.close();
    if (target.closest("[data-back]")) return list();
    const tab = target.closest<HTMLElement>(".skill-tabs [data-group]");
    if (tab) {
      group = tab.dataset.group!;
      return list();
    }
    const skill = target.closest<HTMLElement>("[data-skill]")?.dataset.skill;
    if (skill) return card(skill);
    const go = target.closest<HTMLElement>("[data-go]");
    if (go) {
      book.close();
      app.dispatchEvent(
        new CustomEvent("show-block", { detail: go.dataset.block }),
      );
      const section = go.dataset.section;
      if (section)
        document.getElementById(section)?.scrollIntoView({ block: "start" });
    }
  };
  entry.onclick = () => void open();
  // From the guide (a DOM event) and from the pet and its tips (Tauri).
  document.addEventListener("skill-book-open", () => void open());
  if (native)
    void import("@tauri-apps/api/event").then(({ listen }) => {
      void listen<string | null>(
        "skill-book-open",
        (e) => void open(e.payload ?? undefined),
      );
      void listen("tips-changed", () => void refresh());
      // A changed shortcut shows at once, in the list and on a card.
      void listen("companion-settings", async () => {
        await refresh();
        if (book.open && !showing) list();
      });
    });
  void refresh();
  return { open };
}
