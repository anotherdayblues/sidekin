import { t } from "./i18n.ts";
import { hasDirectSearch } from "../../shared/searchServices.ts";
import { native } from "./bridge.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { CompanionSettings } from "../../shared/companion.ts";

export function mountGlobe(button: HTMLButtonElement) {
  let enabled = false;
  const set = (s: CompanionSettings) => {
    enabled =
      s.enabled &&
      (!!s.search ||
        (s.followSearch !== false && hasDirectSearch(s.service, s.baseUrl)));
    button.dataset.available = String(enabled);
    button.title = enabled ? t("chat.globe") : t("chat.globeSettings");
    if (!enabled) button.setAttribute("aria-pressed", "false");
  };
  if (native) {
    void listen<CompanionSettings>("companion-settings", (e) => set(e.payload));
    void invoke<CompanionSettings>("companion_settings")
      .then(set)
      .catch(() => {});
  }
  button.onclick = () => {
    if (!enabled) {
      if (native)
        void invoke("open_companion_page", {
          history: false,
          section: "online",
        });
      else {
        document
          .querySelector<HTMLButtonElement>('[data-block="settings"]')
          ?.click();
        document.getElementById("set-online")?.scrollIntoView();
      }
    } else
      button.setAttribute(
        "aria-pressed",
        String(button.getAttribute("aria-pressed") !== "true"),
      );
  };
  return {
    take() {
      const on = enabled && button.getAttribute("aria-pressed") === "true";
      button.setAttribute("aria-pressed", "false");
      return on;
    },
  };
}
