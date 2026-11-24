import { applyTheme, resolveTheme, type ThemeMode } from "./theme.ts";
import { applySkin, normalizeSkin, type Skin } from "./skin.ts";
import * as api from "./bridge.ts";
import type { mountStudioLighting } from "./studioLighting.ts";
import type { mountStudioStage } from "./studioStage.ts";
import type { mountStudioNavigation } from "./studioNavigation.ts";
import type { mountDraftReader } from "./studioDrafts.ts";
import type { companionPage } from "./companion.ts";
import type { StudioContext } from "./studioContext.ts";

export async function mountStudioPreview(
  c: StudioContext,
  parts: {
    lighting: ReturnType<typeof mountStudioLighting>;
    stageView: ReturnType<typeof mountStudioStage>;
    navigation: ReturnType<typeof mountStudioNavigation>;
    draftReader: ReturnType<typeof mountDraftReader>;
    openCompanion: ReturnType<typeof companionPage>;
  },
) {
  const { app, state, darkQuery, save } = c;
  const { lighting, navigation, draftReader, openCompanion } = parts;
  const { lights } = lighting;
  const { petArrived } = parts.stageView;
  const fixtures = await import("./fixtures.ts");
  let pending = Promise.resolve();
  const track = (p: Promise<unknown>) => (pending = p.then(() => undefined));
  Object.assign(window, {
    __studio: {
      block: navigation.select,
      skin: async (next: Skin) => {
        await save({ skin: normalizeSkin(next) });
        await applySkin(normalizeSkin(next));
      },
      companion: openCompanion,
      load(name: string) {
        draftReader.markSeen(fixtures.FIXTURES[name].drafts);
        const sample = fixtures.FIXTURES[name];
        api.setBrowserState(
          {
            ...sample,
            settings: {
              ...sample.settings,
              skin: state.snapshot.settings.skin,
              theme: state.snapshot.settings.theme,
            },
          },
          fixtures.VERSION_LAYERS,
        );
      },
      theme(mode: ThemeMode) {
        state.snapshot.settings.theme = mode;
        track(applyTheme(resolveTheme(mode, darkQuery.matches), lights));
        api.setBrowserState({
          ...api.browserSnapshot(),
          settings: { ...state.snapshot.settings, theme: mode },
        });
      },
      sunAt(hour: number) {
        lighting.setSunHour(hour);
      },
      arrive() {
        const s = api.browserSnapshot();
        api.setBrowserState({ ...s, drafts: [fixtures.DRAFT] });
      },
      deliver() {
        api.setBrowserState({
          ...fixtures.FIXTURES.fresh,
          settings: {
            ...fixtures.FIXTURES.fresh.settings,
            theme: state.snapshot.settings.theme,
          },
        });
        petArrived({ name: "栗子", updated: false });
      },
      accept() {
        const card = app.querySelector<HTMLElement>(".card");
        const d = state.snapshot.drafts[0];
        if (card && d) draftReader.accept(d, card);
      },
      ready: () => pending.then(() => new Promise((r) => setTimeout(r, 300))),
    },
  });
}
