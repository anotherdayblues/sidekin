import contract from "../../../skills/make-desktop-pet/references/runtime-contract.json";
export const ANIMATIONS = contract.animations;
export type Action = keyof typeof ANIMATIONS;
export const ACTIONS = Object.keys(ANIMATIONS) as Action[];
export const GAZE_ACTIONS: string[] = ["idle", "running", "waving"];
export interface PlaybackFrame {
  action: string;
  row: number;
  frame: number;
  milliseconds: number;
  /** Custom action image; absent for the base atlas. */
  sheet?: string;
}
/** Frames of one custom action strip (row 0 of its own image). */
export interface Clip {
  durations: number[];
  /** One-based, inclusive range of the moving hold section. */
  loopFrames?: [number, number];
}
function clipRow(name: string, clip: Clip): PlaybackFrame[] {
  return clip.durations.map((ms, frame) => ({
    action: name,
    row: 0,
    frame,
    milliseconds: ms,
    sheet: name,
  }));
}
/**
 * Exact repetitions with no settling idle, for steps of a taught sequence.
 * `loopStart` is null, so the player reports completion at the last frame.
 */
export function stepPlan(name: string, repeat = 1, clip?: Clip) {
  const once = clip
    ? clipRow(name, clip)
    : ANIMATIONS[name as Action].durations.map((ms, frame) => ({
        action: name,
        row: ANIMATIONS[name as Action].row,
        frame,
        milliseconds: ms,
      }));
  return {
    frames: Array.from({ length: Math.max(1, repeat) }, () => once).flat(),
    loopStart: null as number | null,
  };
}
/** A custom action played from a click or a test button: once, then idle. */
export function clipPlan(
  name: string,
  clip: Clip,
  reducedMotion = false,
  loop = false,
) {
  const frames = clipRow(name, clip);
  if (reducedMotion)
    return { frames: frames.slice(0, 1), loopStart: null as number | null };
  if (loop) return { frames, loopStart: 0 };
  return {
    frames: [...frames, ...playbackPlan("idle").frames],
    loopStart: frames.length,
  };
}
export function playbackPlan(
  action: Action,
  reducedMotion = false,
  loop = false,
  cycles = contract.runtimePlayback.actionRepetitions,
  durationMultiplier = 1,
) {
  const row = (name: Action, multiplier = 1): PlaybackFrame[] =>
    ANIMATIONS[name].durations.map((ms, frame) => ({
      action: name,
      row: ANIMATIONS[name].row,
      frame,
      milliseconds: ms * multiplier,
    }));
  const frames = row(action);
  if (reducedMotion)
    return { frames: frames.slice(0, 1), loopStart: null as number | null };
  if (action === "idle") return { frames: row("idle", 6), loopStart: 0 };
  // During a focus session `running` loops continuously: slow it 3x so the
  // pet stays calm beside you while keeping AI-thinking `running` brisk.
  if (loop)
    return {
      frames: action === "running" ? row("running", 3) : frames,
      loopStart: 0,
    };
  const played = Array.from({ length: Math.max(1, cycles) }, () =>
    row(action, durationMultiplier),
  ).flat();
  return { frames: [...played, ...row("idle", 6)], loopStart: played.length };
}
/** How many times the hover action plays: once, so a pass of the
 *  pointer is a small greeting rather than a fuss. */
export const HOVER_CYCLES = 1;
/** Gentle slow-down factor for the hover greeting action. */
export const HOVER_DURATION_MULTIPLIER =
  contract.runtimePlayback.hoverDurationMultiplier;
export function resolvedPetState(
  drag: string | null,
  hovered: boolean,
  base: string,
): string {
  return drag ?? (hovered ? contract.runtimePlayback.hoverAction : base);
}

/**
 * Where the cursor counts as "on the pet": the idle pose's silhouette,
 * grown a little so the gaps between legs don't flicker. Once on, a wider
 * outline keeps the hover while the pet moves under the cursor.
 */
