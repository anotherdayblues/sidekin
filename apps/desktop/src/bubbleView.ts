// What the bubble is doing now, in one place: the request it waits for, the
// mode, and what each mode remembers. The bubble's parts read and change
// this object instead of keeping their own copies.
import type { ApprovalRequest } from "./bubbleApproval.ts";

export type BubbleMode = "chat" | "translate" | "vision";
export type SelectionAction = "translate" | "explain" | "polish" | "summarize";

export interface BubbleView {
  /** The request the bubble waits for, or "" when none. */
  token: string;
  mode: BubbleMode;
  /** What was sent last, for 再试一次. */
  last: string;
  /** Why the last request failed; it picks the action button. */
  reason: string;
  /** A tool approval on screen; nothing else takes the card meanwhile. */
  approval?: ApprovalRequest;
  selectionAction: SelectionAction;
  /** plan/41: the user typed the text to translate (no selection). */
  typed: boolean;
  /** Where a selection came from, for 替换为译文; 0 when unknown. */
  replaceTarget: number;
  /** The language the last translation went into, when known. */
  into: string;
  /** The selection already shown, so the same one is not done twice. */
  lastGeneration: number;
  /** The last open request, so a repeat of it is ignored. */
  seenOpen: string;
  /** Capture used to start a screenshot conversation. */
  visionGeneration: number;
  screenshotTopic?: number;
}

export const newView = (): BubbleView => ({
  token: "",
  mode: "chat",
  last: "",
  reason: "",
  selectionAction: "translate",
  typed: false,
  replaceTarget: 0,
  into: "",
  lastGeneration: -1,
  seenOpen: "",
  visionGeneration: 0,
});
