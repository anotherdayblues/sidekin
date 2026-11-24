// 番茄钟 for the windows (plan/19): the host's timer state, its commands,
// and the countdown each window draws on its own. focus.rs owns the time.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import type { Key } from "./i18n.ts";

export type FocusPhase = "idle" | "focus" | "done" | "break" | "rested";
export interface FocusSettings {
  focusMinutes: number;
  breakMinutes: number;
  longBreakMinutes: number;
  longEvery: number;
  chime: boolean;
  ambient: "off" | "noise" | "rain" | "pages";
  volume: number;
  autoBreak: boolean;
  autoNext: boolean;
  holdReminders: boolean;
  /** The clock's light takes the pet's hue. */
  petTint: boolean;
}
export interface FocusDay {
  day: string;
  count: number;
  minutes: number;
}
export interface FocusState {
  phase: FocusPhase;
  endsAt: number;
  length: number;
  pausedLeft: number | null;
  round: number;
  longBreak: boolean;
  today: number;
  /** Minutes focused today and this week, ended early too (plan/29). */
  todayMinutes: number;
  weekCount: number;
  weekMinutes: number;
  streak: number;
  /** The most days in a row ever. */
  longest?: number;
  week: FocusDay[];
  /** The last thirty days, today last. */
  month?: FocusDay[];
  /** Every session today, ended early too (plan/29). */
  sessions?: { at: number; minutes: number; done: boolean }[];
  /** Every session of the last seven days. */
  weekSessions?: { at: number; minutes: number }[];
  settings: FocusSettings;
  now: number;
}
/** What just happened, for a reaction (focus.rs `Moment`). */
export type FocusMoment =
  | "Started"
  | "Finished"
  | "FinishedAway"
  | "GaveUp"
  | "BreakStarted"
  | "BreakOver"
  | "Ended"
  | "Paused"
  | "Resumed"
  | null;

export const DEFAULT_FOCUS: FocusSettings = {
  focusMinutes: 25,
  breakMinutes: 5,
  longBreakMinutes: 15,
  longEvery: 4,
  chime: true,
  ambient: "off",
  volume: 40,
  autoBreak: false,
  autoNext: false,
  holdReminders: false,
  petTint: true,
};

/** No timer: before the host has answered, or outside the app. */
export const IDLE_FOCUS: FocusState = {
  phase: "idle",
  endsAt: 0,
  length: 0,
  pausedLeft: null,
  round: 0,
  longBreak: false,
  today: 0,
  todayMinutes: 0,
  weekCount: 0,
  weekMinutes: 0,
  streak: 0,
  week: [],
  settings: DEFAULT_FOCUS,
  now: 0,
};
// Outside the app (previews, screenshots): a timer in the page.
let preview: FocusState = { ...IDLE_FOCUS, now: Date.now() };
const previewListeners = new Set<(s: FocusState, m: FocusMoment) => void>();
function previewSet(next: Partial<FocusState>, moment: FocusMoment) {
  preview = { ...preview, ...next, now: Date.now() };
  for (const cb of previewListeners) cb(preview, moment);
  return preview;
}
/** Screenshot scripts set any state directly. */
export function previewFocus(
  next: Partial<FocusState>,
  moment: FocusMoment = null,
) {
  return previewSet(next, moment);
}

export async function focusState(): Promise<FocusState> {
  if (!native) return structuredClone(preview);
  // A host that has no timer to report counts as idle.
  const s = await invoke<FocusState | null>("focus_state").catch(() => null);
  return s ?? { ...IDLE_FOCUS, now: Date.now() };
}
export type FocusCommand = "start" | "rest" | "pause" | "resume" | "stop";
export async function focusCommand(
  cmd: FocusCommand,
  minutes?: number,
): Promise<FocusState> {
  if (native) return invoke(`focus_${cmd}`, cmd === "start" ? { minutes } : {});
  const now = Date.now(),
    m = (n: number) => n * 60_000;
  if (cmd === "start") {
    const length = m(minutes ?? preview.settings.focusMinutes);
    return previewSet(
      { phase: "focus", length, endsAt: now + length, pausedLeft: null },
      "Started",
    );
  }
  if (cmd === "rest") {
    const length = m(preview.settings.breakMinutes);
    return previewSet(
      { phase: "break", length, endsAt: now + length },
      "BreakStarted",
    );
  }
  if (cmd === "pause")
    return previewSet(
      { pausedLeft: Math.max(0, preview.endsAt - now) },
      "Paused",
    );
  if (cmd === "resume")
    return previewSet(
      { endsAt: now + (preview.pausedLeft ?? 0), pausedLeft: null },
      "Resumed",
    );
  return previewSet(
    { phase: "idle", pausedLeft: null },
    preview.phase === "focus" ? "GaveUp" : "Ended",
  );
}
export async function saveFocusSettings(
  settings: FocusSettings,
): Promise<FocusState> {
  return native
    ? invoke("focus_settings", { settings })
    : previewSet({ settings }, null);
}
/** Every change of the timer, with what just happened. */
export async function onFocus(cb: (s: FocusState, m: FocusMoment) => void) {
  if (!native) {
    previewListeners.add(cb);
    return () => previewListeners.delete(cb);
  }
  return listen<{ state: FocusState; moment: FocusMoment }>(
    "focus-changed",
    (e) => cb(e.payload.state, e.payload.moment),
  );
}

/** What can be done now, the usual choice first: for the menu, the
 * bubble and the 专注 page alike. */
export function focusChoices(s: FocusState): [FocusCommand, Key][] {
  const hold: [FocusCommand, Key] =
    s.pausedLeft !== null
      ? ["resume", "focus.resume"]
      : ["pause", "focus.pause"];
  switch (s.phase) {
    case "idle":
      return [["start", "focus.start"]];
    case "focus":
      return [hold, ["stop", "focus.giveUp"]];
    case "done":
      return [
        ["rest", "focus.rest"],
        ["start", "focus.skipBreak"],
        ["stop", "focus.stop"],
      ];
    case "break":
      return [hold, ["start", "focus.skipBreak"], ["stop", "focus.stop"]];
    case "rested":
      return [
        ["start", "focus.again"],
        ["stop", "focus.stop"],
      ];
  }
}
/** Which tomato of the set this is, "2 / 4": the running one while
 * focusing, the last one done otherwise. */
export function roundOf(s: FocusState) {
  const n = s.settings.longEvery;
  const k =
    s.phase === "focus"
      ? (s.round % n) + 1
      : ((Math.max(1, s.round) - 1) % n) + 1;
  return { k, n };
}

/** Time left in the running phase, in ms. The host's clock and this
 * window's are the same machine's, so its deadline can be used as is. */
export function timeLeft(s: FocusState, now = Date.now()) {
  return s.pausedLeft ?? Math.max(0, s.endsAt - now);
}
/** "24:59". */
export function clock(ms: number) {
  const total = Math.ceil(ms / 1000),
    m = Math.floor(total / 60),
    sec = total % 60;
  return `${m}:${String(sec).padStart(2, "0")}`;
}
/** How far the running phase has come, 0–1. */
export function progress(s: FocusState, now = Date.now()) {
  return s.length ? 1 - timeLeft(s, now) / s.length : 0;
}