export class PetShape {
  constructor(
    private readonly reach: Uint8Array,
    private readonly hold: Uint8Array,
    readonly width: number,
    readonly height: number,
  ) {}
  /** From the opacity of each pixel (one byte a pixel): the cell at
   *  (x0, y0) of an image `stride` wide. */
  static from(
    alpha: ArrayLike<number>,
    stride: number,
    x0 = 0,
    y0 = 0,
    width = 192,
    height = 208,
  ): PetShape | null {
    // Works for any pet: the outline comes from this pet's own idle frame.
    // Faint pets (ghosts, glow) fall back to any visible pixel; a frame with
    // nothing visible gives null, and the whole window counts as before.
    const outline = (min: number) => {
      const solid = new Uint8Array(width * height);
      let count = 0;
      for (let y = 0; y < height; y++)
        for (let x = 0; x < width; x++)
          if (alpha[(y0 + y) * stride + x0 + x] > min) {
            solid[y * width + x] = 1;
            count++;
          }
      return { solid, count };
    };
    let { solid, count } = outline(40);
    if (count < width * height * 0.005) ({ solid, count } = outline(0));
    if (!count) return null;
    const p = contract.runtimePlayback;
    return new PetShape(
      grow(solid, width, height, p.hoverReachPx),
      grow(solid, width, height, p.hoverHoldPx),
      width,
      height,
    );
  }
  /** `u`, `v` from 0 to 1 across the pet's window. */
  hit(u: number, v: number, hovered = false) {
    const x = Math.floor(u * this.width),
      y = Math.floor(v * this.height);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return false;
    return (hovered ? this.hold : this.reach)[y * this.width + x] === 1;
  }
}
/** Square dilation by `r` pixels, as two one-dimensional passes. */
function grow(mask: Uint8Array, w: number, h: number, r: number) {
  const across = new Uint8Array(w * h),
    out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let last = -Infinity;
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) last = x;
      if (x - last <= r) across[y * w + x] = 1;
    }
    last = Infinity;
    for (let x = w - 1; x >= 0; x--) {
      if (mask[y * w + x]) last = x;
      if (last - x <= r) across[y * w + x] = 1;
    }
  }
  for (let x = 0; x < w; x++) {
    let last = -Infinity;
    for (let y = 0; y < h; y++) {
      if (across[y * w + x]) last = y;
      if (y - last <= r) out[y * w + x] = 1;
    }
    last = Infinity;
    for (let y = h - 1; y >= 0; y--) {
      if (across[y * w + x]) last = y;
      if (last - y <= r) out[y * w + x] = 1;
    }
  }
  return out;
}
export function statusAction(
  status: { kind?: string; isLoading?: boolean; level?: string } | null,
): Action {
  if (!status) return "idle";
  if (status.kind === "first-awake") return "waving";
  const companion: Record<string, Action> = {
    thinking: "running",
    streaming: "idle",
    tool: "running",
    authorization: "waiting",
    remembered: "review",
    reminder: "jumping",
    reading: "review",
    vision: "idle",
    error: "failed",
    idle: "idle",
  };
  if (status.kind && Object.hasOwn(companion, status.kind))
    return companion[status.kind];
  if (status.isLoading) return "running";
  return (
    (
      {
        warning: "waiting",
        danger: "failed",
        success: "review",
        info: "idle",
      } as Record<string, Action>
    )[status.level ?? ""] ?? "idle"
  );
}
export interface Behavior {
  interactionVersion?: number;
  napMinutes?: number;
  enabled: boolean;
  minSeconds: number;
  maxSeconds: number;
  weights: Partial<Record<Action, number>>;
  clickAction: Action | "open-studio";
  doubleClickAction: Action | null;
}
export function normalizeBehavior(
  value: Partial<Behavior> | null = {},
): Behavior {
  value = value && typeof value === "object" ? value : {};
  const finite = (v: unknown, d: number) =>
    typeof v === "number" && Number.isFinite(v) ? v : d;
  const min = Math.min(3600, Math.max(5, finite(value.minSeconds, 45)));
  const max = Math.min(7200, Math.max(min, finite(value.maxSeconds, 120)));
  return {
    interactionVersion: 2,
    ...(value.napMinutes !== undefined
      ? {
          napMinutes: Math.max(
            1,
            Math.min(10080, finite(value.napMinutes, 10)),
          ),
        }
      : {}),
    // Base actions never come up at random (plan/29): only learned ones
    // given "随机出现", so the old switch and weights no longer apply.
    enabled: true,
    minSeconds: min,
    maxSeconds: max,
    weights: {},
    clickAction:
      value.interactionVersion === 2 &&
      ACTIONS.includes(value.clickAction as Action)
        ? value.clickAction!
        : "open-studio",
    doubleClickAction:
      value.interactionVersion === 2 &&
      ACTIONS.includes(value.doubleClickAction as Action)
        ? value.doubleClickAction!
        : null,
  };
}
export function duration(action: Action): number {
  return ANIMATIONS[action].durations.reduce((a, b) => a + b, 0);
}
export function frameAt(action: Action, time: number) {
  const a = ANIMATIONS[action];
  let t = ((time % duration(action)) + duration(action)) % duration(action);
  let frame = 0;
  while (frame < a.durations.length - 1 && t >= a.durations[frame])
    t -= a.durations[frame++];
  return { row: a.row, frame, remaining: a.durations[frame] - t };
}
export function gazeFrame(x: number, y: number) {
  const d =
    Math.round(
      ((Math.atan2(x, -y) + Math.PI * 2) % (Math.PI * 2)) / (Math.PI / 8),
    ) % 16;
  return { row: 9 + Math.floor(d / 8), frame: d % 8 };
}
/**
 * On the desktop the pet never follows the mouse, like the Codex client's
 * mascot: it looks at the text caret while you type. A double-click is the
 * one exception: it watches the mouse for a few seconds.
 */
