import { t } from "./i18n.ts";
import { el } from "./studioDom.ts";
import { applySkin, SKINS, type Skin } from "./skin.ts";
import type { mountStudioNavigation } from "./studioNavigation.ts";
import type { StudioContext } from "./studioContext.ts";

export function mountStudioAppearance(
  c: StudioContext,
  navigation: ReturnType<typeof mountStudioNavigation>,
) {
  const { $, app, save, lcd } = c;
  // ---------- skins ----------
  const skinPicker = el("section", "skin-picker set-group");
  skinPicker.id = "set-look";
  skinPicker.innerHTML = `<h3 class="set-title">${t("settings.look")}</h3><p class="set-note">${t("studio.skinNote")}</p><div class="skin-cards">${SKINS.map(
    (k) =>
      `<button class="skin-card" data-skin="${k.id}" aria-pressed="false"><span class="skin-thumb skin-thumb-${k.id}" aria-hidden="true"><i></i><i></i><i></i></span><b>${k.label}</b><small>${k.note}</small></button>`,
  ).join("")}</div>`;
  (
    app.querySelector("#companion-form") ?? $(`.block[data-for="settings"]`)
  ).append(skinPicker);
  app
    .querySelector(".set-toc")
    ?.insertAdjacentHTML(
      "beforeend",
      `<a href="#set-look">${t("settings.look")}</a>`,
    );
  skinPicker.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-skin]");
    if (!b) return;
    const skin = b.dataset.skin as Skin;
    save({ skin }).then((ok) => {
      if (!ok) return;
      void applySkin(skin).then(() => navigation.placeKey(false));
      lcd(
        t("studio.skinIs", { skin: SKINS.find((k) => k.id === skin)!.label }),
        2500,
      );
    });
  };

  return skinPicker;
}
