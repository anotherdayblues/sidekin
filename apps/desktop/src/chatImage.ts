import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";

export function openChatImage(preview: string, turn?: number) {
  const dialog = document.createElement("dialog");
  dialog.className = "chat-image-viewer";
  dialog.setAttribute("aria-label", t("chat.viewImage"));
  dialog.innerHTML = `<button type="button">${t("common.close")}</button><div><img alt="${t("chat.chatImage")}"></div>`;
  const image = dialog.querySelector("img")!;
  image.src = preview;
  const close = dialog.querySelector("button")!;
  close.onclick = () => dialog.close();
  dialog.onkeydown = (e) => {
    if (e.key === "Escape") e.stopPropagation();
  };
  image.onclick = () => dialog.toggleAttribute("data-actual-size");
  dialog.onclose = () => dialog.remove();
  document.body.append(dialog);
  dialog.showModal();
  if (turn !== undefined)
    void invoke<string>("chat_image", { turn })
      .then((url) => {
        if (dialog.open) image.src = url;
      })
      .catch(() => {
        image.alt = t("chat.previewOnly");
        close.textContent = t("chat.previewOnlyClose");
      });
}
