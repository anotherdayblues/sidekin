// Renaming a pet (plan/29): double-click its name on the pet page and type,
// as Finder renames in place. Enter keeps the name, Esc puts the old one
// back, clicking away keeps it. A pencil shows on hover so it can be found;
// the list's right-click menu starts the same thing.
import "./styles/pet-name.css";
import { t } from "./i18n.ts";
import * as api from "./bridge.ts";
import type { StudioContext } from "./studioContext.ts";

const NAME_MAX = 12;

export function mountPetRename(c: StudioContext) {
  const title = c.$<HTMLElement>("#name");
  title.title = t("studio.renameHint");
  let before = "";
  let pet: string | null = null;

  function edit() {
    const p = c.selected();
    if (!p || title.isContentEditable) return;
    pet = p.id;
    before = p.displayName;
    title.textContent = before;
    title.contentEditable = "plaintext-only";
    title.dataset.editing = "";
    title.spellcheck = false;
    title.focus();
    getSelection()?.selectAllChildren(title);
  }
  function finish(keep: boolean) {
    if (!title.isContentEditable) return;
    const name = (title.textContent ?? "").trim();
    title.contentEditable = "false";
    delete title.dataset.editing;
    getSelection()?.removeAllRanges();
    const id = pet;
    pet = null;
    if (!keep || !id || !name || name === before) {
      title.textContent = before;
      return;
    }
    title.textContent = name;
    api.renamePet(id, name).then(
      () => c.lcd(t("studio.renamed", { name })),
      (e) => {
        title.textContent = before;
        c.lcd(String(e).replace(/^Error: /, ""), 9000);
      },
    );
  }
  title.addEventListener("dblclick", edit);
  title.addEventListener("keydown", (e) => {
    if (!title.isContentEditable || e.isComposing) return;
    if (e.key === "Enter") {
      e.preventDefault();
      finish(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      e.stopPropagation();
      finish(false);
    }
  });
  // At most twelve characters; a paste is cut there too.
  title.addEventListener("input", (e) => {
    if ((e as InputEvent).isComposing) return;
    const text = title.textContent ?? "";
    if ([...text].length <= NAME_MAX) return;
    title.textContent = [...text].slice(0, NAME_MAX).join("");
    getSelection()?.collapse(title, 1);
  });
  title.addEventListener("compositionend", () =>
    title.dispatchEvent(new Event("input")),
  );
  title.addEventListener("blur", () => finish(true));

  return {
    /** From the list's menu: show that pet, then edit its name. */
    async rename(p: api.Pet) {
      if (c.selected()?.id !== p.id) await c.save({ activeId: p.id });
      requestAnimationFrame(edit);
    },
    editing: () => title.isContentEditable,
  };
}
