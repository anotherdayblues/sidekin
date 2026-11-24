// The parts of a demo that hold no styles: its shape, the context it is
// drawn with, and small timeline helpers. Kept apart from demoPlayer.ts so
// tests can build demos without a page.
import type { SpritePlayer } from "../player.ts";
import { shortcutKeys } from "../shortcutRecorder.ts";

/** The shortcuts a demo can show; copy-twice is fixed. */
export type Shortcut = "chat" | "vision" | "panel" | "clipboard";

/** What a demo shows that depends on the user: their system and shortcuts. */
export interface DemoContext {
  mac: boolean;
  /** The user's shortcut as keycap labels, e.g. ["⌃", "⌥", "S"]. */
  keys: (shortcut: Shortcut) => string[];
  /** The same shortcut written the way captions show it. */
  label: (shortcut: Shortcut) => string;
}
export interface Scene {
  /** The fake desktop: the demo's own markup plus the pet. */
  desk: HTMLElement;
  pet: SpritePlayer;
  /** The element marked `data-part="name"` in the demo's markup. */
  part: (name: string) => HTMLElement;
  /** Points the fake cursor at `el`'s right end (or left, or middle),
   * `down` of the way from its top. */
  pointAt: (el: HTMLElement, side?: "start" | "end" | "middle", down?: number) => void;
  /** Gives part `name` the box of `el` as --bx/--by/--bw/--bh. */
  box: (name: string, el: HTMLElement) => void;
}
export interface Cue {
  at: number;
  run: (scene: Scene) => void;
}
export interface Demo {
  id: string;
  /** One loop, in ms, ending on the result held still. */
  length: number;
  /** The caption lines, each lit from its time on. */
  captions: (c: DemoContext) => { at: number; text: string }[];
  /** The moments shown as still steps when motion is reduced. */
  stills: number[];
  /** Markup inside the desk; the pet goes in [data-part=pet]. */
  markup: (c: DemoContext) => string;
  cues: (c: DemoContext) => Cue[];
  /** Shows the bundled example pet instead of the user's (a pet being made). */
  examplePet?: boolean;
}

/** Cues that reveal `text` in part `name` one character at a time. */
export function typeIn(name: string, text: string, from: number, ms: number): Cue[] {
  const chars = [...text];
  return chars.map((_, i) => ({
    at: from + i * ms,
    run: (s) => void (s.part(name).textContent = chars.slice(0, i + 1).join("")),
  }));
}

/** Words, or characters for text written without spaces. */
export function words(text: string) {
  return text.includes(" ") ? text.split(/(?<= )/) : [...text];
}

export interface DemoOptions {
  /** The pet's sprite sheet URL. */
  sprite: string;
  /** The bundled example pet's, for a demo about making a new pet. */
  example: string;
  /** The user's saved shortcuts, in the "Control+Alt+S" form. */
  shortcuts: Record<Shortcut, string>;
}

/** The context every demo is drawn with, from the user's saved shortcuts. */
export function demoContext(
  shortcuts: DemoOptions["shortcuts"],
  mac = document.documentElement.dataset.platform === "mac",
): DemoContext {
  return {
    mac,
    keys: (name) => shortcutKeys(shortcuts[name], mac),
    label: (name) => shortcutKeys(shortcuts[name], mac).join(mac ? "" : "+"),
  };
}
