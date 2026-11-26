// Converts Tauri Webview onDragDropEvent `position` into CSS viewport coordinates.
// Verified in wry-0.57.1 + tauri-runtime-wry-2.12.3:
// - macOS emits logical points (NSDraggingInfo.draggingLocation) directly.
// - Windows / Linux emit physical pixels that must be divided by devicePixelRatio.
export interface DropPoint {
  x: number;
  y: number;
}

export function isMacPlatform(
  platform = typeof navigator !== "undefined"
    ? navigator.platform || navigator.userAgent
    : "",
): boolean {
  return /Mac/.test(platform);
}

export function dropEventPoint(
  position: DropPoint,
  opts?: { mac?: boolean; dpr?: number },
): DropPoint {
  const mac = opts?.mac ?? isMacPlatform();
  if (mac) return { x: position.x, y: position.y };
  const rawDpr =
    opts?.dpr ??
    (typeof globalThis.devicePixelRatio === "number"
      ? globalThis.devicePixelRatio
      : 1);
  const dpr = Number.isFinite(rawDpr) && rawDpr > 0 ? rawDpr : 1;
  return { x: position.x / dpr, y: position.y / dpr };
}
