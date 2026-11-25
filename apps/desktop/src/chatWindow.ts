// The chat side panel: opens tall on the right of the screen; drag the
// header to put it anywhere and it stays there. It slides in when opened
// and out when put away (button, Esc or the panel shortcut).
import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import "./speech.css";
import { watchSpeech } from "./speechWatch.ts";
import { listen } from "@tauri-apps/api/event";
import * as api from "./bridge.ts";
import { native } from "./bridge.ts";
import { petFace } from "./petFace.ts";
import { applySkin, watchWindowAppearance, type Skin } from "./skin.ts";
import { mountChatView } from "./chatView.ts";
import { glyphs } from "./icons.ts";
import { watchCaret } from "./caretLook.ts";
import { translationLog, type TranslationRecord } from "./translationLog.ts";

export async function mountChatWindow(app: HTMLElement) {
  document.documentElement.classList.add("chat-window-host");
  document.body.classList.add("chat-window-host");
  const key = (attr: string, label: string, glyph: string, extra = "") =>
    `<button type="button" ${attr} aria-label="${label}" title="${label}" ${extra}>${glyph}</button>`;
  app.innerHTML = `<div class="chat-window" data-entering><header data-tauri-drag-region title="${t("chat.drag")}"><span class="chat-name" data-tauri-drag-region><img class="chat-face" alt="" data-tauri-drag-region><span data-tauri-drag-region>${t("app.name")}</span></span>${key("data-topics", t("chat.topics"), glyphs.topics, 'aria-pressed="false"')}${key("data-new", t("chat.newTopic"), glyphs.compose)}${key("data-pin", t("chat.pin"), glyphs.pin, 'aria-pressed="true"')}${key("data-collapse", t("chat.collapse"), glyphs.collapse)}</header><div class="chat-body"></div></div>`;
  const shell = app.querySelector<HTMLElement>(".chat-window")!;
  // Replays the skin's opening motion each time the window is shown.
  const enter = () => {
    delete shell.dataset.entering;
    void shell.offsetWidth;
    shell.dataset.entering = "";
  };
  const q = <T extends HTMLElement>(s: string) => app.querySelector<T>(s)!;
  // 翻译记录 shares the window with the chat page.
  const translations = translationLog(shell, (shown) => {
    if (native)
      void invoke("chat_window_remember_view", { translations: shown }).catch(
        () => {},
      );
  });
  const showTranslations = async () => {
    if (native && !(await invoke<boolean>("take_translations_request"))) return;
    await translations.show();
  };
  const body = q(".chat-body");
  const view = await mountChatView(body, {
    showTranslations: () => {
      body.dataset.topics = "closed";
      void translations.show();
    },
    face: petFace,
  });
  // Who this is with: the pet's face and name, as a chat app shows the
  // person (plan/29). The chat is with the pet on the desktop.
  const face = q<HTMLImageElement>(".chat-face"),
    name = q(".chat-name > span");
  const showPet = (s: api.Snapshot) => {
    const p =
      s.pets.find((x) => x.id === s.settings.activeId) ??
      s.pets[0] ??
      // Previews: the bundled example pet.
      (native ? null : { id: "lizi", displayName: t("demo.makePet.name") });
    name.textContent = p?.displayName ?? t("app.name");
    face.hidden = !p;
    if (p)
      void petFace(p.id).then((url) => {
        face.src = url;
      });
  };
  void api.state().then(showPet);
  void api.changes(showPet);
  const topics = q("[data-topics]"),
    pin = q("[data-pin]");
  topics.onclick = () => {
    translations.hide();
    view.toggleTopics();
    topics.setAttribute("aria-pressed", String(body.dataset.topics === "open"));
  };
  new MutationObserver(() =>
    topics.setAttribute("aria-pressed", String(body.dataset.topics === "open")),
  ).observe(body, { attributes: true, attributeFilter: ["data-topics"] });
  q("[data-new]").onclick = () => {
    translations.hide();
    void view.newTopic();
  };
  pin.onclick = () => {
    const on = pin.getAttribute("aria-pressed") !== "true";
    pin.setAttribute("aria-pressed", String(on));
    if (native) void invoke("pin_chat_window", { on });
  };
  // Play the skin's closing motion, then hide the window.
  let leaving = false;
  const collapse = async (returnToBubble = false) => {
    if (leaving) return;
    leaving = true;
    delete shell.dataset.entering;
    shell.dataset.leaving = "";
    const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
    await new Promise((r) => setTimeout(r, still ? 0 : 180));
    if (native) await invoke("hide_chat_window", { returnToBubble });
    delete shell.dataset.leaving;
    leaving = false;
  };
  q("[data-collapse]").onclick = () => void collapse(false);
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.defaultPrevented) void collapse();
  });
  if (native) {
    // Typing here, the desktop pet looks over at the caret.
    watchCaret(
      body.querySelector<HTMLTextAreaElement>(".chat-composer textarea")!,
    );
    // Typing here stops the pet's voice; the name shows 在说 meanwhile.
    void watchSpeech(
      shell,
      body.querySelector<HTMLTextAreaElement>(".chat-composer textarea")!,
    );
    await watchWindowAppearance();
    const saved = await invoke<{ pinned: boolean; translations: boolean }>(
      "chat_window_state",
    ).catch(() => ({ pinned: true, translations: false }));
    pin.setAttribute("aria-pressed", String(saved.pinned));
    await listen("chat-release-check", () => {
      if (!leaving && !view.isDirty() && !translations.isDirty())
        void invoke("chat_window_release");
    });
    await listen("chat-window-close", () => void collapse());
    await listen("chat-translations", () => void showTranslations());
    const consumePendingSnip = async () => {
      const snip = await invoke<{
        data: string;
        preview: string;
        draftText?: string;
      } | null>("take_pending_snip_image").catch(() => null);
      if (!snip) return false;
      translations.hide();
      view.attachSnip(snip);
      return true;
    };
    const requestedTr = await invoke<boolean>("take_translations_request");
    const openPanel = async (restoreTr = false) => {
      enter();
      const target = await invoke<[number, number] | null>("take_chat_turn");
      if (target) {
        translations.hide();
        await view.focusTurn(...target);
      } else if (restoreTr) {
        await translations.show();
      } else {
        await view.reload();
      }
      if (!(await consumePendingSnip())) view.focus();
    };
    await listen("chat-snip-attached", () => void consumePendingSnip());
    await listen("chat-window-open", () => void openPanel(false));
    await openPanel(requestedTr || saved.translations);
  } else {
    Object.assign(window, {
      __studio: {
        translations: (records: TranslationRecord[]) =>
          translations.preview(records),
        attachSnip: (snip: {
          data: string;
          preview: string;
          draftText?: string;
        }) => {
          translations.hide();
          view.attachSnip(snip);
        },
        setSnipPreview: view.setSnipPreview,
        chat: async (
          name: string,
          theme = "day",
          skin: Skin = "studio",
          topicsOpen = false,
        ) => {
          await applySkin(skin);
          document.documentElement.dataset.theme = theme;
          view.preview(name);
          await view.reload();
          body.dataset.topics = topicsOpen ? "open" : "closed";
          enter();
        },
      },
    });
  }
  view.focus();
}
