import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import { t } from "./i18n.ts";
import { shortcutLabel } from "./shortcutRecorder.ts";

export type ChatSnipState = "ready" | "off" | "vision-off" | "no-vision-model";

export interface SnipAvailability {
  state: ChatSnipState;
  shortcut: string;
}

/** Format the tooltip for the snip button, appending the user's optional shortcut if set. */
export function snipTooltip(a: SnipAvailability): string {
  if (a.state === "no-vision-model") return t("chat.snipNeedsVision");
  const base = t("chat.snip");
  return a.shortcut ? `${base} (${shortcutLabel(a.shortcut)})` : base;
}

/** Watch authoritative chat-snip availability from the host (Brain visionInfo + settings),
 *  keeping bubble and chat WebViews free of the 370 KB model catalog bundle. */
export function watchChatSnip(onUpdate: (a: SnipAvailability) => void) {
  let current: SnipAvailability = {
    state: native ? "off" : "ready",
    shortcut: "",
  };
  let seq = 0;
  const refresh = async () => {
    const mine = ++seq;
    try {
      const next = await invoke<SnipAvailability>("chat_snip_status");
      if (mine !== seq || !next) return;
      current = {
        state: next.state ?? "off",
        shortcut: (next.shortcut ?? "").trim(),
      };
      onUpdate(current);
    } catch {
      // Keep last known state if the host isn't ready yet.
    }
  };
  onUpdate(current);
  if (native) {
    void listen("companion-settings", () => void refresh());
    void refresh();
  }
  return {
    get: () => current,
    refresh,
    setPreview(next: Partial<SnipAvailability>) {
      current = { ...current, ...next };
      onUpdate(current);
    },
  };
}
