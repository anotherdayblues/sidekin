import { t, type Key } from "./i18n.ts";

export interface ClipPreferences {
  enabled: boolean;
  excluded: string;
  retentionDays: number;
  saveImages?: boolean;
  ocrImages?: boolean;
}
export type ClipKind = "text" | "image";
export type ClipFilter = "all" | ClipKind;
export interface ClipEntry {
  id: number;
  kind?: ClipKind;
  preview: string;
  source: string;
  at: number;
  pinned: boolean;
  link: boolean;
  width?: number;
  height?: number;
  bytes?: number;
  thumb?: string;
  ocrPreview?: string;
}
export interface ClipDetail {
  id: number;
  kind: ClipKind;
  text?: string;
  imageDataUrl?: string;
  width?: number;
  height?: number;
  bytes?: number;
  ocr?: string;
}
export interface ClipImageUsage {
  count: number;
  bytes: number;
  limitCount: number;
  limitBytes: number;
}
export const defaultClipPrefs: ClipPreferences = {
  enabled: false,
  excluded: "",
  retentionDays: 7,
  saveImages: true,
  ocrImages: true,
};
export function retentionLabel(days: number) {
  return days ? t("clip.days", { days }) : t("clip.noExpiry");
}
export function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
export type ClipCall = <T>(
  name: string,
  args?: Record<string, unknown>,
) => Promise<T>;

export function clipSettings(
  container: HTMLElement,
  prefs: ClipPreferences,
  actions: {
    save: (patch: Partial<ClipPreferences>) => Promise<void>;
    clear: () => Promise<void>;
    back: () => void;
    error: (e: unknown) => void;
    usage?: ClipImageUsage | null;
  },
) {
  function button(key: Key, fn: () => void) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = t(key);
    b.onclick = fn;
    return b;
  }
  function switchRow(key: Key, checked: boolean, attr: string) {
    const row = document.createElement("label"),
      input = document.createElement("input");
    input.type = "checkbox";
    input.checked = checked;
    input.className = "slide-switch";
    input.setAttribute("role", "switch");
    input.dataset[attr] = "";
    row.className = "clip-option-row";
    row.append(t(key), input);
    return { row, input };
  }
  const curSaveImages = prefs.saveImages ?? true;
  const curOcrImages = prefs.ocrImages ?? true;
  const form = document.createElement("div");
  form.className = "clip-options";
  const { row: record, input: toggle } = switchRow(
    "clip.record",
    prefs.enabled,
    "recordToggle",
  );
  const { row: saveImagesRow, input: saveImagesToggle } = switchRow(
    "clip.saveImages",
    curSaveImages,
    "saveImagesToggle",
  );
  const { row: ocrImagesRow, input: ocrImagesToggle } = switchRow(
    "clip.ocrImages",
    curOcrImages,
    "ocrImagesToggle",
  );
  const syncImageSubToggle = () => {
    ocrImagesToggle.disabled = !saveImagesToggle.checked;
    ocrImagesRow.classList.toggle("clip-option-disabled", !saveImagesToggle.checked);
  };
  saveImagesToggle.onchange = syncImageSubToggle;
  syncImageSubToggle();

  const retention = document.createElement("label"),
    select = document.createElement("select");
  retention.className = "clip-option-row";
  retention.append(t("clip.retention"), select);
  for (const days of [1, 7, 30, 90, 0])
    select.add(new Option(retentionLabel(days), String(days)));
  select.value = String(prefs.retentionDays);
  const note = document.createElement("small");
  note.textContent = t("clip.capacity");
  const usageEl = document.createElement("small");
  usageEl.className = "clip-option-usage";
  if (actions.usage) {
    usageEl.textContent = t("clip.imageUsage", {
      count: actions.usage.count,
      used: formatBytes(actions.usage.bytes),
      limit: formatBytes(actions.usage.limitBytes),
    });
  } else {
    usageEl.hidden = true;
  }
  const exclude = document.createElement("label"),
    area = document.createElement("textarea");
  exclude.className = "clip-option-exclude";
  area.rows = 2;
  area.maxLength = 4096;
  area.spellcheck = false;
  area.value = prefs.excluded;
  exclude.append(t("clip.excluded"), area);
  const confirm = document.createElement("p");
  confirm.className = "clip-option-warning";
  confirm.textContent = t("clip.shortenNote");
  confirm.hidden = true;
  const bar = document.createElement("div");
  bar.className = "clip-option-buttons";
  const save = button("clip.saveSettings", async () => {
    const patch: Partial<ClipPreferences> = {};
    if (toggle.checked !== prefs.enabled) patch.enabled = toggle.checked;
    if (saveImagesToggle.checked !== curSaveImages)
      patch.saveImages = saveImagesToggle.checked;
    if (ocrImagesToggle.checked !== curOcrImages)
      patch.ocrImages = ocrImagesToggle.checked;
    if (Number(select.value) !== prefs.retentionDays)
      patch.retentionDays = Number(select.value);
    if (area.value !== prefs.excluded) patch.excluded = area.value;
    save.disabled = true;
    try {
      await actions.save(patch);
    } catch (e) {
      save.disabled = false;
      actions.error(e);
    }
  });
  select.onchange = () => {
    const days = Number(select.value);
    const shorter =
      days > 0 && (prefs.retentionDays === 0 || days < prefs.retentionDays);
    confirm.hidden = !shorter;
    save.textContent = t(shorter ? "clip.confirmShorten" : "clip.saveSettings");
  };
  const erase = button("clip.clear", () => {
    const ask = document.createElement("div");
    ask.className = "clip-option-buttons";
    ask.append(
      t("clip.confirmClear"),
      button("clip.clear", () => void actions.clear().catch(actions.error)),
      button("clip.back", () => container.replaceChildren(form)),
    );
    container.replaceChildren(ask);
  });
  bar.append(save, button("clip.back", actions.back), erase);
  form.append(
    record,
    saveImagesRow,
    ocrImagesRow,
    retention,
    note,
    usageEl,
    exclude,
    confirm,
    bar,
  );
  container.replaceChildren(form);
}
