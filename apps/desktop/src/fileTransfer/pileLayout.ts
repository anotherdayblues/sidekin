import { previewBounds, type Rect } from "./vendor/droper/previewBounds.ts";
export interface Geometry {
  origin: { x: number; y: number };
  work: Rect;
  pet?: { width: number; height: number; body: Rect };
  positions?: Record<string, { x: number; y: number }>;
}
export const DEFAULT_GEOMETRY: Geometry = {
  origin: { x: 0, y: 0 },
  work: { x: 0, y: 0, width: 544, height: 400 },
  pet: { width: 192, height: 208, body: { x: 0, y: 0, width: 1, height: 1 } },
};
// Same placement as layout::attachments in src-tauri/src/file_transfer/layout.rs;
// change both together.
export function attachmentPositions(ids: string[], geometry: Geometry) {
  const pet = geometry.pet ?? DEFAULT_GEOMETRY.pet!;
  const out: Record<string, { x: number; y: number }> = {};
  for (let i = 0; i < ids.length; i++)
    out[ids[i]] = {
      x: (pet.body.x + pet.body.width) * pet.width - 24 + i * 4,
      y: pet.body.y * pet.height + i * 4,
    };
  return out;
}
export function expandedBounds(
  anchor: Rect,
  geometry: Geometry,
  size: { width: number; height: number },
): Rect {
  const body = geometry.pet?.body,
    pet = geometry.pet;
  const reference =
    body && pet
      ? {
          x: geometry.origin.x + body.x * pet.width,
          y: geometry.origin.y + body.y * pet.height,
          width: body.width * pet.width,
          height: body.height * pet.height,
        }
      : anchor;
  const x = Math.min(reference.x, anchor.x),
    y = Math.min(reference.y, anchor.y);
  const group = {
    x,
    y,
    width: Math.max(reference.x + reference.width, anchor.x + anchor.width) - x,
    height:
      Math.max(reference.y + reference.height, anchor.y + anchor.height) - y,
  };
  const w = geometry.work,
    left = group.x - w.x - 8,
    right = w.x + w.width - group.x - group.width - 8;
  const above = group.y - w.y - 8,
    below = w.y + w.height - group.y - group.height - 8;
  // Reuse Droper's horizontal placement. A narrow display can instead flip
  // vertically, keeping both the visible pet and the stack clear of the list.
  if (
    Math.max(left, right) < Math.min(size.width, 160) &&
    Math.max(above, below) >= 80
  ) {
    const width = Math.min(size.width, w.width),
      height = Math.min(size.height, Math.max(above, below));
    return {
      x: Math.max(w.x, Math.min(w.x + w.width - width, group.x)),
      y: below >= above ? group.y + group.height + 8 : group.y - height - 8,
      width,
      height,
    };
  }
  return previewBounds(group, w, {
    width: Math.max(80, Math.min(size.width, Math.max(left, right))),
    height: size.height,
  });
}
/** Largest size of the expanded list; --ft-panel-width in lab.css matches it. */
export const PANEL = { width: 360, height: 300 };
/** Keeps a placed list on screen, and never shorter than one row. */
export function panelMaxHeight(placement: Rect, work: Rect) {
  return Math.max(
    30,
    Math.min(
      placement.height,
      PANEL.height,
      work.y + work.height - placement.y,
    ),
  );
}
