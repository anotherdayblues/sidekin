// A right click on a pet in the list (plan/29): what is about the whole pet
// and not one action, as Finder's sidebar does. Renaming it, base actions
// redrawn before put back, and deleting the pet.
import { t } from "./i18n.ts";
import { ANIMATIONS } from "./animation.ts";
import { actionLabel } from "./teaching.ts";
import { el } from "./studioDom.ts";
import * as api from "./bridge.ts";
import type { StudioContext } from "./studioContext.ts";
import type { mountStudioPopovers } from "./studioPopovers.ts";

export function mountPetMenu(
  c: StudioContext,
  menus: ReturnType<typeof mountStudioPopovers>,
  rename: (p: api.Pet) => void,
) {
  function open(p: api.Pet, anchor: HTMLElement) {
    const items: HTMLElement[] = [];
    const name = el("button", "pop-item", t("studio.rename"));
    name.type = "button";
    name.onclick = () => {
      menus.closePop();
      rename(p);
    };
    items.push(name);
    const exp = el("button", "pop-item", t("studio.export"));
    exp.type = "button";
    exp.onclick = () => {
      menus.closePop();
      c.attempt(async () => {
        if (await api.exportPackage(p))
          c.lcd(t("studio.exported", { name: p.displayName }));
      });
    };
    items.push(exp);
    // Base actions redrawn before plan/29 closed that: put back as made.
    const layer = c.custom(p).layer;
    const redrawn = Object.keys(layer.actions).filter((n) => n in ANIMATIONS);
    if (redrawn.length) {
      const back = el("button", "pop-item pop-anchor", t("studio.restoreBase"));
      back.type = "button";
      back.onclick = () =>
        menus.confirmPop(
          back,
          t("studio.restoreBase"),
          [
            t("studio.restoreBaseLead", {
              list: redrawn.map((n) => `「${actionLabel(n, layer)}」`).join(""),
            }),
          ],
          t("studio.restoreActionButton"),
          () => api.forgetCustom(p.id, redrawn, []),
        );
      items.push(back);
    }
    const remove = el(
      "button",
      "pop-item danger pop-anchor",
      t("studio.remove"),
    );
    remove.type = "button";
    remove.onclick = () => menus.confirmRemove(p, remove);
    items.push(remove);
    menus.openPop(anchor, items);
  }
  return { open };
}
