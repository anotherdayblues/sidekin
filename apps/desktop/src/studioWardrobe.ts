import { t } from "./i18n.ts";
import { showSkillPrompt } from "./skillPromptPopup.ts";
import { squish } from "./spring.ts";
import { el } from "./studioDom.ts";
import { CELL_W, CELL_H, type StudioContext } from "./studioContext.ts";
import type { mountStudioPopovers } from "./studioPopovers.ts";
import * as api from "./bridge.ts";

const TRASH_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2.8 4.2h10.4M6 4.2V2.9a.7.7 0 0 1 .7-.7h2.6a.7.7 0 0 1 .7.7v1.3m-5.5 0 .6 8.3a1 1 0 0 0 1 .9h3.8a1 1 0 0 0 1-.9l.6-8.3M6.7 7v4M9.3 7v4"/></svg>';

const BACK_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M10 3.5L5.5 8 10 12.5"/></svg>';

const SPARKLE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.8l1.2 3.5L12.7 6.5 9.2 7.7 8 11.2 6.8 7.7 3.3 6.5l3.5-1.2L8 1.8zM12.5 10.4l.5 1.5 1.5.5-1.5.5-.5 1.5-.5-1.5-1.5-.5 1.5-.5.5-1.5z"/></svg>';

export function promptDressPet(
  p: api.Pet,
  anchor: HTMLElement,
  menus: Pick<ReturnType<typeof mountStudioPopovers>, "openPop" | "closePop">,
  lcd: (message: string) => void,
) {
  showSkillPrompt(
    anchor,
    t("studio.dressTitle", { name: p.displayName }),
    "dress-desktop-pet",
    t("studio.dressAsk", { name: p.displayName, id: p.id }),
    t("studio.dressHint"),
    menus,
    lcd,
  );
}

