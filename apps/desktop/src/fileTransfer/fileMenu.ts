// Right click on a held file or stack: 发到手机, 在访达中显示 (在资源管理器中
// 显示 on Windows), 移除. A native menu, like the pet's own (petMenu.ts).
import { Menu } from "@tauri-apps/api/menu";
import { LogicalPosition } from "@tauri-apps/api/dpi";
import { t } from "../i18n.ts";
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

export async function fileMenu(
  e: MouseEvent,
  paths: string[],
  acts: { send(): void; remove(): void },
) {
  e.preventDefault();
  if (!native || !paths.length) return;
  // Tauri drops a handler by id once its menu closes: fresh ids each time.
  const n = ++generation;
  const menu = await Menu.new({
    items: [
      { id: `file-send-${n}`, text: t("files.sendPhone"), action: acts.send },
      {
        id: `file-reveal-${n}`,
        text: t(mac ? "files.revealMac" : "files.revealWin"),
        action: () => void call("reveal_file", { path: paths[0] }),
      },
      { item: "Separator" as const },
      { id: `file-remove-${n}`, text: t("files.remove"), action: acts.remove },
    ],
  });
  await menu.popup(new LogicalPosition(e.clientX, e.clientY));
}
