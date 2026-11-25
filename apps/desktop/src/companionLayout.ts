import { t, type Key } from "./i18n.ts";
import { mountPhoneSettings } from "./phoneSettings.ts";
import { mountLoginStart } from "./loginStart.ts";
import { mountVoice } from "./voiceSettings.ts";
import { mountGuide } from "./onboarding.ts";
import { mountPermissionsSettings } from "./permissionsView.ts";
import type { CompanionSettings } from "../../shared/companion.ts";
import { todoPage } from "./todo/page.ts";
import { mountMemoryPage, type MemoryView } from "./memoryPage.ts";
import { mountPersonaSheet } from "./personaSheet.ts";
import { settingsGroup } from "./settingsGroup.ts";
interface LayoutContext {
  app: HTMLElement;
  page: HTMLElement;
  form: HTMLFormElement;
  field: (name: string) => HTMLInputElement;
  status: HTMLOutputElement;
  current: () => CompanionSettings;
  setup: { open(): void };
  reloadPersona: () => Promise<void>;
}
/** Status line in 伙伴大脑, and a note on the shared blocks while it is off. */
export function markCompanion(
  app: HTMLElement,
  s: CompanionSettings,
  show: () => void,
) {
  const line = document.querySelector<HTMLElement>(".brain-status");
  if (line) {
    line.dataset.state = s.enabled ? "on" : "off";
    line.textContent = s.enabled
      ? t("settings.brainOn", { model: s.model || t("settings.noModelYet") })
      : t("settings.brainOff");
  }
  // 记忆 is used only with the brain on: one quiet line by its title, not a
  // banner over it (plan/29). 待办 works without the brain.
  for (const id of ["memory"]) {
    const block = app.querySelector<HTMLElement>(`.block[data-for="${id}"]`);
    if (!block) continue;
    let note = block.querySelector<HTMLElement>(".brain-off");
    if (!note) {
      note = document.createElement("p");
      note.className = "brain-off";
      note.innerHTML = `<span>${t("settings.needsBrain")}</span><button type="button" class="link">${t("settings.turnOn")}</button>`;
      note.querySelector("button")!.onclick = () => {
        show();
        app.dispatchEvent(
          new CustomEvent("settings-reveal", { detail: "brain" }),
        );
      };
      block.querySelector(".block-head")?.append(note);
    }
    note.hidden = s.enabled;
  }
}

