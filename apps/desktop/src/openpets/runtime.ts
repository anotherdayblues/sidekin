import {
  defaultOutfitId,
  getEffectiveOutfitSchedule,
  isWardrobeOutfit,
  type PetWardrobePreference,
  type WardrobeDefinition,
} from "./vendor/wardrobe.ts";
import {
  resolvePetActivityAnimation,
  type PetActivity,
  type PetActivityAnimation,
  type PetActivityIdentity,
} from "./vendor/activities.ts";
import type { CodexPetGazeAnchor } from "./vendor/codex-pets-core.ts";

/** Namespace prefix keeping OpenPets activities separate from teaching.rs actions. */
export const ACTIVITY_CLIP_PREFIX = "activity:";

export function activityClipName(id: string): string {
  return `${ACTIVITY_CLIP_PREFIX}${id}`;
}

/** Milliseconds until just past the next local wall-clock minute boundary. */
export function msUntilNextMinute(now: Date): number {
  const remaining = 60_000 - (now.getSeconds() * 1000 + now.getMilliseconds());
  return Math.max(50, remaining + 50);
}

/**
 * Whether a pet needs the single minute-boundary wardrobe timer:
 * only when it has outfits, is not pinned to a single outfit, and has at least
 * one enabled schedule rule.
 */
export function hasActiveOutfitSchedule(
  wardrobe: WardrobeDefinition | undefined,
  preference: PetWardrobePreference | undefined,
): boolean {
  if (!wardrobe || wardrobe.outfits.length === 0) return false;
  if (
    preference?.outfit !== undefined &&
    isWardrobeOutfit(wardrobe, preference.outfit)
  ) {
    return false;
  }
  return getEffectiveOutfitSchedule(wardrobe, preference).some(
    (rule) => rule.enabled !== false && isWardrobeOutfit(wardrobe, rule.outfit),
  );
}

/**
 * Pure manual outfit resolution used by Suiby's Studio and desktop runtime:
 * wears the user's chosen outfit if still installed, otherwise falls back to
 * the pet's default appearance (never auto-switches on a timer).
 */
export function resolveManualOutfitId(
  wardrobe: WardrobeDefinition | undefined,
  preference: PetWardrobePreference | undefined,
): string {
  if (!wardrobe || wardrobe.outfits.length === 0) return defaultOutfitId;
  const chosen = preference?.outfit;
  if (chosen && isWardrobeOutfit(wardrobe, chosen)) return chosen;
  return defaultOutfitId;
}

/**
 * Effective enabled activity IDs for a pet.
 * Contract: absent preference => all installed activities enabled;
 * empty array [] => all disabled; stale IDs are dropped.
 */
export function enabledActivityIds(
  pet: { readonly id: string; readonly activities?: readonly PetActivityIdentity[] },
  preferences: Readonly<Record<string, readonly string[]>> | undefined,
): string[] {
  const activities = pet.activities ?? [];
  if (activities.length === 0) return [];
  const saved = preferences?.[pet.id];
  if (saved === undefined) return activities.map((activity) => activity.id);
  const installed = new Set(activities.map((activity) => activity.id));
  return saved.filter((id) => installed.has(id));
}

export function activityFrameDurations(
  animation: Pick<PetActivityAnimation, "frameCount" | "fps">,
): number[] {
  const frameMs = Math.max(1, Math.round(1000 / animation.fps));
  return Array.from({ length: animation.frameCount }, () => frameMs);
}

export interface MatchedActivityClip {
  readonly activity: PetActivity;
  readonly animation: PetActivityAnimation;
  readonly clipName: string;
  readonly durations: number[];
}

/**
 * Resolve every activity that has exact-outfit artwork for `outfitId`.
 * Activities lacking artwork for the worn outfit are omitted so wrong clothes
 * never flash.
 */
export function matchingActivitiesForOutfit(
  activities: readonly PetActivity[] | undefined,
  outfitId: string,
): MatchedActivityClip[] {
  if (!activities?.length) return [];
  const matched: MatchedActivityClip[] = [];
  for (const activity of activities) {
    const animation = resolvePetActivityAnimation(activity, outfitId);
    if (!animation) continue;
    matched.push({
      activity,
      animation,
      clipName: activityClipName(activity.id),
      durations: activityFrameDurations(animation),
    });
  }
  return matched;
}

/** Swap horizontal drag running actions when the sprite canvas is mirrored. */
export function dragActionForFlip<T extends string | null>(
  action: T,
  flipped: boolean,
): T {
  if (!flipped || !action) return action;
  if (action === "running-left") return "running-right" as T;
  if (action === "running-right") return "running-left" as T;
  return action;
}

/**
 * Compute gaze origin in canvas-local coordinates.
 * Without `gazeAnchor`, preserves Suiby's legacy center anchor.
 */
export function resolveGazeAnchor(
  rect: { readonly width: number; readonly height: number },
  gazeAnchor: CodexPetGazeAnchor | undefined,
  flipped: boolean,
): { x: number; y: number } {
  if (!gazeAnchor) return { x: rect.width / 2, y: rect.height / 2 };
  const normalizedX = flipped ? 1 - gazeAnchor.x : gazeAnchor.x;
  return {
    x: normalizedX * rect.width,
    y: gazeAnchor.y * rect.height,
  };
}

export { defaultOutfitId };
