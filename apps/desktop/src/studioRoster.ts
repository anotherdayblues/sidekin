import { t } from "./i18n.ts";
import { showSkillPrompt } from "./skillPromptPopup.ts";
import { squish } from "./spring.ts";
import { el } from "./studioDom.ts";
import * as api from "./bridge.ts";
import type { mountStudioPopovers } from "./studioPopovers.ts";
import type { StudioContext } from "./studioContext.ts";

export function mountStudioRoster(
  c: StudioContext,
  menus: ReturnType<typeof mountStudioPopovers>,
  petMenu: (p: api.Pet, anchor: HTMLElement) => void,
) {
  const { $, state, selected, save, lcd, attempt, thumb, drawCell } = c;
  const { closePop, openPop } = menus;
  $("#add").onclick = () => {
    const make = el("button", "pop-item", t("studio.makePetMenu")),
      pkg = el("button", "pop-item", t("studio.importPkg")),
      folder = el("button", "pop-item", t("studio.importFolder")),
      demo = el("button", "pop-item", t("studio.meetLizi"));
    make.onclick = () =>
      askAgent(
        $("#add"),
        t("studio.makePet"),
        "make-desktop-pet",
        t("studio.makePetAsk"),
        t("studio.makePetHint"),
      );
    pkg.onclick = () => importFrom(false);
    folder.onclick = () => importFrom(true);
    demo.onclick = () => {
      closePop();
      attempt(() => api.demo());
    };
    openPop($("#add"), [make, pkg, folder, demo]);
  };
  function importFrom(folder: boolean) {
    closePop();
    attempt(async () => {
      const r = await api.importPackage(folder);
      if (r && "draft" in r)
        lcd(t("studio.gotTrick", { summary: r.draft.summary }));
      else if (r)
        lcd(r.updated ? t("studio.petUpdated") : t("studio.petArrived"));
    });
  }
  function askAgent(
    anchor: HTMLElement,
    title: string,
    skill: string,
    sentence: string,
    hint: string,
  ) {
    showSkillPrompt(anchor, title, skill, sentence, hint, menus, lcd);
  }

  c.app.addEventListener("click", (e) => {
    const button = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-find-tool]",
    );
    if (button)
      askAgent(
        button,
        t("studio.findTool"),
        "find-pet-tool",
        t("studio.findToolAsk"),
        t("studio.findToolHint"),
      );
  });
  $("#teach").onclick = () => {
    const p = selected();
    if (!p) return lcd(t("studio.importFirst"));
    askAgent(
      $("#teach"),
      t("studio.teachTitle", { name: p.displayName }),
      "teach-desktop-pet",
      t("studio.teachAsk", { name: p.displayName, id: p.id }),
      t("studio.teachHint"),
    );
  };

  // ---------- roster ----------
  async function renderRoster() {
    const roster = $("#roster");
    roster.replaceChildren();
    for (const p of state.snapshot.pets) {
      const b = el("button", "pet-tile");
      b.setAttribute("aria-label", p.displayName);
      b.setAttribute(
        "aria-pressed",
        String(p.id === state.snapshot.settings.activeId),
      );
      const c = el("canvas");
      c.width = 96;
      c.height = 104;
      const name = el("span", "pet-tile-name", p.displayName);
      b.append(c, name);
      if (state.snapshot.drafts.some((d) => d.petId === p.id))
        b.append(el("span", "pet-tile-badge"));
      b.onclick = () => save({ activeId: p.id });
      b.oncontextmenu = (e) => {
        e.preventDefault();
        petMenu(p, b);
      };
      squish(b, 0.05);
      roster.append(b);
      thumb(p).then((img) => drawCell(c, img, 0, 0));
    }
  }

  $("#meet").onclick = () => attempt(() => api.demo());

  return { renderRoster };
}
