import { t } from "./i18n.ts";
export interface SkillPaths {
  manifest: string;
  dataRoot: string;
  inbox: string;
}

export function skillPrompt(paths: SkillPaths, task: string) {
  return [
    t("skill.read", { manifest: paths.manifest }),
    t("skill.env", { dataRoot: paths.dataRoot, inbox: paths.inbox }),
    t("skill.guard"),
    task,
  ].join("\n");
}
