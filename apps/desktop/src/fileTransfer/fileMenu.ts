// Right click on a held file or stack: 发到手机, 发给{pet} (when companion is on),
// 在访达中显示 (在资源管理器中显示 on Windows), 移除. A native menu, like the pet's own (petMenu.ts).
import { Menu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { t } from "../i18n.ts";
import { errorText } from "../errorText.ts";
import { call, mac, native } from "./bridge.ts";

let generation = 0;

/** 发到手机: onto the phone page's list; the host shows the QR code when no
 *  phone has the page open. Says how it went in the pile's notice. */
export async function sendToPhone(
  paths: string[],
  say: (text: string) => void,
) {
  try {
    const r = await call<{ sent: number; open: boolean } | null>("phone_send", {
      paths,
    });
    if (r?.open) say(t("files.sentPhone"));
  } catch (e) {
    say(String(e));
  }
}

/** 发给{pet}: open the chat side panel with these staged shelf files attached. */
export async function sendToPet(paths: string[], say: (text: string) => void) {
  try {
    await call("attach_files_to_chat", { paths });
  } catch (e) {
    const code = String(e).replace(/^Error:\s*/, "");
    say(errorText[code] ?? code);
  }
}

export function sendPetLabel(petName?: string) {
  const pet = petName?.trim() || t("app.name");
  return t("files.sendPet", { pet });
}

export interface FileMenuActions {
  send(): void;
  sendPet?: { label: string; action(): void };
  remove(): void;
}

export function fileMenuItems(
  n: number,
  paths: string[],
  acts: FileMenuActions,
  isMac = mac,
) {
  return [
    { id: `file-send-${n}`, text: t("files.sendPhone"), action: acts.send },
    ...(acts.sendPet
      ? [
          {
            id: `file-send-pet-${n}`,
            text: acts.sendPet.label,
            action: acts.sendPet.action,
          },
        ]
      : []),
    {
      id: `file-reveal-${n}`,
      text: t(isMac ? "files.revealMac" : "files.revealWin"),
      action: () => void call("reveal_file", { path: paths[0] }),
    },
    { item: "Separator" as const },
    { id: `file-remove-${n}`, text: t("files.remove"), action: acts.remove },
  ];
}

export async function fileMenu(
  e: MouseEvent,
  paths: string[],
  acts: FileMenuActions,
) {
  e.preventDefault();
  if (!native || !paths.length) return;
  // Tauri drops a handler by id once its menu closes: fresh ids each time.
  const n = ++generation;
  const menu = await Menu.new({
    items: fileMenuItems(n, paths, acts),
  });
  await menu.popup(new LogicalPosition(e.clientX, e.clientY));
}
