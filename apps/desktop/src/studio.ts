import { companionPage } from "./companion.ts";
import { mountDraftReader } from "./studioDrafts.ts";
import { mountStudioNavigation } from "./studioNavigation.ts";
import { squish } from "./spring.ts";
import * as api from "./bridge.ts";
import { TEMPLATE } from "./studioTemplate.ts";
import { createStudioContext } from "./studioContext.ts";
import { mountStudioLighting } from "./studioLighting.ts";
import { mountThemeMenu } from "./studioThemeMenu.ts";
import { mountStudioControls } from "./studioControls.ts";
import { mountStudioPopovers } from "./studioPopovers.ts";
import { mountStudioRoster } from "./studioRoster.ts";
import { mountStudioStage } from "./studioStage.ts";
import { mountStudioTape } from "./studioTape.ts";
import { mountStudioDial } from "./studioDial.ts";
import { mountStudioVersions } from "./studioVersions.ts";
import { mountPetMenu } from "./studioPetMenu.ts";
import { mountPetRename } from "./studioRename.ts";
import { mountStudioAppearance } from "./studioAppearance.ts";
import { mountStudioView } from "./studioView.ts";
import { mountStudioPreview } from "./studioPreview.ts";
import { mountSkillBook } from "./skillBook.ts";
import { mountFocusPage } from "./focusPage.ts";
import { keepStudio } from "./studioKeep.ts";
import { mountHomeWidgets } from "./homeWidgets.ts";

export async function mountStudio(app: HTMLElement) {
  app.innerHTML = TEMPLATE;
  const openCompanion = companionPage(app);
  const keep = keepStudio();
  const c = await createStudioContext(app);
  // Saves and other work count as running: the page is not let go then.
  const { attempt, save } = c;
  c.attempt = (fn) => keep.track(attempt(fn));
  c.save = (change) => keep.track(save(change));
  const lighting = mountStudioLighting(c, (value) =>
    stageView.shadow.to(value),
  );
  const controls = mountStudioControls(c, () => menus.closePop());
  const menus = mountStudioPopovers(c);
  const roster = mountStudioRoster(c, menus, (p, at) => petMenu.open(p, at));
  const stageView = mountStudioStage(c, (name) => tape.markTape(name));
  const tape = mountStudioTape(c, stageView, menus);
  const draftReader = mountDraftReader(app, {
    selected: c.selected,
    draftsFor: (p) => c.state.snapshot.drafts.filter((d) => d.petId === p.id),
    layerFor: (p) => c.custom(p).layer,
    onSelectionChanged: (p) => dial.renderDial(p),
    paintThumbnail: tape.paintThumbnail,
    hasClip: (n) => c.player.has(n),
    play: stageView.play,
    playSteps: stageView.playSteps,
    attempt: c.attempt,
    lcd: c.lcd,
  });
  const dial = mountStudioDial(c, draftReader);
  const versions = mountStudioVersions(c);
  const rename = mountPetRename(c);
  const petMenu = mountPetMenu(c, menus, rename.rename);
  const navigation = mountStudioNavigation(app, openCompanion);
  const skinPicker = mountStudioAppearance(c, navigation);
  mountThemeMenu(c, lighting, menus);
  const skillBook = mountSkillBook(app);
  mountFocusPage(app);
  for (const b of app.querySelectorAll<HTMLElement>(".key, .rail-key"))
    squish(b, 0.05);
  await mountStudioView(c, {
    lighting,
    controls,
    roster,
    stageView,
    tape,
    draftReader,
    dial,
    versions,
    navigation,
    skinPicker,
  }).start();
  // The side column as cards, 今天的待办 among them (plan/35).
  mountHomeWidgets(c, { go: navigation.select });
  if (api.native) {
    await navigation.restore();
    keep.ready();
  }
  if (!api.native) {
    await mountStudioPreview(c, {
      lighting,
      stageView,
      navigation,
      draftReader,
      openCompanion,
    });
    // Screenshot scripts open 它会的事 directly; expose after __studio is ready.
    Object.assign(window, { __skillBook: skillBook });
  }
}
