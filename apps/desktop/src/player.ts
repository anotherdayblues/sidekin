import {
  ANIMATIONS,
  clipPlan,
  gazeFrame,
  playbackPlan,
  PetShape,
  stepPlan,
  GAZE_ACTIONS,
  type Action,
  type Clip,
} from "./animation.ts";

/** A decoded sheet and its opacity, one byte a pixel: all the hit tests
 *  and outlines read. A full RGBA copy would be four times the size. */
interface Sheet {
  image: HTMLImageElement;
  alpha: Uint8Array;
}
async function decode(url: string): Promise<Sheet> {
  const image = new Image();
  image.src = url;
  await image.decode();
  const c = document.createElement("canvas");
  c.width = image.width;
  c.height = image.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(image, 0, 0);
  const rgba = ctx.getImageData(0, 0, c.width, c.height).data;
  const alpha = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < alpha.length; i++) alpha[i] = rgba[i * 4 + 3];
  // Let the scratch canvas go now rather than whenever it is collected.
  c.width = c.height = 0;
  return { image, alpha };
}
/** Players in one window share each sheet (the 主窗口 has several showing
 *  the same pet); it is let go when the last one stops using it. */
const sheets = new Map<string, { sheet: Promise<Sheet>; users: number }>();
function take(url: string) {
  let entry = sheets.get(url);
  if (!entry) {
    const sheet = decode(url);
    entry = { sheet, users: 0 };
    sheets.set(url, entry);
    sheet.catch(() => {
      if (sheets.get(url)?.sheet === sheet) sheets.delete(url);
    });
  }
  entry.users++;
  return entry.sheet;
}
function letGo(url: string | undefined) {
  const entry = url ? sheets.get(url) : undefined;
  if (entry && --entry.users <= 0) sheets.delete(url!);
}
/** How many sheets this window holds (for tests). */
export function heldSheets() {
  return sheets.size;
}

