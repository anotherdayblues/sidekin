// A failed request in the bubble: what already arrived stays, the reason
// follows it, and the action button goes where that reason can be fixed.
import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { errorText } from "./errorText.ts";
import {
  openAppPermissionsPage,
  openPermissionSettings,
} from "./permissionsView.ts";
import type { BubbleMode, BubbleView } from "./bubbleView.ts";

/** Reasons fixed in settings rather than by trying again. */
const SETTINGS = ["auth", "vision", "model", "disabled"];

export function bubbleError(
  action: HTMLElement,
  o: {
    view: BubbleView;
    reply: { partial(): string; setText(text: string): void; paint(): void };
    reset(): void;
    state(s: string): void;
    submit(message: string, operation: BubbleMode): Promise<void>;
    openInput(): void;
  },
) {
  const { view } = o;
  action.onclick = () => {
    if (view.reason === "screenPermission") {
      void openPermissionSettings("screen");
      return;
    }
    if (view.reason === "screenPermissionOff") {
      void openAppPermissionsPage();
      return;
    }
    if (view.mode === "vision" && view.reason !== "vision") {
      void invoke("start_snip");
      return;
    }
    if (view.reason === "permission") {
      void openPermissionSettings("accessibility");
      return;
    }
    if (view.reason === "permissionOff") {
      void openAppPermissionsPage();
      return;
    }
    if (view.reason === "clipboard") {
      void invoke("retry_selection");
      return;
    }
    if (SETTINGS.includes(view.reason))
      void invoke("open_companion_page", { history: false });
    else if (view.last) void o.submit(view.last, view.mode);
    else o.openInput();
  };
  return function error(code: string) {
    const partial = o.reply.partial().trim();
    o.reset();
    view.token = "";
    view.reason = code;
    const why = errorText[code] ?? code;
    o.reply.setText(partial ? partial + "\n\n" + why : why);
    o.reply.paint();
    o.state("error");
    action.textContent =
      code === "screenPermission" || code === "permission"
        ? t("settings.openSystemSettings")
        : code === "screenPermissionOff" || code === "permissionOff"
          ? t("perm.openAppSettings")
          : SETTINGS.includes(code)
            ? t("bubble.toSettings")
            : t("common.retry");
  };
}
