import "./styles/saved-actions.css";
import { t, dateLocale } from "./i18n.ts";
import { SpritePlayer } from "./player.ts";
import {
  savedActions,
  savedActionImage,
  useSavedAction,
  deleteSavedAction,
  type SavedAction,
} from "./savedActions.ts";
import { el } from "./studioDom.ts";
import type { StudioContext } from "./studioContext.ts";

/** One saved collection per selected pet; selecting only changes the named action. */
export function mountSavedActions(c: StudioContext) {
  const dialog = document.createElement("dialog");
  dialog.className = "saved-actions-dialog";
  dialog.setAttribute("aria-label", t("archive.title"));
  dialog.innerHTML = `<header><h2>${t("archive.title")}</h2><button type="button" data-saved-close>${t("archive.close")}</button></header><p class="saved-note">${t("archive.note")}</p><label class="saved-filter"><span>${t("studio.actions")}</span><select data-saved-filter></select></label><div class="saved-layout"><div class="saved-list" data-saved-list></div><section class="saved-detail"><canvas data-saved-canvas></canvas><p data-saved-name>${t("archive.choose")}</p><button type="button" data-saved-pause>${t("archive.pause")}</button></section></div><section class="saved-confirm" hidden><strong>${t("archive.deleteTitle")}</strong><p>${t("archive.deleteNote")}</p><button type="button" data-saved-confirm>${t("archive.delete")}</button><button type="button" data-saved-cancel>${t("archive.cancel")}</button></section>`;
  c.app.append(dialog);
  const get = <T extends HTMLElement>(q: string) => dialog.querySelector<T>(q)!;
  const list = get(".saved-list"),
    filter = get<HTMLSelectElement>("[data-saved-filter]");
  const player = new SpritePlayer(
    get<HTMLCanvasElement>("[data-saved-canvas]"),
  );
  player.setActive(false);
  let pet: string | null = null,
    items: SavedAction[] = [],
    selected: string | null = null,
    pending: string | null = null,
    revision = 0,
    session = 0;
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        observer.unobserve(entry.target);
        const canvas = entry.target as HTMLCanvasElement;
        const id = canvas.dataset.savedImage!;
        void savedActionImage(pet!, id)
          .then(c.image)
          .then((img) => {
            if (canvas.isConnected) c.drawCell(canvas, img, 0, 0);
          })
          .catch(() => {});
      }
    },
    { root: list },
  );
  async function preview(item: SavedAction) {
    const token = ++revision;
    selected = item.id;
    const url = await savedActionImage(pet!, item.id);
    if (token !== revision || !dialog.open) return;
    player.removeClipsExcept([]);
    await player.addClips({ "saved-preview": { ...item.action, url } });
    if (token !== revision) return;
    player.setActive(true);
    player.play("saved-preview", false);
    get("[data-saved-name]").textContent = item.action.label;
    for (const row of list.querySelectorAll<HTMLElement>(".saved-row"))
      row.classList.toggle("selected", row.dataset.savedId === item.id);
  }
  function draw() {
    observer.disconnect();
    list.replaceChildren();
    const shown = items.filter((i) => !filter.value || i.name === filter.value);
    if (!shown.length) list.append(el("p", "saved-note", t("archive.empty")));
    for (const item of shown) {
      const row = el("article", "saved-row");
      row.dataset.savedId = item.id;
      row.classList.toggle("selected", selected === item.id);
      const canvas = el("canvas");
      canvas.width = 96;
      canvas.height = 104;
      canvas.dataset.savedImage = item.id;
      const info = el("div", "saved-info");
      info.append(el("strong", "", item.action.label));
      const status = item.current
        ? t("archive.current")
        : item.original
          ? t("archive.original")
          : item.used
            ? t("archive.used")
            : t("archive.unused");
      info.append(el("span", "saved-status", status));
      if (item.summary) info.append(el("small", "", item.summary));
      if (item.createdAt)
        info.append(
          el(
            "time",
            "",
            new Date(item.createdAt * 1000).toLocaleString(dateLocale),
          ),
        );
      const buttons = el("div", "saved-buttons");
      const see = el("button", "", t("archive.preview"));
      see.type = "button";
      see.onclick = () => void c.attempt(() => preview(item));
      const use = el(
        "button",
        "",
        item.current ? t("archive.current") : t("archive.use"),
      );
      use.type = "button";
      use.disabled = item.current;
      use.onclick = () =>
        void c.attempt(async () => {
          await useSavedAction(pet!, item.id);
          c.lcd(t("archive.selected"));
          await refresh();
        });
      const remove = el("button", "saved-delete", t("archive.delete"));
      remove.type = "button";
      remove.disabled = item.current;
      remove.title = item.current
        ? t("archive.switchFirst")
        : t("archive.delete");
      remove.onclick = () => {
        pending = item.id;
        get(".saved-confirm").hidden = false;
        get("[data-saved-confirm]").focus();
      };
      buttons.append(see, use, remove);
      info.append(buttons);
      row.append(canvas, info);
      list.append(row);
      observer.observe(canvas);
    }
  }
  async function refresh() {
    if (!pet) return;
    const chosen = filter.value;
    const currentPet = pet;
    const currentSession = session;
    const next = await savedActions(currentPet);
    if (!dialog.open || currentSession !== session || currentPet !== pet)
      return;
    items = next;
    filter.replaceChildren(new Option(t("archive.all"), ""));
    for (const [name, label] of new Map(
      items.map((i) => [i.name, i.action.label]),
    ))
      filter.add(new Option(label, name));
    if ([...filter.options].some((o) => o.value === chosen))
      filter.value = chosen;
    draw();
  }
  filter.onchange = draw;
  get("[data-saved-close]").onclick = () => dialog.close();
  get("[data-saved-pause]").onclick = () => player.setActive(false);
  get("[data-saved-cancel]").onclick = () => {
    pending = null;
    get(".saved-confirm").hidden = true;
  };
  get("[data-saved-confirm]").onclick = () =>
    void c.attempt(async () => {
      if (!pet || !pending) return;
      const id = pending;
      await deleteSavedAction(pet, id);
      pending = null;
      get(".saved-confirm").hidden = true;
      if (selected === id) {
        revision++;
        player.setActive(false);
        selected = null;
        get("[data-saved-name]").textContent = t("archive.choose");
      }
      c.lcd(t("archive.deleted"));
      await refresh();
    });
  dialog.addEventListener("close", () => {
    revision++;
    session++;
    player.setActive(false);
    // Opening loads the pet again; closed, the sheet is not kept.
    player.unload();
    observer.disconnect();
  });
  return async () => {
    const p = c.selected();
    if (!p) return;
    session++;
    pet = p.id;
    dialog.querySelector("h2")!.textContent =
      `${t("archive.title")} · ${p.displayName}`;
    selected = null;
    items = [];
    list.replaceChildren();
    get("[data-saved-name]").textContent = t("archive.choose");
    get<HTMLCanvasElement>("[data-saved-canvas]")
      .getContext("2d")!
      .clearRect(0, 0, 384, 416);
    pending = null;
    filter.value = "";
    get(".saved-confirm").hidden = true;
    await player.load(
      await import("./bridge.ts").then((api) => api.sprite(p.id)),
    );
    player.setActive(false);
    dialog.showModal();
    await refresh();
  };
}
