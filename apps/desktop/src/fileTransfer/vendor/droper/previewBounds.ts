// Copyright (c) 2026 maksimliakhavets — MIT (see LICENSE).
// Exact previewBounds excerpt from Droper d3cf56d01c83a1c04e751e9adf2eccc295f6338c.
export interface Rect {x:number;y:number;width:number;height:number}
/**
 * Places the preview next to the shelf, on the side facing the middle of the screen,
 * vertically centered on the shelf and clamped (and shrunk if needed) into the work area.
 */
export function previewBounds(shelf: Rect, work: Rect, size: { width: number; height: number }, gap = 8): Rect {
  const width = Math.min(size.width, work.width);
  const height = Math.min(size.height, work.height);
  const shelfCenter = shelf.x + shelf.width / 2;
  const workCenter = work.x + work.width / 2;
  let x = shelfCenter >= workCenter ? shelf.x - gap - width : shelf.x + shelf.width + gap;
  x = Math.min(Math.max(x, work.x), work.x + work.width - width);
  let y = Math.round(shelf.y + shelf.height / 2 - height / 2);
  y = Math.min(Math.max(y, work.y), work.y + work.height - height);
  return { x: Math.round(x), y, width, height };
}

