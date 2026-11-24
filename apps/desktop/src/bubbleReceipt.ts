// The small "记住了 · 撤销" line under a reply that saved a memory.
import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
export type MemoryReceipt = {
  id: number;
  petId: string;
  expiresInMs: number;
  entries: { book: string; added?: string; removed?: string }[];
};
export function memoryReceipt(saved: HTMLElement) {
  const savedText = saved.querySelector("span")!,
    undo = saved.querySelector("button")!;
  let receipt: MemoryReceipt | null = null,
    receiptTimer = 0;
  function clearRemembered() {
    clearTimeout(receiptTimer);
    receipt = null;
    saved.hidden = true;
  }
  function showRemembered(value: MemoryReceipt | null) {
    clearRemembered();
    receipt = value;
    savedText.textContent = value
      ? t("bubble.remembered")
      : t("bubble.rememberedAlready");
    undo.hidden = !value;
    undo.disabled = false;
    saved.hidden = false;
    receiptTimer = window.setTimeout(
      clearRemembered,
      value?.expiresInMs ?? 5000,
    );
    if (value) undo.setAttribute("aria-label", t("bubble.undoMemory"));
  }
  undo.onclick = async () => {
    const item = receipt;
    if (!item || undo.disabled) return;
    undo.disabled = true;
    try {
      if (native)
        await invoke("memory_edit", { petId: item.petId, undoId: item.id });
      if (receipt === item) {
        savedText.textContent = t("bubble.undone");
        undo.hidden = true;
      }
    } catch (e) {
      if (receipt === item) {
        savedText.textContent = String(e);
        undo.hidden = true;
      }
    }
  };
  return { clearRemembered, showRemembered };
}
