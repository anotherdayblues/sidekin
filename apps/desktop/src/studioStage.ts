import { t } from "./i18n.ts";
import { ANIMATIONS, GAZE_ACTIONS } from "./animation.ts";
import { actionLabel, EMPTY_LAYER, type Step } from "./teaching.ts";
import { Motion } from "./spring.ts";
import { CELL_W, CELL_H } from "./studioContext.ts";
import * as api from "./bridge.ts";
import sleepExample from "../../../examples/lizi-sleep/teaching.json";
import type { StudioContext } from "./studioContext.ts";

export function mountStudioStage(
  c: StudioContext,
  markTape: (name: string) => void,
) {
  const {
    $,
    state,
    stage,
    player,
    selected,
    custom,
    behavior,
    lcd,
    attempt,
    image,
  } = c;
  let loaded = "",
    clipsKey = "";
  const clipImages = new Map<string, Promise<HTMLImageElement>>();
  /** Frame lengths of each loaded clip, for the tape's thumbnails. */
  const clipFrames = new Map<string, number[]>();
  // ---------- stage ----------
  const windowEl = $("#window");
  let floor = { x: 0.5, y: 0.9, w: 0.5 };
  async function measureFloor(img: HTMLImageElement) {
    // The idle frame's visible pixels tell where this pet stands and how
    // wide it is, so the contact shadow fits any character.
    const c = document.createElement("canvas");
    c.width = CELL_W;
    c.height = CELL_H;
    const ctx = c.getContext("2d", { willReadFrequently: true })!;
    ctx.drawImage(img, 0, 0, CELL_W, CELL_H, 0, 0, CELL_W, CELL_H);
    const data = ctx.getImageData(0, 0, CELL_W, CELL_H).data;
    let x0 = CELL_W,
      x1 = 0,
      y1 = 0;
    for (let y = 0; y < CELL_H; y++)
      for (let x = 0; x < CELL_W; x++)
        if (data[(y * CELL_W + x) * 4 + 3] > 40) {
          x0 = Math.min(x0, x);
          x1 = Math.max(x1, x);
          y1 = Math.max(y1, y);
        }
    if (x1 > x0)
      floor = {
        x: (x0 + x1) / 2 / CELL_W,
        y: y1 / CELL_H,
        w: (x1 - x0) / CELL_W,
      };
    layoutStage();
  }
  function layoutStage() {
    // Layout boxes, not transformed ones: a pet mid-drop must not move
    // the floor that the light and the contact shadow are drawn on.
    const w = stage.offsetWidth,
      h = stage.offsetHeight,
      left = stage.offsetLeft - w / 2,
      top = stage.offsetTop;
    // No pet on stage: keep the default floor line for light and shadow.
    if (!h || stage.hidden)
      return void windowEl.style.removeProperty("--floor");
    const ped = $("#pedestal");
    ped.style.left = `${left + floor.x * w}px`;
    ped.style.top = `${top + floor.y * h}px`;
    ped.style.width = `${floor.w * w}px`;
    windowEl.style.setProperty(
      "--floor",
      `${((top + floor.y * h) / windowEl.clientHeight) * 100}%`,
    );
  }
  new ResizeObserver(layoutStage).observe(windowEl);
  // A newly delivered pet drops into the window and lands on the floor:
  // gravity-like pull from above, a small bounce, then it says hello.
  const drop = new Motion(
    0,
    (v) => stage.style.setProperty("--drop", `${v.toFixed(1)}px`),
    { stiffness: 230, damping: 14 },
  );
  let landing = false;
  function land() {
    landing = false;
    drop.set(-windowEl.clientHeight * 0.7);
    drop.to(0, 900);
    setTimeout(() => play("waving", false), 650);
  }
  function petArrived(arrival: { name: string; updated: boolean }) {
    lcd(
      arrival.updated
        ? t("studio.arrivalUpdated", { name: arrival.name })
        : t("studio.arrivalNew", { name: arrival.name }),
      9000,
    );
    const p = selected();
    // The sprite may still be loading; render() lands it once it is ready.
    if (p && loaded === `${p.id}:${p.fingerprint}`) land();
    else landing = true;
  }
  // Night: the cursor acts as a second lamp, so the cast shadow falls away
  // from it. Day: the sun decides (see syncTheme).
  const shadow = new Motion(
    0,
    (v) => {
      stage.style.setProperty("--shadow-x", `${v.toFixed(2)}px`);
    },
    { stiffness: 120, damping: 20 },
  );
  let gazeTimer = 0;
  const releaseGaze = () => {
    clearTimeout(gazeTimer);
    player.setGaze(null);
  };
  window.addEventListener("blur", releaseGaze);
  window.addEventListener("keydown", releaseGaze);
  windowEl.addEventListener("pointermove", (e) => {
    // Where the pointer is over the stage, for skins that light it there.
    const w = windowEl.getBoundingClientRect();
    windowEl.style.setProperty("--pointer-x", `${e.clientX - w.left}px`);
    windowEl.style.setProperty("--pointer-y", `${e.clientY - w.top}px`);
    const r = stage.getBoundingClientRect();
    const dx = e.clientX - (r.left + r.width / 2),
      dy = e.clientY - (r.top + r.height * 0.45);
    if (document.documentElement.dataset.theme === "night")
      shadow.to(Math.max(-18, Math.min(18, -dx * 0.04)));
    if (GAZE_ACTIONS.includes(player.requestedAction)) {
      clearTimeout(gazeTimer);
      player.setGaze(Math.hypot(dx, dy) > 24 ? { x: dx, y: dy } : null);
      gazeTimer = window.setTimeout(releaseGaze, 1500);
    }
  });
  windowEl.addEventListener("pointerleave", () => {
    releaseGaze();
    if (document.documentElement.dataset.theme === "night") shadow.to(0);
  });
  stage.addEventListener("click", (e) => {
    if (player.endSustained()) return;
    const r = stage.getBoundingClientRect();
    if (
      !player.hit(
        (e.clientX - r.left) / r.width,
        (e.clientY - r.top) / r.height,
      )
    )
      return;
    const pool = Object.keys(behavior().weights);
    play(pool[Math.floor(Math.random() * pool.length)] ?? "waving", false);
  });
  /** The corner label names an action only while one is playing. */
  function nowPlaying(text: string) {
    $("#playing").textContent = text;
    $("#playing").hidden = !text || text === t("studio.idle");
  }
  function play(name: string, desktop = true) {
    if (!selected()) return;
    player.play(name, name !== "idle");
    nowPlaying(
      name.startsWith("draft:")
        ? actionLabel(name.split(":")[2], draftLayer(name.split(":")[1]))
        : actionLabel(name, custom().layer),
    );
    markTape(name);
    if (player.sustaining) nowPlaying(t("studio.clickToEnd"));
    if (desktop && !name.startsWith("draft:")) attempt(() => api.play(name));
  }
  player.onComplete = () => {
    nowPlaying("");
    markTape("");
  };
  /** Plays a rule's steps in the window, one after another. */
  function playSteps(steps: Step[], prefix = "") {
    let i = 0;
    const next = () => {
      const step = steps[i++];
      if (!step) {
        player.onComplete = () => {
          nowPlaying("");
          markTape("");
        };
        player.play("idle");
        nowPlaying("");
        return;
      }
      if (step.wait) {
        player.play("idle");
        setTimeout(next, step.wait);
        return;
      }
      const name =
        prefix && !(step.play! in ANIMATIONS) ? prefix + step.play : step.play!;
      nowPlaying(
        actionLabel(
          step.play!,
          prefix ? draftLayer(prefix.split(":")[1]) : custom().layer,
        ),
      );
      player.onComplete = next;
      player.playSteps(name, step.repeat ?? 1);
      if (player.sustaining) nowPlaying(t("studio.clickToEnd"));
    };
    next();
  }

  // ---------- clips (taught actions) ----------
  function draftLayer(id: string) {
    return (
      state.snapshot.drafts.find((d) => d.id === id)?.preview ?? EMPTY_LAYER
    );
  }
  let clipsReady: Promise<void> = Promise.resolve();
  function loadClips(p: api.Pet) {
    const c = custom(p),
      drafts = state.snapshot.drafts.filter((d) => d.petId === p.id),
      key = `${p.id}:${c.history.current}:${drafts.map((d) => d.id).join(",")}`;
    if (key !== clipsKey) {
      clipsKey = key;
      clipsReady = fetchClips(p, c, drafts);
    }
    return clipsReady;
  }
  async function fetchClips(p: api.Pet, c: api.Custom, drafts: api.Draft[]) {
    const jobs = [
      ...Object.entries(c.layer.actions).map(async ([name, a]) => [
        name,
        { ...a, url: await api.actionImage(p.id, name) },
      ]),
      ...drafts.flatMap((d) =>
        d.addedActions.map(async (name) => [
          `draft:${d.id}:${name}`,
          {
            ...d.preview.actions[name],
            url: await api.actionImage(p.id, name, d.id),
          },
        ]),
      ),
      // Every pet sleeps (plan/29); the built-in strip unless it was taught one.
      ...(!c.layer.actions.sleep && (p.sleepStrip || p.id === "lizi")
        ? [
            api.sleepSprite(p).then((url) => [
              "sleep",
              {
                label: t("pet.sleep"),
                durations: sleepExample.actions.sleep.durations,
                loopFrames: [5, 12],
                url,
              },
            ]),
          ]
        : []),
    ] as Promise<[string, { durations: number[]; url: string }]>[];
    // A missing image skips that action instead of breaking the studio.
    const clips = Object.fromEntries(
      (await Promise.allSettled(jobs)).flatMap((r) =>
        r.status === "fulfilled" ? [r.value] : [],
      ),
    );
    clipImages.clear();
    clipFrames.clear();
    for (const [name, c] of Object.entries(clips)) {
      clipImages.set(name, image(c.url));
      clipFrames.set(name, c.durations);
    }
    player.removeClipsExcept(Object.keys(clips));
    await player.addClips(clips);
  }

  async function renderPet(p: api.Pet) {
    const key = `${p.id}:${p.fingerprint}`;
    if (key !== loaded) {
      loaded = key;
      clipsKey = "";
      await player.load(await api.sprite(p.id));
      if (player.image) measureFloor(player.image);
      if (landing) land();
      nowPlaying("");
    }
    await loadClips(p);
  }

  return {
    shadow,
    layoutStage,
    petArrived,
    play,
    playSteps,
    renderPet,
    clipImages: clipImages as ReadonlyMap<string, Promise<HTMLImageElement>>,
    clipFrames: clipFrames as ReadonlyMap<string, number[]>,
    caption: nowPlaying,
  };
}
