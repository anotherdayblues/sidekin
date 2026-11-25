import { t } from "./i18n.ts";
import { settingsGroup } from "./settingsGroup.ts";
import { applySkin, SKINS, type Skin } from "./skin.ts";
import type { mountStudioNavigation } from "./studioNavigation.ts";
import type { StudioContext } from "./studioContext.ts";

export function mountStudioAppearance(
  c: StudioContext,
  navigation: ReturnType<typeof mountStudioNavigation>,
) {
  const { $, app, save, lcd } = c;
  // ---------- skins ----------
  const look = settingsGroup("look", t("settings.look"), t("studio.skinNote"));
  const skinPicker = look.section;
  skinPicker.classList.add("skin-picker");
  look.card.innerHTML = `<div class="skin-cards">${SKINS.map(
    (k) =>
      `<button type="button" class="skin-card" data-skin="${k.id}" aria-pressed="false"><span class="skin-thumb skin-thumb-${k.id}" aria-hidden="true"><i></i><i></i><i></i></span><b>${k.label}</b><small>${k.note}</small></button>`,
  ).join("")}</div>`;
  const slot = app.querySelector('[data-settings-slot="look"]');
  if (slot) slot.replaceWith(skinPicker);
  else
    (
      app.querySelector('[data-settings-panel="general"]') ??
      app.querySelector("#companion-form") ??
      $(`.block[data-for="settings"]`)
    ).append(skinPicker);
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
