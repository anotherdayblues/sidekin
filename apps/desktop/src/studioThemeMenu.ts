// The appearance key: a click opens a short menu of every choice with the
// current one ticked (macOS 外观, Windows 选择模式, and the theme menus of Arc
// and Slack), rather than stepping through them one click at a time.
import { t } from "./i18n.ts";
import { el } from "./studioDom.ts";
import { THEME_MODES } from "./theme.ts";
import type { StudioContext } from "./studioContext.ts";
import type { mountStudioLighting } from "./studioLighting.ts";
import type { mountStudioPopovers } from "./studioPopovers.ts";

/** 白天, 晚上, 跟随系统, as macOS and Windows offer them. 跟随时间 is no
 * longer offered; an old setting of it still works until changed. */
const ORDER = ["day", "night", "system"] as const;

export function mountThemeMenu(
  c: StudioContext,
  lighting: ReturnType<typeof mountStudioLighting>,
  menus: ReturnType<typeof mountStudioPopovers>,
) {
  const key = c.$("#theme-key");
  key.setAttribute("aria-haspopup", "menu");
  key.onclick = () => {
    const now = lighting.themeMode();
    const items = ORDER.map((mode) => {
      const label = THEME_MODES.find((m) => m.mode === mode)!.label;
      const b = el("button", "pop-item", label);
      b.dataset.theme = mode;
      b.setAttribute("role", "menuitemradio");
      b.setAttribute("aria-checked", String(mode === now));
      b.onclick = () => {
        menus.closePop();
        lighting.pickTheme(mode);
      };
      return b;
    });
    const menu = el("div", "theme-menu");
    menu.setAttribute("role", "menu");
    menu.setAttribute("aria-label", t("settings.look"));
    menu.append(...items);
    menus.openPop(key, [menu]);
    c.$("#pop").dataset.kind = "theme";
    items.find((b) => b.dataset.theme === now)?.focus();
  };
}
