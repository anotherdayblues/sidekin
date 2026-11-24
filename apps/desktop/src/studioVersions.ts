import { t } from "./i18n.ts";
import { el } from "./studioDom.ts";
import { mountSavedActions } from "./studioSavedActions.ts";
import * as api from "./bridge.ts";
import type { StudioContext } from "./studioContext.ts";

/** 旧版动作: the saved drawings of every action, under the side panel. */
export function mountStudioVersions(c: StudioContext) {
  const { $, attempt } = c;
  const openSavedActions = mountSavedActions(c);
  function renderVersions(p: api.Pet | undefined) {
    const foot = $("#versions");
    foot.replaceChildren();
    if (!p) return;
    const log = el("button", "text-key", t("archive.title"));
    log.onclick = () => void attempt(openSavedActions);
    foot.append(log);
  }
  return { renderVersions };
}