export const GAZE = {
  afterDoubleClick: 5000, // ms the pet follows the mouse after a double-click
  far: 400, // px beyond which the cursor is checked less often
};
export class GazeAttention {
  private until = 0;
  /** The user double-clicked the pet: follow the mouse for a while. */
  wake(now: number) {
    this.until = now + GAZE.afterDoubleClick;
  }
  get awake() {
    return this.until > 0;
  }
  /** `x`, `y`: mouse relative to the pet's centre; returns where to look. */
  update(now: number, x: number, y: number) {
    if (now >= this.until) {
      this.until = 0;
      return null;
    }
    return Math.hypot(x, y) > 1 ? { x, y } : null;
  }
}

export class RandomBehavior {
  deadline: number | null = null;
  previous: string | null = null;
  constructor(private random = () => Math.random()) {}
  reset() {
    this.deadline = null;
  }
  /**
   * The learned actions given 随机出现 (keys `rule:<id>`), each weighted by
   * how many times an hour it should come up (plan/29). Together they come
   * up as often as their rates add to, each in its share: the same as each
   * on its own clock. Base actions are never in the pool.
   */
  next(
    now: number,
    b: Behavior,
    busy = false,
    pool: Record<string, number> = {},
  ): string | null {
    const weights: Record<string, number> = { ...b.weights, ...pool };
    let choices = Object.keys(weights).filter(
      (a) => a !== "idle" && weights[a] > 0,
    );
    const perHour = choices.reduce((sum, a) => sum + weights[a], 0);
    if (!b.enabled || !perHour) {
      this.reset();
      return null;
    }
    // Around the mean gap, never exactly on it, so it does not feel timed.
    const delay = () => (3_600_000 / perHour) * (0.5 + this.random());
    if (busy || this.deadline === null) {
      this.deadline = now + delay();
      return null;
    }
    if (now < this.deadline) return null;
    if (choices.length > 1)
      choices = choices.filter((a) => a !== this.previous);
    let roll = this.random() * choices.reduce((sum, a) => sum + weights[a], 0);
    const action =
      choices.find((a) => (roll -= weights[a]) < 0) ??
      choices[choices.length - 1];
    this.previous = action;
    this.deadline =
      now + (action in ANIMATIONS ? duration(action as Action) : 0) + delay();
    return action;
  }
}
