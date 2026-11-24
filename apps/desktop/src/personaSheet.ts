// 性格 (plan/33): this pet's SOUL.md, up to 1500 characters in sections.
// One row among the pet's own settings (放到桌面 · 动画 · 大小) opens a
// panel from the right with the whole text and the save/reset keys,
// as ChatGPT and Claude give their long instructions room. Only the page:
// the fields and keys are the companion form's own (companion.ts).
import { t } from "./i18n.ts";

/** The most it may hold (persona.rs). */
const LIMIT = 1500;

export function mountPersonaSheet(
  app: HTMLElement,
  parts: {
    /** The label holding the 性格 textarea. */
    field: HTMLElement;
    /** 恢复默认 · 保存. */
    keys: HTMLElement;
    /** Where 已保存 or error messages show. */
    output: HTMLElement;
    /** Reloads the currently active pet's personality before showing the sheet. */
    onOpen?: () => Promise<void>;
  },
) {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "control persona-row";
  row.setAttribute("aria-haspopup", "dialog");
  row.innerHTML = `<span class="silk">${t("pet.personality")}</span><span class="persona-chev" aria-hidden="true"></span>`;
  app.querySelector("#controls")?.append(row);

  const sheet = document.createElement("dialog");
  sheet.className = "persona-sheet";
  sheet.setAttribute("aria-labelledby", "persona-title");
  sheet.innerHTML = `<header class="persona-head"><img class="persona-face" alt=""><div><h3 id="persona-title"></h3><p class="persona-sub"></p></div><button type="button" class="persona-close" aria-label="${t("common.close")}"></button></header>
  <div class="persona-body"><p class="persona-tip">${t("persona.tip")}</p></div>
  <footer class="persona-foot"><span class="persona-count"></span></footer>`;
  const text = parts.field.querySelector("textarea")!;
  text.setAttribute("aria-labelledby", "persona-title");
  parts.output.classList.add("persona-try");
  sheet.querySelector(".persona-body")!.append(parts.field, parts.output);
  // 恢复默认 · 保存, the main key last.
  const save = parts.keys.querySelector<HTMLElement>("[data-persona-save]")!;
  save.textContent = t("common.save");
  save.classList.add("persona-save");
  parts.keys.append(save);
  sheet.querySelector(".persona-foot")!.append(parts.keys);
  app.append(sheet);

  const count = sheet.querySelector<HTMLElement>(".persona-count")!;
  const counted = () => {
    const n = [...text.value].length;
    count.textContent = t("persona.count", { n, max: LIMIT });
    count.toggleAttribute("data-over", n > LIMIT);
  };
  text.addEventListener("input", counted);

  let openSeq = 0;
  row.onclick = async () => {
    const seq = ++openSeq;
    // Whose it is: the pet on the page now.
    const name = app.querySelector("#name")?.textContent ?? "";
    sheet.querySelector("#persona-title")!.textContent = t("persona.title", {
      name,
    });
    sheet.querySelector(".persona-sub")!.textContent = t("persona.sub", {
      name,
    });
    const face = app.querySelector<HTMLCanvasElement>(
      '.roster [aria-pressed="true"] canvas',
    );
    const img = sheet.querySelector<HTMLImageElement>(".persona-face")!;
    img.hidden = !face;
    if (face) img.src = face.toDataURL();
    parts.output.textContent = "";
    await parts.onOpen?.();
    if (seq !== openSeq) return;
    counted();
    if (!sheet.open) sheet.showModal();
    text.focus();
  };
  sheet.querySelector<HTMLElement>(".persona-close")!.onclick = () =>
    sheet.close();
  // A click on the dim outside closes it too.
  sheet.addEventListener("click", (e) => {
    if (e.target === sheet) sheet.close();
  });
  return { open: () => row.click() };
}
