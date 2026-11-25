import { t } from "./i18n.ts";
import { Menu } from "@tauri-apps/api/menu";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import * as api from "./bridge.ts";
import { focusChoices, type FocusState } from "./focus.ts";
import { todoMenu } from "./todo/menu.ts";
export function petMenus(
  read: () => {
    focus: FocusState;
    /** 手机传文件 is receiving now. */
    phone: boolean;
    enabled: boolean;
    clickOpensChat: boolean;
    translation: boolean;
    snapshot: api.Snapshot;
  },
) {
  /** Open the studio on one of its five blocks. */
  const studioAt = (block: string) => {
    api.showStudio();
    void emit("studio-block", block);
  };
  /** 宠物声音: on or off, and whether a voice is set up at all. */
  async function voice() {
    const off = { enabled: false, ready: false };
    try {
      return (
        (await invoke<{ enabled: boolean; ready: boolean } | null>(
          "get_voice",
        )) ?? off
      );
    } catch {
      return off;
    }
  }
  // Ordered by how often people need it (plan/11 交互和分区 第 2.1 节).
  // Tauri drops an item's handler by id when the old menu closes, so every
  // rebuild needs fresh ids or the new menu loses all its actions.
  let menuGeneration = 0;
  const createMenu = async () => {
    const { enabled, clickOpensChat, translation, snapshot, focus, phone } =
      read();
    const n = ++menuGeneration;
    // 番茄钟 (plan/19): what fits the timer's phase.
    // 陪我专注 asks which to-do first, when there are any (plan/27).
    const focusItems = focusChoices(focus).map(([cmd, label]) => ({
      id: `pet-focus-${cmd}-${n}`,
      text: t(label),
      action: () =>
        void invoke(
          cmd === "start" && focus.phase === "idle"
            ? "todo_start_from_menu"
            : `focus_${cmd}`,
        ),
    }));
    const [sound, todoItems] = await Promise.all([voice(), todoMenu(focus, n)]);
    // 待办 leads when the timer is idle; while it runs, its keys come first.
    const top =
      focus.phase === "idle"
        ? [...todoItems, ...focusItems]
        : [...focusItems, ...todoItems];
    return Menu.new({
      items: [
        ...top,
        // 手机传文件 (plan/20): start, or show the code again and stop.
        ...(phone
          ? [
              {
                id: `pet-phone-show-${n}`,
                text: t("phone.menu.show"),
                action: () => void invoke("phone_start"),
              },
              {
                id: `pet-phone-stop-${n}`,
                text: t("phone.menu.stop"),
                action: () => void invoke("phone_stop"),
              },
            ]
          : [
              {
                id: `pet-phone-start-${n}`,
                text: t("phone.menu.start"),
                action: () => void invoke("phone_start"),
              },
            ]),
        { item: "Separator" as const },
        ...(enabled
          ? []
          : [
              {
                id: `pet-companion-${n}`,
                text: t("menu.openCompanion"),
                action: () => studioAt("settings"),
              },
              { item: "Separator" as const },
            ]),
        ...(enabled && !clickOpensChat
          ? [
              {
                id: `pet-chat-${n}`,
                text: t("onboard.talk"),
                action: () => void invoke("open_chat"),
              },
            ]
          : []),
        {
          id: `pet-chat-window-${n}`,
          text: t("menu.openChat"),
          enabled,
          action: () => void invoke("open_chat_window"),
        },
        {
          id: `pet-clipboard-${n}`,
          text: t("clip.title"),
          action: () => void invoke("clip_open"),
        },
        {
          id: `pet-vision-${n}`,
          text: t("menu.snip"),
          enabled: true,
          action: () => void invoke("start_snip"),
        },
        {
          id: `pet-translation-menu-${n}`,
          text: t("settings.translation"),
          items: [
            {
              id: `pet-translate-${n}`,
              text: t("menu.translateSelection"),
              enabled: enabled && translation,
              action: () => void invoke("translate_selection_from_menu"),
            },
            {
              id: `pet-translations-${n}`,
              text: t("menu.translatePanel"),
              action: () => void invoke("open_translations"),
            },
          ],
        },
        {
          id: `pet-controls-${n}`,
          text: t("menu.petControls"),
          items: [
            {
              id: `pet-voice-${n}`,
              text: sound.enabled ? t("menu.mute") : t("menu.unmute"),
              action: () => {
                if (sound.enabled || sound.ready)
                  void invoke("set_voice_enabled", { on: !sound.enabled });
                else studioAt("settings");
              },
            },
            {
              id: `pet-pause-${n}`,
              text: snapshot.settings.paused
                ? t("reminders.resume")
                : t("reminders.pause"),
              action: () => {
                const { settings } = read().snapshot;
                api.save({
                  ...settings,
                  paused: !settings.paused,
                });
              },
            },
            {
              id: `pet-hide-${n}`,
              text: t("menu.hide"),
              action: () => {
                api.save({ ...read().snapshot.settings, visible: false });
              },
            },
          ],
        },
        { item: "Separator" as const },
        {
          id: `pet-open-${n}`,
          text: t("menu.openMain"),
          action: () => api.showStudio(),
        },
        { id: `pet-quit-${n}`, text: t("menu.quit"), action: () => api.quit() },
      ],
    });
  };
  return createMenu;
}
