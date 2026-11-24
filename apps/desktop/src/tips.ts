// The studio's and the bubble's side of 上手引导 (plan/17): what the host
// remembers in tips.json, and the words for each tip.
import { invoke } from "@tauri-apps/api/core";
import { defaults } from "../../shared/companion.ts";
import { native } from "./bridge.ts";
import { t, type Key } from "./i18n.ts";
import { shortcutLabel } from "./shortcutRecorder.ts";

export interface TipsRecord {
  guideShown: boolean;
  used: string[];
  learned: string[];
  told: string[];
  off: boolean;
}
/** Everything the pet can teach, in the skill book's order (tips.rs). */
export const FEATURES = [
  "chat-shortcut",
  "panel",
  "focus",
  "copy-translate",
  "menu-translate",
  "snip",
  "file-transfer",
  "phone",
  "memory",
  "clipboard",
  "reminder",
  "library",
  "web",
  "teach",
  "make-pet",
  "menu",
  "todo",
] as const;
export type Feature = (typeof FEATURES)[number];
/** How the skill book groups the features (plan/32): a few small groups
 * rather than one long list. Every feature is in one group. */
export const GROUPS: [string, Feature[]][] = [
  ["chat", ["chat-shortcut", "panel", "web"]],
  ["read", ["copy-translate", "menu-translate", "snip"]],
  ["plan", ["todo", "reminder", "focus"]],
  ["keep", ["memory", "library", "clipboard"]],
  ["pet", ["menu", "file-transfer", "phone", "teach", "make-pet"]],
];
/** The cards with a 小技巧 line: the small gestures of that feature. */
export const WITH_TIPS: string[] = [
  "panel",
  "menu-translate",
  "todo",
  "focus",
  "memory",
  "clipboard",
  "teach",
  "make-pet",
  "menu",
];
/** The features with a demo (demos/index.ts). */
export const DEMO_FEATURES: string[] = [
  "chat-shortcut",
  "panel",
  "focus",
  "copy-translate",
  "menu-translate",
  "snip",
  "file-transfer",
  "phone",
  "memory",
  "clipboard",
  "todo",
  "reminder",
  "teach",
  "make-pet",
];

let preview: TipsRecord = {
  guideShown: false,
  used: [],
  learned: [],
  told: [],
  off: false,
};
export async function tipsState(): Promise<TipsRecord> {
  if (!native) return structuredClone(preview);
  // A host with nothing to report counts as a fresh start.
  const record = await invoke<TipsRecord | null>("tips_state").catch(
    () => null,
  );
  return (
    record ?? { guideShown: false, used: [], learned: [], told: [], off: false }
  );
}
export function tipsUsed(feature: Feature) {
  if (native) void invoke("tips_used", { feature }).catch(() => {});
  else if (!preview.used.includes(feature)) preview.used.push(feature);
}
/** The user read about `feature` in 它会的事. */
export function tipsLearned(feature: string) {
  if (native) void invoke("tips_learned", { feature }).catch(() => {});
  else if (!preview.learned.includes(feature)) preview.learned.push(feature);
}
/** Whether the user has `feature` turned on; the same switches as tips.rs. */
export function switchedOn(
  s: {
    translation: boolean;
    copyTwice: boolean;
    vision: boolean;
    memory: boolean;
    reminders: boolean;
  },
  feature: string,
) {
  const on: Record<string, boolean> = {
    "copy-translate": s.translation && s.copyTwice,
    "menu-translate": s.translation,
    snip: s.vision,
    memory: s.memory,
    reminder: s.reminders,
  };
  return on[feature] ?? true;
}
export async function tipsOff(off: boolean) {
  if (native) await invoke("tips_off", { off });
  else preview = { ...preview, off };
}
export function guideShown() {
  if (native) void invoke("tips_guide_shown");
  else preview.guideShown = true;
}

/** What the pet says for tip `id`, with the user's own shortcuts. */
export function tipText(
  id: string,
  shortcuts: { chat: string; vision: string; panel: string; clipboard?: string },
) {
  return t(`tip.${id}` as Key, {
    key: shortcutLabel(shortcuts.chat),
    vision: shortcutLabel(shortcuts.vision),
    panel: shortcutLabel(shortcuts.panel),
    clipboard: shortcutLabel(shortcuts.clipboard ?? defaults.clipboardShortcut),
    copy: /Mac/.test(navigator.platform || navigator.userAgent)
      ? "⌘C"
      : "Ctrl+C",
  });
}
