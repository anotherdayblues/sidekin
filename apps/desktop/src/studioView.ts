import { t } from "./i18n.ts";
import * as api from "./bridge.ts";
import { msUntilNextMinute } from "./openpets/runtime.ts";
import { normalizeSkin } from "./skin.ts";
import type { StudioContext } from "./studioContext.ts";
import type { mountStudioLighting } from "./studioLighting.ts";
import type { mountStudioControls } from "./studioControls.ts";
import type { mountStudioRoster } from "./studioRoster.ts";
import type { mountStudioStage } from "./studioStage.ts";
import type { mountStudioTape } from "./studioTape.ts";
import type { mountStudioWardrobe } from "./studioWardrobe.ts";
import type { mountDraftReader } from "./studioDrafts.ts";
import type { mountStudioDial } from "./studioDial.ts";
import type { mountStudioVersions } from "./studioVersions.ts";
import type { mountStudioNavigation } from "./studioNavigation.ts";

export function mountStudioView(
  c: StudioContext,
  parts: {
    lighting: ReturnType<typeof mountStudioLighting>;
    controls: ReturnType<typeof mountStudioControls>;
    roster: ReturnType<typeof mountStudioRoster>;
    stageView: ReturnType<typeof mountStudioStage>;
    tape: ReturnType<typeof mountStudioTape>;
    wardrobe: ReturnType<typeof mountStudioWardrobe>;
    draftReader: ReturnType<typeof mountDraftReader>;
    dial: ReturnType<typeof mountStudioDial>;
    versions: ReturnType<typeof mountStudioVersions>;
    navigation: ReturnType<typeof mountStudioNavigation>;
    skinPicker: HTMLElement;
  },
) {
  const { $, app, state, stage, player, selected, lcd, reducedQuery } = c;
  const { stageView, wardrobe, draftReader, navigation, skinPicker } = parts;
  const { syncTheme, themeMode } = parts.lighting;
  const { desk, motionSwitch, knob, knobMotion } = parts.controls;
  const { layoutStage, petArrived } = stageView;
  const { renderRoster } = parts.roster;
  const { renderTape } = parts.tape;
  const { renderDial } = parts.dial;
  const { renderVersions } = parts.versions;
  let receiptRevision = 0;
  let lastPetId: string | undefined;
  let minuteTimer: ReturnType<typeof setTimeout> | undefined;
  function renderReceiptPet(p: api.Pet | undefined) {
    const revision = ++receiptRevision;
    const canvases = [
      ...c.app.querySelectorAll<HTMLCanvasElement>(".receipt-pet"),
    ];
    for (const canvas of canvases) canvas.hidden = true;
    if (!p || !canvases.length) return;
    void c
      .thumb(p)
      .then((image) => {
        if (revision !== receiptRevision) return;
        for (const canvas of c.app.querySelectorAll<HTMLCanvasElement>(
          ".receipt-pet",
        )) {
          c.drawCell(canvas, image, 0, 0);
          canvas.setAttribute("aria-label", p.displayName);
          canvas.hidden = false;
        }
      })
      .catch(() => {});
  }
  // ---------- render ----------
  async function render(s: api.Snapshot) {
    state.snapshot = s;
    renderReceiptPet(selected());
    syncTheme();
    const short = {
      system: t("theme.system"),
      day: t("theme.day"),
      night: t("theme.night"),
      clock: t("theme.clock"),
    };
    const key = $("#theme-key");
    key.dataset.mode = themeMode() === "clock" ? "system" : themeMode();
    key.setAttribute(
      "aria-label",
      t("studio.themeKey", { mode: short[themeMode()] }),
    );
    key.title = t("studio.themeTitle", { mode: short[themeMode()] });
    const skin = normalizeSkin(s.settings.skin);
    if (
      !(await navigation.updateSkin(skin, () => state.snapshot === s)) ||
      state.snapshot !== s
    )
      return;
    for (const c of skinPicker.querySelectorAll<HTMLElement>("[data-skin]"))
      c.setAttribute("aria-pressed", String(c.dataset.skin === skin));
    const p = selected();
    if (p?.id !== lastPetId) {
      lastPetId = p?.id;
      app.dispatchEvent(new CustomEvent("pet-changed", { detail: p?.id ?? "" }));
    }
    app.querySelector(".studio")!.classList.toggle("is-empty", !p);
    $("#empty").hidden = !!p;
    stage.hidden = !p;
    layoutStage();
    // Not while the name is being typed (studioRename.ts).
    if (!$("#name").isContentEditable)
      $("#name").textContent = p?.displayName ?? t("app.name");
    $("#name").toggleAttribute("data-renamable", !!p);
    $("#desc").textContent = p?.description ?? t("studio.defaultDesc");
    for (const id of ["#desk", "#motion", "#teach"])
      $<HTMLButtonElement>(id).disabled = !p;
    desk.checked = s.settings.visible && !!p;
    motionSwitch.checked = !s.settings.paused;
    knobMotion.to(s.settings.size);
    knob.setAttribute("aria-valuenow", String(s.settings.size));
    lcd();
    renderRoster();
    wardrobe.render(p);
    if (p) {
      await stageView.renderPet(p);
      if (state.snapshot !== s) return;
      renderTape(p);
    } else {
      $("#actions").replaceChildren();
    }
    draftReader.render(p);
    renderDial(p);
    renderVersions(p);
    player.setReducedMotion(s.settings.paused || reducedQuery.matches);
    player.setActive(!document.hidden);
  }
  c.restore = () => render(state.snapshot);
  function armMinuteTick() {
    clearTimeout(minuteTimer);
    minuteTimer = setTimeout(() => {
      renderDial(selected());
      armMinuteTick();
    }, msUntilNextMinute(new Date()));
  }
  async function start() {
    await api.settingsErrors((message) => {
      void render(state.snapshot).then(() => lcd(message, 9000));
    });
    armMinuteTick();
    document.addEventListener("visibilitychange", () =>
      player.setActive(!document.hidden),
    );
    api.inboxEvents({
      pet: petArrived,
      draft: (summary) => lcd(t("studio.gotTrick", { summary }), 9000),
      failed: (error) => lcd(t("studio.badPackage", { error }), 12000),
    });
    await api.changes((s) => {
      render(s).catch((e) => lcd(String(e), 9000));
    });
    await render(state.snapshot);
  }
  return { start };
}