/** Same frame scheduling contract as the installed client; Tauri owns the window. */
export class SpritePlayer {
  image: HTMLImageElement | null = null;
  action = "idle";
  requestedAction = "idle";
  active = true;
  private reduced = false;
  private loop = false;
  private index = 0;
  private plan = playbackPlan("idle");
  private gaze: { x: number; y: number } | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private loadToken = 0;
  private alpha: Uint8Array | null = null;
  private url: string | undefined;
  private clips = new Map<string, Clip & Sheet & { url: string }>();
  /** The idle pose's outline, for telling the pet from empty window. */
  shape: PetShape | null = null;
  private lastPose = "";
  private completed = false;
  onComplete: (() => void) | null = null;
  /** Optional lighting painted over the pet after each frame (studio). */
  light: ((ctx: CanvasRenderingContext2D) => void) | null = null;
  /** Repaints the current pose, e.g. after the lighting changed. */
  repaint() {
    this.lastPose = "";
    if (this.active && this.image) this.draw();
  }
  constructor(readonly canvas: HTMLCanvasElement) {
    canvas.width = 384;
    canvas.height = 416;
  }
  async load(url: string) {
    const token = ++this.loadToken;
    // A sheet that fails to decode drops out of the shared list by itself.
    const sheet = await take(url);
    if (token !== this.loadToken) return letGo(url);
    letGo(this.url);
    this.url = url;
    this.image = sheet.image;
    this.alpha = sheet.alpha;
    this.shape = PetShape.from(sheet.alpha, sheet.image.width);
    this.canvas.dispatchEvent(
      new CustomEvent("pet-shape", { detail: this.shape, bubbles: true }),
    );
    this.dropClips([]);
    this.play("idle");
  }
  /** Lets go of every sheet, e.g. when its dialog closes; load() again to
   *  show it. */
  unload() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.loadToken++;
    this.dropClips([]);
    letGo(this.url);
    this.url = undefined;
    this.image = null;
    this.alpha = null;
    this.shape = null;
    this.lastPose = "";
  }
  private dropClips(keep: Iterable<string>) {
    const names = new Set(keep);
    for (const [name, clip] of [...this.clips])
      if (!names.has(name)) {
        this.clips.delete(name);
        letGo(clip.url);
      }
  }
  /** Adds or replaces taught actions; image URLs are decoded once each. */
  async addClips(clips: Record<string, Clip & { url: string }>) {
    const token = this.loadToken;
    const entries = Object.entries(clips);
    const settled = await Promise.allSettled(
      entries.map(([, c]) => take(c.url)),
    );
    const failed = settled.find((r) => r.status === "rejected");
    if (failed || token !== this.loadToken) {
      entries.forEach(([, c], i) => {
        if (settled[i].status === "fulfilled") letGo(c.url);
      });
      if (failed) throw failed.reason;
      return;
    }
    const loaded = entries.map(
      ([name, c], i) =>
        [
          name,
          {
            ...(settled[i] as PromiseFulfilledResult<Sheet>).value,
            url: c.url,
            durations: c.durations,
            loopFrames: c.loopFrames,
          },
        ] as const,
    );
    for (const [name, clip] of loaded) {
      letGo(this.clips.get(name)?.url);
      this.clips.set(name, clip);
    }
    if (loaded.some(([name]) => name === this.requestedAction)) this.restart();
  }
  removeClipsExcept(keep: Iterable<string>) {
    const names = new Set(keep);
    if (this.hold && !names.has(this.requestedAction)) this.play("idle");
    const removedCurrent =
      this.clips.has(this.requestedAction) && !names.has(this.requestedAction);
    this.dropClips(names);
    if (removedCurrent) {
      if (this.has(this.requestedAction)) this.restart();
      else this.play("idle");
    }
  }
  has(action: string) {
    return action in ANIMATIONS || this.clips.has(action);
  }
  play(action: string, settle = true, cycles?: number, durationMultiplier = 1) {
    if (!this.has(action)) action = "idle";
    this.requestedAction = action;
    this.loop = !settle;
    this.repeat = 0;
    this.cycles = cycles;
    this.durationMultiplier = durationMultiplier;
    this.restart();
  }
  /** Plays exactly `repeat` cycles, then calls onComplete on the last frame. */
  playSteps(action: string, repeat = 1) {
    if (!this.has(action)) {
      queueMicrotask(() => this.onComplete?.());
      return;
    }
    this.requestedAction = action;
    this.loop = false;
    this.repeat = repeat;
    this.cycles = undefined;
    this.durationMultiplier = 1;
    this.restart();
  }
  /** `cycles` sets how often a settling action plays before idle. */
  setState(action: string, loop = false, cycles?: number, durationMultiplier = 1) {
    if (
      action !== this.requestedAction ||
      durationMultiplier !== this.durationMultiplier
    )
      this.play(action, !loop, cycles, durationMultiplier);
  }
  private hold: [number, number] | undefined;
  private ending = false;
  /** In the held middle of a sustained clip (asleep, for a sleep clip). */
  private holding = false;
  get sustaining() {
    return this.hold !== undefined;
  }
  endSustained() {
    if (!this.hold) return false;
    this.ending = true;
    return true;
  }
  private repeat = 0;
  private cycles: number | undefined;
  private durationMultiplier = 1;
  private restart() {
    const name = this.requestedAction,
      clip = this.clips.get(name);
    this.hold = this.reduced ? undefined : clip?.loopFrames;
    this.ending = false;
    this.plan = this.hold
      ? stepPlan(name, 1, clip)
      : this.repeat > 0 && !this.reduced
        ? stepPlan(name, this.repeat, clip)
        : clip
          ? clipPlan(name, clip, this.reduced, this.loop)
          : playbackPlan(
              name as Action,
              this.reduced,
              this.loop,
              this.cycles,
              this.durationMultiplier,
            );
    this.index = 0;
    this.completed = false;
    this.lastPose = "";
    this.draw();
  }
  setActive(active: boolean) {
    if (this.active === active) return;
    this.active = active;
    this.draw();
  }
  setReducedMotion(reduced: boolean) {
    if (this.reduced === reduced) return;
    this.reduced = reduced;
    this.restart();
  }
  setGaze(value: { x: number; y: number } | null) {
    const key = (v: typeof value) =>
      v ? JSON.stringify(gazeFrame(v.x, v.y)) : "";
    if (key(value) === key(this.gaze)) return;
    const wasLooking = this.looking();
    this.gaze = value;
    // Overrides and taught steps keep their own timing while gaze moves.
    if (!this.hold && this.repeat === 0 && (wasLooking || this.looking()))
      this.restart();
  }
  private looking() {
    return (
      this.repeat === 0 &&
      this.gaze !== null &&
      !this.clips.has(this.requestedAction) &&
      this.image?.height === 2288 &&
      GAZE_ACTIONS.includes(this.requestedAction)
    );
  }
  pose(): { row: number; frame: number; sheet?: string } {
    return this.looking()
      ? gazeFrame(this.gaze!.x, this.gaze!.y)
      : this.plan.frames[this.index];
  }
  private sheet(p: { sheet?: string }) {
    const clip = p.sheet ? this.clips.get(p.sheet) : null;
    if (clip) return clip;
    return this.image && this.alpha
      ? { image: this.image, alpha: this.alpha }
      : null;
  }
  hit(x: number, y: number) {
    const p = this.pose(),
      s = this.sheet(p),
      px = Math.floor(x * 192),
      py = Math.floor(y * 208);
    if (!s || px < 0 || px >= 192 || py < 0 || py >= 208) return false;
    return (
      s.alpha[(p.row * 208 + py) * s.image.width + p.frame * 192 + px] > 35
    );
  }
  /** Where this pose's outline starts, as shares of the cell: its highest
   *  row (a few pixels, so one stray dot does not count) and the middle of
   *  the band just below it, so marks can sit above the pet. Once per hold. */
  private top(p: { row: number; frame: number; sheet?: string }) {
    const s = this.sheet(p);
    if (!s?.alpha) return null;
    const solid = (x: number, y: number) =>
      s.alpha[(p.row * 208 + y) * s.image.width + p.frame * 192 + x] > 40;
    let y = 0;
    const count = (y: number) => {
      let n = 0;
      for (let x = 0; x < 192; x++) if (solid(x, y)) n++;
      return n;
    };
    while (y < 208 && count(y) < 3) y++;
    if (y >= 208) return null;
    let left = 192,
      right = -1;
    for (let yy = y; yy < Math.min(208, y + 16); yy++)
      for (let x = 0; x < 192; x++)
        if (solid(x, yy)) {
          left = Math.min(left, x);
          right = Math.max(right, x);
        }
    return { y: y / 208, x: (left + right) / 2 / 192 };
  }
  private draw() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    if (!this.active || !this.image) return;
    const pose = this.pose(),
      sheet = this.sheet(pose) ?? { image: this.image },
      key = `${pose.sheet ?? ""}:${pose.row}:${pose.frame}`;
    this.action = this.plan.frames[this.index].action;
    // The held loop runs from frame hold[0] to hold[1] (one-based); the
    // window hears when the pet enters or leaves it (petDoze.ts).
    const holding =
      !!this.hold && !this.ending && this.index >= this.hold[0] - 1;
    if (holding !== this.holding) {
      this.holding = holding;
      this.canvas.dispatchEvent(
        new CustomEvent("pet-hold", {
          detail: {
            action: this.requestedAction,
            on: holding,
            top: holding ? this.top(pose) : null,
          },
          bubbles: true,
        }),
      );
    }
    if (key !== this.lastPose) {
      const ctx = this.canvas.getContext("2d")!;
      ctx.clearRect(0, 0, 384, 416);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(
        sheet.image,
        pose.frame * 192,
        pose.row * 208,
        192,
        208,
        0,
        0,
        384,
        416,
      );
      if (this.light) {
        // Light falls only on the pet's own pixels.
        ctx.save();
        ctx.globalCompositeOperation = "source-atop";
        this.light(ctx);
        ctx.restore();
      }
      this.lastPose = key;
    }
    if (this.looking()) return;
    if (this.plan.frames.length === 1) {
      if (this.repeat > 0)
        this.timer = setTimeout(
          () => this.onComplete?.(),
          this.plan.frames[0].milliseconds,
        );
      return;
    }
    this.timer = setTimeout(() => {
      let next = this.index + 1;
      // Like a Montage section link: change the destination only at the boundary.
      if (this.hold && next === this.hold[1] && !this.ending)
        next = this.hold[0] - 1;
      if (this.hold && next >= this.plan.frames.length) {
        this.play("idle");
        this.onComplete?.();
        return;
      }
      if (next >= this.plan.frames.length) {
        if (this.plan.loopStart === null) {
          if (this.repeat > 0) this.onComplete?.();
          return;
        }
        next = this.plan.loopStart;
      }
      this.index = next;
      if (
        !this.completed &&
        this.plan.loopStart !== null &&
        this.plan.loopStart > 0 &&
        next === this.plan.loopStart
      ) {
        this.completed = true;
        this.onComplete?.();
      }
      this.draw();
    }, this.plan.frames[this.index].milliseconds);
  }
  destroy() {
    this.unload();
    this.active = false;
  }
}
