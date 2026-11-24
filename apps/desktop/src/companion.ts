import { t, named } from "./i18n.ts";
import { arrangeCompanion, markCompanion } from "./companionLayout.ts";
import { modelSetup } from "./modelSetup.ts";
import { onlineSettings } from "./online.ts";
import { documentsPage } from "./documents.ts";
import { remindersPage } from "./reminders.ts";
import { externalPanel } from "./external.ts";
import { notebooks } from "./notebooks.ts";
import {
  recordShortcut,
  showShortcut,
  shortcutValue,
} from "./shortcutRecorder.ts";
import { comboBox } from "./combo.ts";
import "./styles/shortcut-recorder.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import { errorText } from "./errorText.ts";
import {
  presets,
  defaults,
  type CompanionSettings,
  type Service,
} from "../../shared/companion.ts";
import "./companion.css";
export { type CompanionSettings };
let preview: CompanionSettings = { ...defaults };
export async function getSettings(): Promise<CompanionSettings> {
  return native ? invoke("companion_settings") : { ...preview };
}
export function companionPage(app: HTMLElement) {
  const page = document.createElement("section");
  page.className = "companion-page";
  page.hidden = true;
  // Lives in the 设置 block of the five-block shell.
  const host =
    app.querySelector<HTMLElement>('.block[data-for="settings"]') ?? app;
  page.innerHTML = `<form><header><h2>${t("settings.companion")}</h2><button type="button" data-close>${t("settings.backToPet")}</button></header>
  <label>${t("settings.language")}<select name="language"><option value="system">${t("settings.followSystem")}</option><option value="zh">中文</option><option value="en">English</option></select></label>
  <div class="switch-row"><span>${t("settings.enable")}</span><input type="checkbox" name="enabled" role="switch" aria-label="${t("settings.enable")}" class="slide-switch"></div>
  <div class="model-current"><span data-current-model></span><button type="button" data-configure>${t("settings.configureModel")}</button></div>
  <div class="switch-row"><span>${t("settings.translation")}</span><input type="checkbox" name="translation" role="switch" aria-label="${t("settings.translation")}" class="slide-switch"></div>
  <div data-access hidden>${t("settings.accessNeeded")}<button type="button" data-preferences>${t("settings.openSystemSettings")}</button></div><div class="switch-row"><span>${t("settings.memory")}</span><input name="memory" type="checkbox" role="switch" aria-label="${t("settings.memory")}" class="slide-switch"></div><div class="switch-row"><span>${t("settings.reminders")}</span><input name="reminders" type="checkbox" role="switch" aria-label="${t("settings.reminders")}" class="slide-switch"></div><div class="switch-row"><span>${t("settings.vision")}</span><input type="checkbox" name="vision" role="switch" aria-label="${t("settings.vision")}" class="slide-switch"></div><label>${t("settings.visionShortcut")}<input name="visionShortcut"></label><div data-screen hidden>${t("settings.screenOff")}<button type="button" data-screen-prefs>${t("settings.openSystemSettings")}</button></div><div class="switch-row" data-copy-twice><span>${t("settings.copyTwice")}</span><input name="copyTwice" type="checkbox" role="switch" aria-label="${t("settings.copyTwice")}" class="slide-switch"></div><label>${t("settings.translationTarget")}<input name="translationTarget" list="languages" maxlength="60" placeholder="${t("settings.auto")}"><datalist id="languages"><option value="${t("settings.auto")}"><option value="${t("lang.chinese")}"><option value="${t("lang.english")}"><option value="${t("lang.japanese")}"><option value="${t("lang.french")}"></datalist></label><label>${t("settings.translationShortcut")}<input name="translationShortcut"></label>
  <label>${t("clip.shortcut")}<input name="clipboardShortcut"></label><label>${t("settings.chatShortcut")}<input name="chatShortcut"></label><label>${t("settings.panelShortcut")}<input name="panelShortcut"></label><label>${t("settings.personality")}<textarea name="personality"></textarea></label><div class="companion-buttons"><button type="button" data-persona-save>${t("settings.personaSave")}</button><button type="button" data-persona-reset>${t("settings.personaReset")}</button></div><output data-persona-output></output>
  <output role="status"></output></form>`;
  host.append(page);
  const form = page.querySelector("form")!;
  const online = onlineSettings(form);
  const refreshDocs = documentsPage(form);
  let personaId = "",
    defaultPersona = "",
    personaLoadSeq = 0;
  async function persona(action: string) {
    const out = document.querySelector<HTMLElement>("[data-persona-output]")!;
    try {
      if (action === "load") {
        if (native) {
          const seq = ++personaLoadSeq;
          const p = await invoke<{
            text: string;
            petId: string;
            defaultText: string;
          }>("get_persona");
          if (seq !== personaLoadSeq) return;
          personaId = p.petId;
          defaultPersona = p.defaultText;
          field("personality").value = p.text;
          out.textContent = "";
          // The one-line summary on the pet page follows (companionLayout.ts).
          field("personality").dispatchEvent(new Event("input"));
        }
        return;
      }
      const text = field("personality").value;
      await invoke("save_persona", {
        petId: personaId,
        text: action === "reset" ? null : text,
      });
      if (action === "reset") {
        field("personality").value = defaultPersona;
        field("personality").dispatchEvent(new Event("input"));
      }
      out.textContent = t("settings.personaSaved");
    } catch (e) {
      out.textContent = String(e);
    }
  }
  for (const action of ["save", "reset"])
    page.querySelector<HTMLElement>("[data-persona-" + action + "]")!.onclick =
      () => void persona(action);
  const refreshExternal = externalPanel(form);
  const books = notebooks(form);
  const refreshBooks = books.refresh;
  const refreshReminders = remindersPage(form);
  const field = (name: string) =>
    form.elements.namedItem(name) as HTMLInputElement;
  // A shortcut that cannot come back (taken by another app meanwhile) is
  // said in the status line rather than lost silently.
  const pauseShortcuts = (paused: boolean) => {
    if (native)
      void invoke("pause_shortcuts", { paused }).catch((e) => {
        if (!paused) status.textContent = String(e);
      });
  };
  for (const name of [
    "chatShortcut",
    "panelShortcut",
    "visionShortcut",
    "translationShortcut",
    "clipboardShortcut",
  ])
    recordShortcut(field(name), pauseShortcuts);
  field("chatShortcut").dataset.optional = "true";
  field("chatShortcut").placeholder = t("keys.unset");
  comboBox(field("translationTarget"));
  // Name the copy key the way this keyboard shows it.
  const copyLabel = form.querySelector("[data-copy-twice] span");
  if (copyLabel)
    copyLabel.textContent = /Mac/.test(
      navigator.platform || navigator.userAgent,
    )
      ? t("settings.copyTwiceKeys", { keys: "⌘C" })
      : t("settings.copyTwiceKeys", { keys: "Ctrl+C" });
  const status = page.querySelector<HTMLOutputElement>(
    'output[role="status"]',
  )!;
  let saved: CompanionSettings = { ...defaults };
  let refreshGuide = () => {};
  const setup = modelSetup(
    app,
    () => saved,
    (s) => {
      if (!native) preview = s;
      fill(s);
      refreshGuide();
    },
  );
  page.querySelector<HTMLElement>("[data-configure]")!.onclick = () =>
    setup.open();
  function readControls(): Partial<CompanionSettings> {
    return {
      enabled: field("enabled").checked,
      reminders: field("reminders").checked,
      memory: field("memory").checked,
      vision: field("vision").checked,
      visionShortcut: shortcutValue(field("visionShortcut")),
      translation: field("translation").checked,
      clipboardShortcut: shortcutValue(field("clipboardShortcut")),
      copyTwice: field("copyTwice").checked,
      translationShortcut: shortcutValue(field("translationShortcut")),
      translationTarget: ["", t("settings.auto"), "auto"].includes(
        field("translationTarget").value.trim(),
      )
        ? "auto"
        : field("translationTarget").value.trim(),
      chatShortcut: shortcutValue(field("chatShortcut")),
      panelShortcut: shortcutValue(field("panelShortcut")),
      language: field("language").value as CompanionSettings["language"],
    };
  }
  function fill(s: CompanionSettings) {
    saved = s;
    markCompanion(app, s, show);
    online.fill(s);
    for (const [k, v] of Object.entries(s)) {
      const f = field(k);
      if (!f) continue;
      if (typeof v === "boolean") f.checked = v;
      else if ("shortcut" in f.dataset) showShortcut(f, String(v));
      else f.value = String(v);
    }
    if (s.translationTarget === "auto")
      field("translationTarget").value = t("settings.auto");
    page.querySelector<HTMLElement>("[data-current-model]")!.textContent =
      s.modelVerified
        ? t("settings.currentModel", {
            service: named("service." + s.service, presets[s.service][0]),
            model: s.model,
            tools: t(
              s.toolCheck?.baseUrl === s.baseUrl &&
                s.toolCheck?.model === s.model &&
                s.toolCheck?.protocol === s.protocol &&
                s.toolCheck.status === "yes"
                ? "settings.toolsYes"
                : s.toolCheck?.baseUrl === s.baseUrl &&
                    s.toolCheck?.model === s.model &&
                    s.toolCheck?.protocol === s.protocol &&
                    s.toolCheck.status === "no"
                  ? "settings.toolsNo"
                  : "settings.toolsUnknown",
            ),
          })
        : t("settings.noModel");
    showOnboard();
  }
  let saves = Promise.resolve();
  let inputRevision = 0;
  form.addEventListener("input", (e) => {
    const target = e.target as HTMLInputElement;
    if (target.name && Object.hasOwn(readControls(), target.name))
      inputRevision++;
  });
  function save(
    withOnline = false,
    controls = readControls(),
    revision = inputRevision,
  ) {
    if (!form.reportValidity()) return Promise.resolve();
    const patch = withOnline ? online.read() : controls;
    const secrets = withOnline ? online.secrets() : {};
    if (withOnline) online.setBusy(true);
    const run = saves.then(async () => {
      status.textContent = t("settings.saving");
      if (withOnline)
        page.querySelector<HTMLOutputElement>(
          "[data-online-status]",
        )!.textContent = t("settings.verifying");
      try {
        const latest = await getSettings();
        const s = { ...latest, ...patch };
        const next = native
          ? await invoke<CompanionSettings>("save_companion", {
              settings: s,
              newKey: null,
              ...secrets,
            })
          : s;
        saved = next ?? s;
        if (!native) preview = saved;
        if (withOnline) online.fill(saved);
        if (!withOnline && revision === inputRevision) {
          for (const key of Object.keys(controls)) {
            const input = field(key),
              value = saved[key as keyof CompanionSettings];
            if (typeof value === "boolean") input.checked = value;
            else if ("shortcut" in input.dataset)
              showShortcut(input, String(value));
            else
              input.value =
                value === "auto" && key === "translationTarget"
                  ? t("settings.auto")
                  : String(value);
          }
        }
        markCompanion(app, saved, show);
        status.textContent = t("settings.saved");
        if (withOnline)
          page.querySelector<HTMLOutputElement>(
            "[data-online-status]",
          )!.textContent = t("settings.groupSaved");
      } catch (e) {
        if (!withOnline && revision === inputRevision) {
          for (const key of Object.keys(controls)) {
            const input = field(key),
              value = saved[key as keyof CompanionSettings];
            if (typeof value === "boolean") input.checked = value;
            else if ("shortcut" in input.dataset)
              showShortcut(input, String(value));
            else
              input.value =
                value === "auto" && key === "translationTarget"
                  ? t("settings.auto")
                  : String(value);
          }
        }
        const message = String(e).replace(/^Error:\s*/, "");
        const match = message.match(/^(backup:\d+|search):(.+)$/);
        status.textContent = match
          ? t("settings.partFailed", {
              part:
                match[1] === "search"
                  ? t("settings.searchService")
                  : t("settings.backupN", { n: match[1].split(":")[1] }),
              why:
                match[2] === "missingKey"
                  ? t("settings.enterKey")
                  : (errorText[match[2]] ?? match[2]),
            })
          : (errorText[message] ?? message);
        if (withOnline)
          page.querySelector<HTMLOutputElement>(
            "[data-online-status]",
          )!.textContent = status.textContent;
      } finally {
        if (withOnline) online.setBusy(false);
      }
    });
    saves = run.catch(() => {});
    return run;
  }
  form.onsubmit = (e) => {
    e.preventDefault();
    void save();
  };
  page.querySelector<HTMLElement>("[data-close]")!.onclick = () => {
    page.hidden = true;
  };
  page.querySelector<HTMLElement>("[data-preferences]")!.onclick = () =>
    void invoke("selection_preferences");
  page.querySelector<HTMLElement>("[data-screen-prefs]")!.onclick = () =>
    void invoke("screen_preferences");
  async function open(fixture?: string) {
    const current = await getSettings();
    // Only the browser preview accepts fixtures; production always reads persisted settings.
    if (!native && fixture) {
      current.enabled = fixture !== "off";
      if (["online", "usage"].includes(fixture)) {
        current.dailyLimit = 20000;
        current.search = { provider: "tavily", baseUrl: "" };
        current.fallbacks = [
          {
            service: "custom",
            baseUrl: "http://127.0.0.1:1234/v1",
            model: "本地备用模型",
            canSee: false,
          },
        ];
      }
      if (fixture === "custom") {
        current.service = "custom";
        current.model = "my-model";
        current.baseUrl = "http://localhost:1234/v1";
        current.canSee = true;
      }
    }
    fill(current);
    page.hidden = false;
    await Promise.all([
      refreshBooks(),
      refreshReminders(),
      refreshExternal(),
      refreshDocs(),
      online.refresh(),
      persona("load"),
    ]);
    const previewSections: Record<string, string> = {
      online: ".companion-online",
      usage: "[data-usage]",
      persona: "[name=personality]",
      library: ".companion-library",
      external: ".companion-external",
    };
    if (!native && fixture && previewSections[fixture])
      page.querySelector(previewSections[fixture])?.scrollIntoView();
    if (fixture === "reminders")
      page.querySelector(".companion-reminders")?.scrollIntoView();
    if (fixture === "memory")
      page.querySelector(".companion-notebooks")?.scrollIntoView();
    page.querySelector<HTMLElement>("[data-screen]")!.hidden =
      !native || !saved.vision || (await invoke<boolean>("screen_access"));
    page.querySelector<HTMLElement>("[data-access]")!.hidden =
      !native ||
      !saved.translation ||
      (await invoke<boolean>("selection_access"));
    status.textContent =
      !native && fixture
        ? ((
            {
              testing: "正在测试连接…",
              success: "已连接 · 首字 35 ms · 能看图",
              error: errorText.auth,
            } as Record<string, string>
          )[fixture] ?? "")
        : "";
    if (!native && fixture === "permission")
      page.querySelector<HTMLElement>("[data-access]")!.hidden = false;
  }
  const show = () =>
    app.dispatchEvent(new CustomEvent("show-block", { detail: "settings" }));
  if (native)
    void listen<string>("settings-section", async (e) => {
      await open();
      show();
      document.getElementById("set-" + e.payload)?.scrollIntoView();
    });
  if (native)
    void listen<boolean>("companion-open", async () => {
      // From the bubble: errors land on 伙伴大脑.
      await open();
      show();
      document
        .getElementById("set-brain")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  if (native)
    void listen<any>("brain-event", (e) => {
      if (e.payload.method === "usage.changed" && !page.hidden)
        void online.refresh();
      if (e.payload.method === "crash") status.textContent = errorText.crash;
    });
  let showOnboard = () => {};
  const guide = arrangeCompanion({
    app,
    page,
    form,
    field,
    status,
    current: () => saved,
    setup,
    reloadPersona: () => persona("load"),
  });
  app.addEventListener("pet-changed", () => void persona("load"));
  refreshGuide = guide.refresh;
  showOnboard = guide.show;
  // Screenshot scripts open a step of the guide directly.
  if (!native) Object.assign(window, { __guide: guide });
  // The first launch opens 设置 on the guide (tips.rs).
  if (native)
    void listen("guide-open", async () => {
      await open();
      show();
      guide.open();
    });
  // Changes take effect at once; only the Key waits for 测试连接.
  let pending: ReturnType<typeof setTimeout> | undefined;
  const quiet = new Set(["key"]);
  form.addEventListener("change", (e) => {
    const t = e.target as HTMLInputElement;
    if (
      quiet.has(t.name) ||
      t.type === "password" ||
      t.name === "personality" ||
      t.closest(".companion-online")
    )
      return;
    clearTimeout(pending);
    const controls = readControls(),
      revision = ++inputRevision;
    pending = setTimeout(() => void save(false, controls, revision), 250);
  });
  form.addEventListener("save-online", () => void save(true));

  // Preload settings quietly in the background; first-launch guide opening
  // is driven by the host (tips::first_launch -> "guide-open") so the hidden
  // startup window never marks guideShown before the user actually sees it.
  void open();
  return open;
}
