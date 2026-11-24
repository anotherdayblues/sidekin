// Due reminders in the bubble: the notice card and its two answers.
import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import type { Notice } from "./reminders.ts";

/** `changed` runs after every redraw, with what is shown now. */
export function bubbleNotices(
  notice: HTMLElement,
  changed: (items: Notice[]) => void,
) {
  let notices: Notice[] = [];
  function draw(items: Notice[]) {
    notices = items;
    notice.hidden = !items.length;
    notice.querySelector("strong")!.textContent = items.some((i) => i.missed)
      ? t("notice.missed")
      : items.length > 1
        ? t("notice.due")
        : t("reminders.title");
    notice.querySelector("div")!.textContent = items
      .map((i) => i.message)
      .join("\n");
    notice.querySelector("small")!.textContent = "";
    changed(items);
  }
  async function resolve(snooze: boolean) {
    if (!native) {
      draw([]);
      return;
    }
    try {
      draw(
        await invoke<Notice[]>("resolve_reminders", {
          items: notices.map(({ id, revision }) => ({ id, revision })),
          snooze,
        }),
      );
    } catch (e) {
      draw(await invoke("pending_reminders"));
      notice.querySelector("small")!.textContent = String(e);
    }
  }
  notice.querySelector<HTMLElement>("[data-ack]")!.onclick = () =>
    void resolve(false);
  notice.querySelector<HTMLElement>("[data-later]")!.onclick = () =>
    void resolve(true);
  return { draw, any: () => notices.length > 0 };
}