export function arrangeCompanion(ctx: LayoutContext) {
  const { app, page, form, field, status, current, setup } = ctx;
  form.id = "companion-form";
  const blockOf = (id: string) =>
    app.querySelector<HTMLElement>(`.block[data-for="${id}"]`) ?? app;
  const adopt = <T extends HTMLElement>(node: T) => {
    for (const c of node.querySelectorAll(
      "input,select,textarea,button,output",
    ))
      c.setAttribute("form", "companion-form");
    return node;
  };
  const labelOf = (name: string) =>
    field(name)?.closest("label, .switch-row") as HTMLElement | null;
  const group = (id: string, title: string, note = "", bare = false) =>
    settingsGroup(id, title, note, bare).section;
  /** Where a group's rows go (settingsGroup.ts); a bare group holds them itself. */
  const card = (g: HTMLElement) =>
    g.querySelector<HTMLElement>(":scope > .set-card") ?? g;
  const more = (summary: string) => {
    const d = document.createElement("details");
    d.className = "set-more";
    d.innerHTML = `<summary>${summary}</summary><div class="set-more-body"></div>`;
    return d;
  };

  // 宠物: this pet's personality, a row among its own settings that opens a
  // panel with the whole text (personaSheet.ts, plan/33).
  const personaField = labelOf("personality")!;
  personaField.firstChild!.textContent = "";
  mountPersonaSheet(app, {
    field: adopt(personaField),
    keys: adopt(
      page.querySelector<HTMLElement>("[data-persona-save]")!.parentElement!,
    ),
    output: adopt(page.querySelector<HTMLElement>("[data-persona-output]")!),
    onOpen: ctx.reloadPersona,
  });

  // 记得的事 · 资料库 · 提醒: shared by every pet.
  const head = (title: string, note: string) => {
    const h = document.createElement("header");
    h.className = "block-head";
    h.innerHTML = `<h2>${title}</h2><p class="silk">${note}</p>`;
    return h;
  };
  // 记忆: 关于你, 它记住的 and 资料库 on one page (plan/29).
  const library = document.createElement("section");
  library.className = "memory-library";
  const libraryHead = document.createElement("header");
  libraryHead.className = "memory-pane-head";
  libraryHead.innerHTML = `<h3>${t("library.title")}</h3><p>${t("library.note")}</p>`;
  library.append(
    libraryHead,
    adopt(page.querySelector<HTMLElement>(".companion-library")!),
  );
  const memoryBlock = blockOf("memory");
  memoryBlock.replaceChildren(head(t("memory.title"), t("memory.note")));
  const memory = mountMemoryPage(memoryBlock, {
    about: adopt(page.querySelector<HTMLElement>(".memory-about")!),
    remembered: adopt(page.querySelector<HTMLElement>(".memory-remembered")!),
    library,
  });
  app.addEventListener("memory-view", (e) =>
    memory.show((e as CustomEvent<MemoryView>).detail),
  );
  // 待办 (plan/27): the to-dos, with the brain's scheduled tasks folded
  // under them.
  const todo = todoPage(
    adopt(page.querySelector<HTMLElement>(".companion-reminders")!),
  );
  blockOf("reminders").replaceChildren(
    head(t("todo.title"), t("todo.note")),
    todo.page,
  );
  void todo.refresh();

  // 设置: groups in the order people set them once and forget.
  const brain = group("brain", t("settings.brain"));
  // The brain's state reads as one line under its switch, not a box above it.
  const statusLine = document.createElement("small");
  statusLine.className = "brain-status";
  const enabledRow = labelOf("enabled")!;
  const enabledLabel = enabledRow.querySelector("span")!;
  enabledLabel.classList.add("row-label");
  enabledLabel.append(statusLine);
  card(brain).append(
    enabledRow,
    page.querySelector(".model-current")!,
    status,
  );
  const abilities = group("abilities", t("settings.abilities"));
  labelOf("copyTwice")!.classList.add("set-sub");
  card(abilities).append(
    labelOf("translation")!,
    labelOf("copyTwice")!,
    labelOf("vision")!,
    labelOf("memory")!,
    labelOf("reminders")!,
  );
  // 快捷键: grouped by what they act on; on this page each row is named by
  // what it opens, with one line on what that is.
  const keyRow = (name: string, label: Key, note: Key) => {
    const row = labelOf(name)!;
    const text = document.createElement("span");
    text.className = "row-label";
    text.innerHTML = `<span class="row-name">${t(label)}</span><small class="row-desc">${t(note)}</small>`;
    if (row.firstChild?.nodeType === Node.TEXT_NODE) row.firstChild.replaceWith(text);
    else row.prepend(text);
    return row;
  };
  const shortcuts = group("shortcuts", t("settings.keysOpen"));
  card(shortcuts).append(
    keyRow("chatShortcut", "keys.chat", "keys.chatNote"),
    keyRow("panelShortcut", "keys.panel", "keys.panelNote"),
    keyRow("translationShortcut", "keys.translate", "keys.translateNote"),
    keyRow("clipboardShortcut", "keys.clipboard", "keys.clipboardNote"),
  );
  const selectionKeys = group("shortcuts-selection", t("settings.keysSelection"));
  card(selectionKeys).append(
    keyRow("visionShortcut", "keys.vision", "keys.visionNote"),
    keyRow("chatSnipShortcut", "keys.chatSnip", "keys.chatSnipNote"),
  );
  const voice = group("voice", t("settings.voice"), t("settings.voiceNote"));
  mountVoice(card(voice));
  // 用量: the receipt is its own paper, so it sits on the page, not in a card.
  const usage = group("usage", t("settings.usage"), "", true);
  card(usage).append(page.querySelector("[data-usage]")!);
  // 上网查资料: used often enough to sit open right under the brain.
  const online = group("online", t("online.title"), t("online.note"));
  card(online).append(
    page.querySelector('.companion-online[data-part="search"]')!,
  );
  // 进阶: set once and rarely touched — folded.
  const brainMore = group("brain-more", t("settings.brainMore"));
  const backups = more(t("settings.backupsMore"));
  backups.id = "set-backups";
  backups
    .querySelector(".set-more-body")!
    .append(page.querySelector('.companion-online[data-part="backups"]')!);
  const tools = more(t("settings.tools"));
  tools.id = "set-tools";
  const toolsNote = document.createElement("p");
  toolsNote.className = "set-note";
  toolsNote.textContent = t("settings.toolsNote");
  tools
    .querySelector(".set-more-body")!
    .append(toolsNote, page.querySelector(".companion-external")!);
  card(brainMore).append(backups, tools);

  const access = group(
    "access",
    t("settings.access"),
    t("settings.accessNote"),
  );
  const permissions = mountPermissionsSettings(
    card(access),
    access.querySelector<HTMLElement>(".set-note"),
  );
  const general = group("general", t("settings.general"));
  mountLoginStart(card(general));
  card(general).append(labelOf("language")!);
  // 上手引导: the three steps and 它会的事, always reachable here (plan/17).
  const guideGroup = group("guide", t("guide.title"));
  // 手机传文件 (plan/20): its own settings, kept by the host.
  const phone = group(
    "phone",
    t("phone.settings.title"),
    t("phone.settings.note"),
  );
  mountPhoneSettings(card(phone));

  type SettingsTab = "general" | "brain" | "abilities" | "shortcuts" | "perms";
  const tabDefs: readonly {
    id: SettingsTab;
    label: string;
    icon: string;
    groups: HTMLElement[];
  }[] = [
    {
      id: "general",
      label: t("settings.tab.general"),
      icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"/><path d="M12 2.5v2.5M12 19v2.5M5.3 5.3l1.8 1.8M16.9 16.9l1.8 1.8M2.5 12H5M19 12h2.5M5.3 18.7l1.8-1.8M16.9 7.1l1.8-1.8"/></svg>`,
      groups: [general, guideGroup],
    },
    {
      id: "brain",
      label: t("settings.tab.brain"),
      icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9.5 4a3.5 3.5 0 0 0-3.5 3.5c0 .7.2 1.3.5 1.8A3.5 3.5 0 0 0 5 12.2a3.5 3.5 0 0 0 2 3.2A3 3 0 0 0 10 19h2V4H9.5zM14.5 4A3.5 3.5 0 0 1 18 7.5c0 .7-.2 1.3-.5 1.8A3.5 3.5 0 0 1 19 12.2a3.5 3.5 0 0 1-2 3.2A3 3 0 0 1 14 19h-2V4h2.5z"/></svg>`,
      groups: [brain, online, brainMore, usage],
    },
    {
      id: "abilities",
      label: t("settings.tab.abilities"),
      icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="4" width="7.5" height="7" rx="2"/><rect x="13" y="4" width="7.5" height="7" rx="2"/><rect x="3.5" y="13" width="7.5" height="7" rx="2"/><rect x="13" y="13" width="7.5" height="7" rx="2"/></svg>`,
      groups: [abilities, voice, phone],
    },
    {
      id: "shortcuts",
      label: t("settings.tab.shortcuts"),
      icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="6" width="18" height="12" rx="2.5"/><path d="M7 10h.01M11 10h.01M15 10h.01M17 10h.01M8 14h8"/></svg>`,
      groups: [shortcuts, selectionKeys],
    },
    {
      id: "perms",
      label: t("settings.tab.perms"),
      icon: `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l7 3v5c0 4.5-3 8.2-7 10-4-1.8-7-5.5-7-10V6l7-3z"/></svg>`,
      groups: [access],
    },
  ];
  const sectionToTab: Record<string, SettingsTab> = {
    general: "general",
    guide: "general",
    look: "general",
    brain: "brain",
    usage: "brain",
    "brain-more": "brain",
    online: "brain",
    backups: "brain",
    tools: "brain",
    abilities: "abilities",
    phone: "abilities",
    voice: "abilities",
    shortcuts: "shortcuts",
    "shortcuts-selection": "shortcuts",
    access: "perms",
  };

  const tabsNav = document.createElement("nav");
  tabsNav.className = "set-tabs";
  tabsNav.setAttribute("role", "tablist");
  tabsNav.setAttribute("aria-label", t("studio.settings"));
  tabsNav.innerHTML = tabDefs
    .map(
      (tab, i) =>
        `<button type="button" role="tab" data-settings-tab="${tab.id}" aria-selected="${i === 0}">${tab.icon}<span>${tab.label}</span></button>`,
    )
    .join("");

  const panels = new Map<SettingsTab, HTMLElement>();
  for (const [i, tab] of tabDefs.entries()) {
    const panel = document.createElement("div");
    panel.className = "set-tab-panel";
    panel.dataset.settingsPanel = tab.id;
    panel.setAttribute("role", "tabpanel");
    panel.hidden = i !== 0;
    panel.append(...tab.groups);
    panels.set(tab.id, panel);
  }

  let activeTab: SettingsTab = "general";
  const selectTab = (tab: SettingsTab) => {
    activeTab = tab;
    for (const btn of tabsNav.querySelectorAll<HTMLButtonElement>(
      "[data-settings-tab]",
    )) {
      btn.setAttribute("aria-selected", String(btn.dataset.settingsTab === tab));
    }
    for (const [id, panel] of panels) panel.hidden = id !== tab;
    if (tab === "perms") void permissions.refresh();
  };
  const openSection = (sectionId: string, smooth = true) => {
    const tab = sectionToTab[sectionId];
    if (tab && tab !== activeTab) selectTab(tab);
    const target = document.getElementById("set-" + sectionId);
    if (target instanceof HTMLDetailsElement) target.open = true;
    const parentDetails = target?.closest("details");
    if (parentDetails) parentDetails.open = true;
    target?.scrollIntoView({
      behavior: smooth ? "smooth" : "auto",
      block: "start",
    });
  };

  tabsNav.onclick = (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-settings-tab]",
    );
    const id = btn?.dataset.settingsTab as SettingsTab | undefined;
    if (id) selectTab(id);
  };
  app.addEventListener("settings-reveal", (e) => {
    const id = (e as CustomEvent<string>).detail;
    if (id) openSection(id);
  });

  const look = blockOf("settings").querySelector<HTMLElement>(".skin-picker");
  form.querySelector("header")?.remove();
  form.replaceChildren(...panels.values());
  // 外观 goes before 上手引导 (the guide is for the first days only). The
  // picker may be built before or after this layout: it takes this slot.
  const lookSlot = document.createElement("div");
  lookSlot.dataset.settingsSlot = "look";
  lookSlot.hidden = true;
  guideGroup.before(lookSlot);
  if (look) {
    look.id = "set-look";
    lookSlot.replaceWith(look);
  }
  // 第一次使用: the guide (onboarding.ts) goes on the page first, so the tabs
  // prepended next stay on top and the guide sits right under them.
  const guide = mountGuide({
    page,
    group: card(guideGroup),
    current,
    setup,
  });
  page.prepend(tabsNav);
  return {
    ...guide,
    refreshPermissions: permissions.refresh,
    openSection,
  };
}
