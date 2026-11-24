import { t } from "./i18n.ts";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { getCurrentWebviewWindow } from "@tauri-apps/api/webviewWindow";
import { changes, state } from "./bridge.ts";
import { resolveTheme } from "./theme.ts";
// Two skins share one structure (plan/11-界面重做/02-交互和分区.md):
// 系统原生, the default, and 精密玩具. Only the active skin's sheet is
// fetched; each is laid on the base stylesheet, its rules kept to its own
// data-skin so one never changes the other.
// 宠物的房间 and 老游戏 were retired in plan/29: a skin that changes the
// layout costs every new page twice.
export type Skin = "studio" | "native";
export const SKINS: { id: Skin; label: string; note: string }[] = [
  {
    id: "native",
    label: t("skin.native"),
    note: t("skin.nativeNote"),
  },
  {
    id: "studio",
    label: t("skin.studio"),
    note: t("skin.studioNote"),
  },
];
// Layout after materials: it re-places the shared structure.
const loadNative = () =>
  import("./skins/native.css").then(() => import("./skins/native-layout.css"));
const loadStudio = () => import("./skins/studio.css");
/** 精密玩具 when chosen; anything else, retired skins included, is native. */
export function normalizeSkin(value: unknown): Skin {
  return value === "studio" ? "studio" : "native";
}
let current: Skin | null = null;
let revision = 0;
// 系统原生 asks the system for real window material (Liquid Glass, Mica) in
// the windows that have a background of their own. The page goes transparent
// only once the system says the material is on.
let materialWatched = false;
function watchMaterial() {
  if (materialWatched || !isTauri()) return;
  if (
    !["studio", "chat", "clock", "bubble"].includes(
      getCurrentWebviewWindow().label,
    )
  )
    return;
  materialWatched = true;
  const root = document.documentElement;
  let asked = "";
  const sync = async () => {
    const on =
        root.dataset.skin === "native" &&
        (getCurrentWebviewWindow().label !== "bubble" ||
          root.classList.contains("clip-active")),
      dark = root.dataset.theme === "night",
      key = `${on}${dark}`;
    if (
      key === asked ||
      (asked === "" && !on && getCurrentWebviewWindow().label === "bubble")
    )
      return;
    asked = key;
    const applied = await invoke<boolean>("window_material", {
      on,
      dark,
    }).catch(() => false);
    if (applied) root.dataset.material = "on";
    else delete root.dataset.material;
    // On a Mac this skin puts content under the title bar (window_material),
    // so the sidebar top and the page header drag the window instead.
    const overlay = on && root.dataset.platform === "mac";
    for (const el of document.querySelectorAll("[data-titlebar]"))
      el.toggleAttribute("data-tauri-drag-region", overlay);
  };
  new MutationObserver(() => void sync()).observe(root, {
    attributes: true,
    attributeFilter: ["data-skin", "data-theme", "class"],
  });
  void sync();
}
export async function applySkin(skin: Skin) {
  watchMaterial();
  const request = ++revision;
  if (skin === current) return;
  await (skin === "native" ? loadNative() : loadStudio());
  if (request !== revision) return;
  current = skin;
  document.documentElement.dataset.skin = skin;
}

// The bubble and selection overlay have separate webviews from the studio.
export async function watchWindowAppearance() {
  const dark = matchMedia("(prefers-color-scheme: dark)");
  let settings = (await state()).settings;
  const apply = () => {
    document.documentElement.dataset.theme = resolveTheme(
      settings.theme ?? "system",
      dark.matches,
    );
    return applySkin(normalizeSkin(settings.skin));
  };
  dark.addEventListener("change", () => void apply());
  await apply();
  await changes((s) => {
    settings = s.settings;
    void apply();
  });
}
