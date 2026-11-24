// ?demo=copy-translate&skin=studio&theme=night&platform=win: one demo on its
// own, for screenshots and for judging its feel in every skin.
import { defaults } from "../../../shared/companion.ts";
import * as api from "../bridge.ts";
import { applySkin, normalizeSkin } from "../skin.ts";
import { DEMOS, demoById, shortcutsOf } from "./index.ts";
import { mountDemo } from "./demoPlayer.ts";

export async function mountDemoPreview(
  app: HTMLElement,
  route: URLSearchParams,
) {
  const root = document.documentElement;
  root.dataset.theme = route.get("theme") === "night" ? "night" : "day";
  if (route.get("platform") === "win" || route.get("platform") === "mac")
    root.dataset.platform = route.get("platform")!;
  await applySkin(normalizeSkin(route.get("skin")));
  app.className = "demo-preview";
  await mountDemo(app, demoById(route.get("demo") ?? "") ?? DEMOS[0], {
    sprite: await api.sprite(""),
    example: api.exampleSprite,
    shortcuts: shortcutsOf(defaults),
  });
}
