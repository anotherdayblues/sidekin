import { t } from "./i18n.ts";
import { mountPhoneSettings } from "./phoneSettings.ts";
import { mountLoginStart } from "./loginStart.ts";
import { mountVoice } from "./voiceSettings.ts";
import { mountGuide } from "./onboarding.ts";
import type { CompanionSettings } from "../../shared/companion.ts";
import { todoPage } from "./todo/page.ts";
import { mountMemoryPage, type MemoryView } from "./memoryPage.ts";
import { mountPersonaSheet } from "./personaSheet.ts";
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
        document
          .getElementById("set-brain")
          ?.scrollIntoView({ behavior: "smooth" });
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
  const group = (id: string, title: string, note = "") => {
    const g = document.createElement("section");
    g.className = "set-group";
    g.id = "set-" + id;
    g.innerHTML = `<h3 class="set-title">${title}</h3>${note ? `<p class="set-note">${note}</p>` : ""}`;
    return g;
  };
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
  const statusLine = document.createElement("p");
  statusLine.className = "brain-status";
  brain.append(
    statusLine,
    labelOf("enabled")!,
    page.querySelector(".model-current")!,
    status,
  );
  const abilities = group("abilities", t("settings.abilities"));
  abilities.append(
    labelOf("chatShortcut")!,
    labelOf("panelShortcut")!,
    labelOf("clipboardShortcut")!,
    labelOf("translation")!,
    labelOf("copyTwice")!,
    labelOf("translationTarget")!,
    labelOf("translationShortcut")!,
    labelOf("vision")!,
    labelOf("visionShortcut")!,
    labelOf("memory")!,
    labelOf("reminders")!,
  );
  const voice = group("voice", t("settings.voice"), t("settings.voiceNote"));
  mountVoice(voice);
  const net = group("online", t("settings.online"));
  net.append(page.querySelector(".companion-online")!);
  const usage = group("usage", t("settings.usage"));
  usage.append(page.querySelector("[data-usage]")!);
  const tools = group("tools", t("settings.tools"), t("settings.toolsNote"));
  tools.append(page.querySelector(".companion-external")!);
  const access = group(
    "access",
    t("settings.access"),
    t("settings.accessNote"),
  );
  access.append(
    page.querySelector("[data-access]")!,
    page.querySelector("[data-screen]")!,
  );
  const general = group("general", t("settings.general"));
  mountLoginStart(general);
  general.append(labelOf("language")!);
  // 上手引导: the three steps and 它会的事, always reachable here (plan/17).
  const guideGroup = group("guide", t("guide.title"));
  // 手机传文件 (plan/20): its own settings, kept by the host.
  const phone = group(
    "phone",
    t("phone.settings.title"),
    t("phone.settings.note"),
  );
  mountPhoneSettings(phone);
  const groups = [
    general,
    guideGroup,
    brain,
    abilities,
    phone,
    voice,
    net,
    usage,
    tools,
    access,
  ];
  const toc = document.createElement("nav");
  toc.className = "set-toc";
  const look = blockOf("settings").querySelector<HTMLElement>(".skin-picker");
  toc.innerHTML = [
    ...groups.map((g) => [g.id, g.querySelector("h3")!.textContent]),
    ...(look ? [["set-look", t("settings.look")]] : []),
  ]
    .map(([id, t]) => `<a href="#${id}">${t}</a>`)
    .join("");
  toc.onclick = (e) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    e.preventDefault();
    document
      .getElementById(a.getAttribute("href")!.slice(1))
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
  };
  form.querySelector("header")?.remove();
  form.replaceChildren(...groups);
  if (look) {
    look.id = "set-look";
    form.append(look);
  }
  page.prepend(toc);

  // 第一次使用: the three-step guide (onboarding.ts).
  return mountGuide({ page, group: guideGroup, current, setup });
}
