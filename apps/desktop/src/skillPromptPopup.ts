import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import { skillPrompt, type SkillPaths } from "./skillPrompt.ts";
import { el } from "./studioDom.ts";
import type { mountStudioPopovers } from "./studioPopovers.ts";

/** The same copy-to-AI dialog for making, teaching and editing a pet. */
export function showSkillPrompt(
  anchor: HTMLElement,
  title: string,
  skill: string,
  task: string,
  hint: string,
  menus: Pick<ReturnType<typeof mountStudioPopovers>, "openPop" | "closePop">,
  lcd: (message: string) => void,
) {
  const line = el("code", "pop-code", t("studio.findingSkill"));
  const copy = el("button", "key primary", t("studio.copyLine"));
  const content = [
    el("strong", "pop-title", title),
    el("p", "pop-lead", hint),
    line,
    copy,
  ];
  let text = "";
  copy.disabled = true;
  if (native) {
    void invoke<SkillPaths>("bundled_skill_paths", { name: skill })
      .then((paths) => {
        text = skillPrompt(paths, task);
        line.textContent = text;
        copy.disabled = false;
        if (line.isConnected && !line.closest<HTMLElement>(".pop")?.hidden)
          menus.openPop(anchor, content);
      })
      .catch((e) => {
        line.textContent = String(e);
      });
  } else line.textContent = t("studio.copyInApp");
  copy.onclick = () =>
    navigator.clipboard
      ?.writeText(text)
      .then(() => {
        menus.closePop();
        lcd(t("studio.copied"));
      })
      .catch(() => lcd(t("studio.copyManually")));
  menus.openPop(anchor, content);
}
