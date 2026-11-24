import { t } from "./i18n.ts";
import { SpritePlayer } from "./player.ts";
import { normalizeBehavior, type Behavior } from "./animation.ts";
import * as api from "./bridge.ts";
import { CELL_W, CELL_H, thumbnailImage } from "./petFace.ts";
export { CELL_W, CELL_H };

// One context per mounted studio; mutable component state stays in its own module.
export async function createStudioContext(app: HTMLElement) {
  const $ = <T extends HTMLElement = HTMLElement>(q: string) =>
    app.querySelector<T>(q)!;
  const stage = $<HTMLCanvasElement>("#stage");
  const player = new SpritePlayer(stage);
  const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
  const darkQuery = matchMedia("(prefers-color-scheme: dark)");
  const state = { snapshot: await api.state() };
  let lcdTimer: ReturnType<typeof setTimeout> | undefined;
  // The whole sheet only for the pet on show (the tape reads its rows);
  // every other pet keeps just its first cell, for the roster.
  let sheet: { key: string; image: Promise<HTMLImageElement> } | null = null;
  const thumbs = new Map<string, Promise<ImageBitmap>>();
  // ---------- small helpers ----------
  const image = (url: string) => {
    const img = new Image();
    img.src = url;
    return img.decode().then(() => img);
  };
  function sprite(p: api.Pet) {
    const key = `${p.id}:${p.fingerprint}`;
    if (sheet?.key !== key)
      sheet = { key, image: api.sprite(p.id).then(image) };
    return sheet.image;
  }
  /** The pet's first cell, the size it is drawn in the roster. */
  function thumb(p: api.Pet) {
    const key = `${p.id}:${p.fingerprint}`;
    let cell = thumbs.get(key);
    if (!cell) {
      cell = (
        sheet?.key === key ? sheet.image : thumbnailImage(p.id)
      ).then((img) => createImageBitmap(img, 0, 0, CELL_W, CELL_H));
      cell.catch(() => thumbs.delete(key));
      thumbs.set(key, cell);
    }
    return cell;
  }
  function drawCell(
    canvas: HTMLCanvasElement,
    img: CanvasImageSource,
    row: number,
    frame: number,
  ) {
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      img,
      frame * CELL_W,
      row * CELL_H,
      CELL_W,
      CELL_H,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }
  function selected() {
    return state.snapshot.pets.find(
      (p) => p.id === state.snapshot.settings.activeId,
    );
  }
  function custom(p = selected()): api.Custom {
    return (
      (p && state.snapshot.custom[p.id]) ?? {
        history: { current: 0, versions: [] },
        layer: { actions: {}, rules: [] },
      }
    );
  }
  function behavior(p = selected()): Behavior {
    return normalizeBehavior(
      state.snapshot.settings.behaviors[p?.id ?? ""] ?? p?.behavior,
    );
  }
  function lcd(text = "", hold = 6000) {
    clearTimeout(lcdTimer);
    const p = selected();
    const idle = p
      ? state.snapshot.settings.visible
        ? t("studio.onDesk")
        : t("studio.resting")
      : t("studio.waiting");
    $("#lcd").textContent = text || idle;
    $(".lcd").classList.toggle("lit", !!text);
    if (text) lcdTimer = setTimeout(() => lcd(), hold);
  }
  async function attempt(fn: () => Promise<unknown>) {
    try {
      await fn();
    } catch (e) {
      lcd(String(e).replace(/^Error: /, ""), 9000);
    }
  }
  let saves = Promise.resolve();
  function save(
    change:
      | Partial<api.Settings>
      | ((current: api.Settings) => Partial<api.Settings>),
  ): Promise<boolean> {
    const run = saves.then(async () => {
      lcd(t("settings.saving"));
      try {
        const latest = await api.readSettings();
        const patch = typeof change === "function" ? change(latest) : change;
        await api.save({ ...latest, ...patch });
        return true;
      } catch (e) {
        await context.restore().catch(() => {});
        lcd(String(e).replace(/^Error: /, ""), 9000);
        return false;
      }
    });
    saves = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  const context = {
    restore: async (): Promise<void> => {},
    app,
    $,
    stage,
    player,
    reducedQuery,
    darkQuery,
    state,
    image,
    sprite,
    thumb,
    drawCell,
    selected,
    custom,
    behavior,
    lcd,
    attempt,
    save,
  };
  return context;
}
export type StudioContext = Awaited<ReturnType<typeof createStudioContext>>;