export function mountStudioWardrobe(
  c: StudioContext,
  menus: ReturnType<typeof mountStudioPopovers>,
) {
  const { $, app, selected, attempt, drawCell, image, thumb, lcd } = c;
  const trigger = $<HTMLButtonElement>("#wardrobe-key");
  const triggerLabel = $("#wardrobe-key-label");
  const side = $<HTMLElement>(".side");
  const pane = $<HTMLElement>("#wardrobe-pane");

  const outfitThumbs = new Map<string, Promise<ImageBitmap>>();
  function loadOutfitThumb(
    p: api.Pet,
    outfitId: string,
  ): Promise<ImageBitmap> {
    if (outfitId === api.defaultOutfitId) return thumb(p);
    const key = `${p.id}:${p.fingerprint}:${p.revision}:${outfitId}`;
    let cached = outfitThumbs.get(key);
    if (!cached) {
      cached = api
        .outfitThumbnail(p.id, outfitId)
        .then(image)
        .then((img) =>
          createImageBitmap(
            img,
            0,
            0,
            Math.min(CELL_W, img.naturalWidth || CELL_W),
            Math.min(CELL_H, img.naturalHeight || CELL_H),
          ),
        );
      cached.catch(() => outfitThumbs.delete(key));
      outfitThumbs.set(key, cached);
    }
    return cached;
  }

  function outfitLabel(p: api.Pet, outfitId: string): string {
    if (outfitId === api.defaultOutfitId) return t("wardrobe.default");
    return (
      p.wardrobe?.outfits.find((o) => o.id === outfitId)?.displayName ??
      outfitId
    );
  }

  let open = false;
  let armedDeleteId: string | null = null;
  let lastPetId: string | null = null;
  let renderToken = 0;

  function setOpen(next: boolean) {
    if (open === next) return;
    open = next;
    if (!open) armedDeleteId = null;
    else menus.closePop();
    side.dataset.mode = open ? "wardrobe" : "";
    if (!open) delete side.dataset.mode;
    pane.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    render(selected());
  }

  function renderPane(p: api.Pet) {
    const token = ++renderToken;
    const outfits = p.wardrobe?.outfits ?? [];
    const wornId = c.wornOutfit(p);

    if (
      armedDeleteId &&
      !outfits.some((o) => o.id === armedDeleteId)
    ) {
      armedDeleteId = null;
    }

    const head = el("header", "wardrobe-pane-head");
    head.setAttribute("data-titlebar", "");
    const backBtn = el("button", "wardrobe-back");
    backBtn.type = "button";
    backBtn.innerHTML = BACK_SVG;
    backBtn.append(el("span", "", t("wardrobe.back")));
    backBtn.onclick = () => setOpen(false);

    const title = el(
      "h2",
      "wardrobe-pane-title",
      t("wardrobe.paneTitle", { name: p.displayName }),
    );

    const doneBtn = el("button", "wardrobe-done", t("wardrobe.done"));
    doneBtn.type = "button";
    doneBtn.onclick = () => setOpen(false);

    head.append(backBtn, title, doneBtn);

    const body = el("div", "wardrobe-pane-body");

    if (outfits.length > 0) {
      const grid = el("div", "wardrobe-grid");
      const items: Array<{ id: string; displayName: string; deletable: boolean }> = [
        {
          id: api.defaultOutfitId,
          displayName: t("wardrobe.default"),
          deletable: false,
        },
        ...outfits.map((o) => ({
          id: o.id,
          displayName: o.displayName,
          deletable: true,
        })),
      ];

      for (const item of items) {
        const isWorn = wornId === item.id;
        const card = el("div", "outfit-card");
        card.setAttribute("role", "button");
        card.tabIndex = 0;
        if (isWorn) card.classList.add("is-worn");
        if (armedDeleteId === item.id) card.classList.add("is-armed");
        card.setAttribute("aria-pressed", String(isWorn));
        card.setAttribute("aria-label", item.displayName);

        const canvas = el("canvas");
        canvas.width = 96;
        canvas.height = 104;
        card.append(canvas, el("span", "outfit-name", item.displayName));

        if (isWorn) {
          card.append(el("span", "outfit-badge", t("wardrobe.wearing")));
        }

        const selectOutfit = () => {
          armedDeleteId = null;
          const nextPref: api.PetWardrobePreference | null =
            item.id === api.defaultOutfitId ? null : { outfit: item.id };
          void attempt(() => api.setPetWardrobePref(p.id, nextPref));
        };

        card.onclick = (e) => {
          if ((e.target as HTMLElement).closest(".outfit-del")) return;
          selectOutfit();
        };
        card.onkeydown = (e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            selectOutfit();
          }
        };

        if (item.deletable) {
          const delBtn = el("button", "outfit-del");
          delBtn.type = "button";
          delBtn.innerHTML = TRASH_SVG;
          const aria = t("wardrobe.deleteAria", { name: item.displayName });
          delBtn.title = aria;
          delBtn.setAttribute("aria-label", aria);
          delBtn.onclick = (e) => {
            e.stopPropagation();
            armedDeleteId = armedDeleteId === item.id ? null : item.id;
            renderPane(p);
          };
          card.append(delBtn);
        }

        squish(card, 0.03);
        grid.append(card);

        void loadOutfitThumb(p, item.id)
          .catch(() => thumb(p))
          .then((bmp) => {
            if (token !== renderToken) return;
            drawCell(canvas, bmp, 0, 0);
          })
          .catch(() => {});
      }

      body.append(grid);

      if (armedDeleteId) {
        const target = outfits.find((o) => o.id === armedDeleteId);
        if (target) {
          const strip = el("div", "wardrobe-confirm");
          strip.setAttribute("role", "alert");
          strip.append(
            el(
              "span",
              "wardrobe-confirm-text",
              t("wardrobe.deleteConfirm", { name: target.displayName }),
            ),
          );
          const actions = el("div", "wardrobe-confirm-actions");
          const cancelBtn = el(
            "button",
            "wardrobe-confirm-cancel",
            t("common.cancel"),
          );
          cancelBtn.type = "button";
          cancelBtn.onclick = () => {
            armedDeleteId = null;
            renderPane(p);
          };
          const okBtn = el(
            "button",
            "wardrobe-confirm-delete",
            t("wardrobe.delete"),
          );
          okBtn.type = "button";
          okBtn.onclick = () => {
            const targetId = target.id;
            const targetName = target.displayName;
            armedDeleteId = null;
            void attempt(async () => {
              await api.deletePetOutfit(p.id, targetId);
              lcd(t("wardrobe.deleted", { name: targetName }));
            });
          };
          actions.append(cancelBtn, okBtn);
          strip.append(actions);
          body.append(strip);
        }
      }
    } else {
      const empty = el("div", "wardrobe-empty");
      const preview = el("canvas");
      preview.width = 96;
      preview.height = 104;
      empty.append(
        preview,
        el(
          "strong",
          "wardrobe-empty-title",
          t("wardrobe.emptyTitle", { name: p.displayName }),
        ),
        el("p", "wardrobe-empty-desc", t("wardrobe.emptyDesc")),
      );
      body.append(empty);
      void thumb(p)
        .then((bmp) => {
          if (token !== renderToken) return;
          drawCell(preview, bmp, 0, 0);
        })
        .catch(() => {});
    }

    const makeBtn = el("button", "wardrobe-make-btn pop-anchor");
    makeBtn.type = "button";
    makeBtn.innerHTML = SPARKLE_SVG;
    makeBtn.append(
      el(
        "span",
        "",
        outfits.length > 0
          ? t("wardrobe.makeFor", { name: p.displayName })
          : t("wardrobe.makeFirst", { name: p.displayName }),
      ),
    );
    makeBtn.onclick = () => promptDressPet(p, makeBtn, menus, lcd);
    squish(makeBtn, 0.03);
    body.append(makeBtn);

    pane.replaceChildren(head, body);
  }

  trigger.onclick = () => {
    const p = selected();
    if (!p) return;
    setOpen(!open);
  };
  squish(trigger, 0.04);

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || !open) return;
    const pop = $("#pop");
    if (!pop.hidden) return;
    const p = selected();
    if (armedDeleteId && p) {
      armedDeleteId = null;
      renderPane(p);
      return;
    }
    setOpen(false);
  });

  app.addEventListener("pet-changed", () => {
    armedDeleteId = null;
  });

  function render(p: api.Pet | undefined) {
    if (!p) {
      trigger.hidden = true;
      if (open) setOpen(false);
      lastPetId = null;
      return;
    }
    if (p.id !== lastPetId) {
      lastPetId = p.id;
      armedDeleteId = null;
    }

    const hasOutfits = !!(p.wardrobe && p.wardrobe.outfits.length > 0);
    const wornId = c.wornOutfit(p);
    const label = outfitLabel(p, wornId);

    trigger.hidden = false;
    trigger.dataset.empty = String(!hasOutfits);
    trigger.setAttribute("aria-expanded", String(open));
    triggerLabel.textContent = hasOutfits
      ? t("wardrobe.trigger", { name: label })
      : t("wardrobe.title");
    trigger.title = triggerLabel.textContent;

    if (open) {
      const prevScroll =
        pane.querySelector<HTMLElement>(".wardrobe-pane-body")?.scrollTop ?? 0;
      renderPane(p);
      const nextBody = pane.querySelector<HTMLElement>(".wardrobe-pane-body");
      if (nextBody) nextBody.scrollTop = prevScroll;
    }
  }

  return { render, close: () => setOpen(false), isOpen: () => open };
}
