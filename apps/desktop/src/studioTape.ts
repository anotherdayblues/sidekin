import { t } from "./i18n.ts";
import { ANIMATIONS, type Action } from "./animation.ts";
import { actionLabel, type Layer } from "./teaching.ts";
import { BASE, isLearned, learnedNames, oldRules } from "./actionPlan.ts";
import { mountActionSettings } from "./studioActionSettings.ts";
import { glyphs } from "./icons.ts";
import { squish } from "./spring.ts";
import { el } from "./studioDom.ts";
import { CELL_W, CELL_H } from "./studioContext.ts";
import { activityClipName } from "./openpets/runtime.ts";
import * as api from "./bridge.ts";
import type { mountStudioStage } from "./studioStage.ts";
import type { mountStudioPopovers } from "./studioPopovers.ts";
import type { StudioContext } from "./studioContext.ts";

export function mountStudioTape(
  c: StudioContext,
  stageView: ReturnType<typeof mountStudioStage>,
  menus: ReturnType<typeof mountStudioPopovers>,
) {
  const { $, app, custom, selected, sprite, drawCell, reducedQuery, player } =
    c;
  const { play, clipImages, clipFrames, caption } = stageView;
  const settings = mountActionSettings(c, menus, stageView);
  /**
   * Where the pet actually is in an action, across all its frames (in cell
   * pixels). Sprites sit at different heights and widths inside their cells,
   * so drawing whole cells left the thumbnails uneven: some high, some low.
   */
  const rowBoxes = new WeakMap<
    HTMLImageElement,
    Map<number, { x: number; y: number; w: number; h: number }>
  >();
  function rowBox(img: HTMLImageElement, row: number, frames: number) {
    const cache = rowBoxes.get(img) ?? new Map();
    rowBoxes.set(img, cache);
    if (cache.has(row)) return cache.get(row)!;
    const k = 4,
      w = CELL_W / k,
      h = CELL_H / k,
      c = document.createElement("canvas");
    c.width = w * frames;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(
      img,
      0,
      row * CELL_H,
      CELL_W * frames,
      CELL_H,
      0,
      0,
      w * frames,
      h,
    );
    const data = ctx.getImageData(0, 0, w * frames, h).data;
    let x0 = w,
      y0 = h,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w * frames; x++)
        if (data[(y * w * frames + x) * 4 + 3] > 24) {
          const cx = x % w;
          if (cx < x0) x0 = cx;
          if (cx > x1) x1 = cx;
          if (y < y0) y0 = y;
          if (y > y1) y1 = y;
        }
    const box =
      x1 < 0
        ? { x: 0, y: 0, w: CELL_W, h: CELL_H }
        : { x: x0 * k, y: y0 * k, w: (x1 - x0 + 1) * k, h: (y1 - y0 + 1) * k };
    cache.set(row, box);
    return box;
  }
  /** Draw a frame so every tile's pet stands centred on the same floor line. */
  function drawFitted(
    canvas: HTMLCanvasElement,
    img: HTMLImageElement,
    row: number,
    frame: number,
    box: { x: number; y: number; w: number; h: number },
  ) {
    const cw = canvas.width,
      ch = canvas.height,
      floor = ch - 6;
    const s = Math.min(0.62, (cw * 0.92) / box.w, (ch * 0.9) / box.h);
    const ctx = canvas.getContext("2d")!;
    ctx.clearRect(0, 0, cw, ch);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(
      img,
      frame * CELL_W,
      row * CELL_H,
      CELL_W,
      CELL_H,
      (cw - box.w * s) / 2 - box.x * s,
      floor - (box.y + box.h) * s,
      CELL_W * s,
      CELL_H * s,
    );
  }
  /** The frame that differs most from the first one: the action's key pose. */
  const keyPoses = new WeakMap<HTMLImageElement, Map<number, number>>();
  function keyPose(img: HTMLImageElement, row: number, frames: number) {
    const cache = keyPoses.get(img) ?? new Map<number, number>();
    keyPoses.set(img, cache);
    if (cache.has(row)) return cache.get(row)!;
    const w = 48,
      h = 52,
      c = document.createElement("canvas");
    c.width = w * frames;
    c.height = h;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(
      img,
      0,
      row * CELL_H,
      CELL_W * frames,
      CELL_H,
      0,
      0,
      w * frames,
      h,
    );
    const data = ctx.getImageData(0, 0, w * frames, h).data;
    let best = 0,
      most = -1;
    for (let f = 1; f < frames; f++) {
      let diff = 0,
        ink = 0;
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          const a = (y * w * frames + x) * 4,
            b = a + f * w * 4;
          if (data[b + 3] > 24) ink++;
          diff +=
            Math.abs(data[a + 3] - data[b + 3]) + Math.abs(data[a] - data[b]);
        }
      if (ink > 0 && diff > most) [most, best] = [diff, f];
    }
    cache.set(row, best);
    return best;
  }

  // ---------- action tape ----------
  function markTape(name: string) {
    for (const t of app.querySelectorAll<HTMLElement>(".tape-tile"))
      t.classList.toggle("playing", t.dataset.action === name);
  }
  // A mouse wheel scrolls up and down; on this sideways strip it moves the
  // strip instead, so the actions can be browsed without a trackpad.
  const strip = $("#actions");
  strip.addEventListener(
    "wheel",
    (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return;
      if (strip.scrollWidth <= strip.clientWidth) return;
      e.preventDefault();
      strip.scrollLeft += e.deltaY;
    },
    { passive: false },
  );
  // ‹ › at the head when the actions run past the edge, as the App Store's
  // shelves have: a trackpad swipe shows nothing, and a mouse may have no
  // wheel. A page is what can be seen, less one tile so the eye keeps its
  // place.
  const pager = $("#tape-pager");
  const pages = [...pager.querySelectorAll<HTMLButtonElement>(".tape-page")];
  function syncPager() {
    const over = strip.scrollWidth - strip.clientWidth;
    pager.hidden = over <= 1;
    pages[0].disabled = strip.scrollLeft <= 1;
    pages[1].disabled = strip.scrollLeft >= over - 1;
    strip.dataset.more = String(!pages[1].disabled && over > 1);
  }
  for (const b of pages)
    b.onclick = () =>
      strip.scrollBy({
        left: Number(b.dataset.dir) * Math.max(80, strip.clientWidth - 86),
        behavior: reducedQuery.matches ? "auto" : "smooth",
      });
  strip.addEventListener("scroll", syncPager, { passive: true });
  new ResizeObserver(syncPager).observe(strip);
  // Two kinds of actions, apart from birth (plan/29): the pet's own, and
  // the ones it learned (including OpenPets pack activities).
  let group: "base" | "learned" = "base";
  const tabs = [
    ...app.querySelectorAll<HTMLButtonElement>(".tape-tabs [role=tab]"),
  ];
  const activityFallbackImages = new Map<string, Promise<HTMLImageElement>>();
  function fallbackActivityImage(p: api.Pet, act: api.PetActivity) {
    const key = `${p.id}:${p.fingerprint}:${act.spritesheetPath}`;
    let cached = activityFallbackImages.get(key);
    if (!cached) {
      cached = api.petAsset(p.id, act.spritesheetPath).then(c.image);
      cached.catch(() => activityFallbackImages.delete(key));
      activityFallbackImages.set(key, cached);
    }
    return cached;
  }
  function openActivitySettings(
    p: api.Pet,
    act: api.PetActivity,
    anchor: HTMLElement,
  ) {
    const activities = p.activities ?? [];
    const wornId = c.wornOutfit(p);
    const matched = api.resolvePetActivityAnimation(act, wornId);
    const enabledList = api.enabledActivityIds(
      p,
      c.state.snapshot.settings.petActivityPreferences,
    );
    const enabled = enabledList.includes(act.id);

    const nodes: HTMLElement[] = [el("strong", "pop-title", act.displayName)];
    if (!matched) {
      nodes.push(el("p", "act-lead", t("activities.unavailableForOutfit")));
    }

    const row = el("label", "act-row");
    const nameEl = el("span", "act-name", t("activities.autoPlay"));
    const input = el("input", "slide-switch");
    input.type = "checkbox";
    input.setAttribute("role", "switch");
    input.checked = enabled;
    input.setAttribute(
      "aria-label",
      t("activities.toggleAria", { name: act.displayName }),
    );
    input.onchange = () => {
      const currentEnabled = api.enabledActivityIds(
        p,
        c.state.snapshot.settings.petActivityPreferences,
      );
      const nextIds = api.updateEnabledPetActivityIds(
        activities,
        currentEnabled,
        act.id,
        input.checked,
      );
      const payload =
        nextIds.length === activities.length ? null : [...nextIds];
      void c.attempt(() => api.setPetActivityPref(p.id, payload));
    };
    row.append(
      nameEl,
      input,
      el("span", "act-hint", t("activities.autoPlayHint")),
    );
    nodes.push(row);

    const foot = el("div", "act-foot");
    const playBtn = el("button", "activity-play", t("activities.play"));
    playBtn.type = "button";
    playBtn.disabled = !matched;
    playBtn.title = matched
      ? t("activities.playAria", { name: act.displayName })
      : t("activities.unavailableForOutfit");
    playBtn.onclick = () => {
      stageView.playActivity(act);
    };
    foot.append(playBtn);
    nodes.push(foot);

    menus.openPop(anchor, nodes, { kind: "action" });
  }
  for (const tab of tabs)
    tab.onclick = () => {
      group = tab.dataset.group as typeof group;
      strip.scrollLeft = 0;
      const p = selected();
      if (p) void renderTape(p);
    };
  const hasSleep = (p: api.Pet, layer: Layer) => {
    const outfit = c.wornOutfit(p);
    const wornSleep =
      outfit !== api.defaultOutfitId
        ? p.wardrobe?.outfits.find((o) => o.id === outfit)?.sleepStrip
        : undefined;
    return !!layer.actions.sleep || !!wornSleep || !!p.sleepStrip || p.id === "lizi";
  };
  function label(name: string, layer: Layer) {
    return name === "sleep" && !layer.actions.sleep
      ? t("pet.sleep")
      : actionLabel(name, layer);
  }
  let tapeToken = 0;
  async function renderTape(p: api.Pet) {
    const layer = custom(p).layer,
      tape = $("#actions"),
      base: string[] = [
        BASE[0],
        ...(hasSleep(p, layer) ? ["sleep"] : []),
        ...BASE.slice(1),
      ],
      learned = learnedNames(layer),
      activities = p.activities ?? [],
      names = group === "base" ? base : learned;
    $("#base-count").textContent = String(base.length);
    $("#learned-count").textContent = String(learned.length + activities.length);
    for (const tab of tabs)
      tab.setAttribute("aria-selected", String(tab.dataset.group === group));
    tape.dataset.group = group;
    const tools = $("#tape-tools");
    tools.replaceChildren();
    if (group === "learned") {
      const old = oldRules(layer).length;
      if (old) {
        const b = el(
          "button",
          "tape-old pop-anchor",
          t("act.oldCount", { n: old }),
        );
        b.type = "button";
        b.onclick = () => settings.old(p, b);
        tools.append(b);
      }
    }
    // Only the latest render may fill the tape.
    const token = ++tapeToken;
    const sheet = await sprite(p);
    if (token !== tapeToken) return;
    tape.replaceChildren();
    const showActivities = group === "learned" && activities.length > 0;
    if (!names.length && !showActivities)
      tape.append(el("p", "tape-empty", t("act.learnedEmpty")));
    syncPager();
    for (const name of names) {
      const clip = name in layer.actions || !(name in ANIMATIONS);
      const item = el("div", "tape-item");
      item.dataset.action = name;
      const tile = el("button", "tape-tile");
      tile.dataset.action = name;
      const thumb = el("canvas");
      thumb.width = 96;
      thumb.height = 104;
      const text = label(name, layer);
      tile.append(thumb, el("span", "tape-label", text));
      tile.setAttribute("aria-label", text);
      item.append(tile);
      if (name === "sleep" || isLearned(name, layer)) {
        const key = el("button", "tape-set pop-anchor");
        key.type = "button";
        key.innerHTML = glyphs.tune;
        key.title = t("act.settings", { label: text });
        key.setAttribute("aria-label", key.title);
        key.setAttribute("aria-haspopup", "dialog");
        const openSettings = () =>
          name === "sleep"
            ? settings.sleep(p, key)
            : settings.learned(p, name, key);
        key.onclick = openSettings;
        tile.oncontextmenu = (e) => {
          e.preventDefault();
          openSettings();
        };
        item.append(key);
      }
      tape.append(item);
      syncPager();
      const frames = clip
        ? clipFrames.get(name)
        : ANIMATIONS[name as Action].durations;
      const imgPromise = clip ? clipImages.get(name) : Promise.resolve(sheet);
      const row = clip ? 0 : ANIMATIONS[name as Action].row;
      const img = await imgPromise?.catch(() => null);
      if (token !== tapeToken) return;
      if (!img || !frames) continue;
      const pose = keyPose(img, row, frames.length);
      const box = rowBox(img, row, frames.length);
      drawFitted(thumb, img, row, pose, box);
      // Hovering a tile previews the motion right in the thumbnail.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const run = (f: number) => {
        drawFitted(thumb, img, row, f, box);
        timer = setTimeout(() => run((f + 1) % frames.length), frames[f]);
      };
      item.onpointerenter = () => !reducedQuery.matches && run(0);
      item.onpointerleave = () => {
        clearTimeout(timer);
        drawFitted(thumb, img, row, pose, box);
      };
      // Played in the window; a learned one says under it when it plays.
      tile.onclick = () => {
        play(name);
        if (isLearned(name, layer) && !player.sustaining)
          caption(`${text} · ${settings.note(name, custom(p).layer)}`);
      };
      squish(tile, 0.04);
    }
    if (showActivities) {
      const wornId = c.wornOutfit(p);
      const enabledSet = new Set(
        api.enabledActivityIds(
          p,
          c.state.snapshot.settings.petActivityPreferences,
        ),
      );
      for (const act of activities) {
        const clipName = activityClipName(act.id);
        const matched = api.resolvePetActivityAnimation(act, wornId);
        const isEnabled = enabledSet.has(act.id);
        const item = el("div", "tape-item");
        item.dataset.action = clipName;
        if (!matched) item.classList.add("is-unavailable");
        if (!isEnabled) item.classList.add("is-muted");

        const tile = el("button", "tape-tile");
        tile.type = "button";
        tile.dataset.action = clipName;
        const thumb = el("canvas");
        thumb.width = 96;
        thumb.height = 104;
        tile.append(thumb, el("span", "tape-label", act.displayName));
        tile.setAttribute("aria-label", act.displayName);
        tile.title = matched
          ? t("activities.playAria", { name: act.displayName })
          : t("activities.unavailableForOutfit");
        item.append(tile);

        const key = el("button", "tape-set pop-anchor");
        key.type = "button";
        key.innerHTML = glyphs.tune;
        key.title = t("act.settings", { label: act.displayName });
        key.setAttribute("aria-label", key.title);
        key.setAttribute("aria-haspopup", "dialog");
        const openSettings = () => openActivitySettings(p, act, key);
        key.onclick = openSettings;
        tile.oncontextmenu = (e) => {
          e.preventDefault();
          openSettings();
        };
        item.append(key);

        tile.onclick = () => {
          if (matched) stageView.playActivity(act);
          else c.lcd(t("activities.unavailableForOutfit"), 4000);
        };
        squish(tile, 0.04);
        tape.append(item);
        syncPager();

        const frames = matched
          ? clipFrames.get(clipName)
          : Array.from({ length: act.frameCount }, () =>
              Math.max(1, Math.round(1000 / act.fps)),
            );
        const imgPromise = matched
          ? clipImages.get(clipName)
          : fallbackActivityImage(p, act);
        const img = await imgPromise?.catch(() => null);
        if (token !== tapeToken) return;
        if (!img || !frames) continue;
        const pose = keyPose(img, 0, frames.length);
        const box = rowBox(img, 0, frames.length);
        drawFitted(thumb, img, 0, pose, box);
        if (matched) {
          let timer: ReturnType<typeof setTimeout> | undefined;
          const run = (f: number) => {
            drawFitted(thumb, img, 0, f, box);
            timer = setTimeout(() => run((f + 1) % frames.length), frames[f]);
          };
          item.onpointerenter = () => !reducedQuery.matches && run(0);
          item.onpointerleave = () => {
            clearTimeout(timer);
            drawFitted(thumb, img, 0, pose, box);
          };
        }
      }
    }
  }

  function paintThumbnail(c: HTMLCanvasElement) {
    clipImages
      .get(c.dataset.clip!)
      ?.then((img) =>
        drawCell(c, img, 0, keyPose(img, 0, Number(c.dataset.frames))),
      );
  }

  return { markTape, renderTape, paintThumbnail };
}
