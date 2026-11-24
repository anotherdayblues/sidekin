// Adapted from Holdem's press/release gating in PopupWindow.tsx (MIT).
// Start native dragging directly, without WebKit's HTML drag session.
let gestureSerial = 0;
export function nativeFileGesture(
  element: HTMLElement,
  start: (held: () => boolean) => Promise<void>,
) {
  element.draggable = false;
  element.dataset.nativeDrag = "true";
  let active: {
    id: number;
    x: number;
    y: number;
    held: boolean;
    started: boolean;
    token: string;
  } | null = null;
  element.addEventListener("dragstart", (e) => e.preventDefault());
  element.addEventListener("pointerdown", (e) => {
    if (e.button !== 0 || active) return;
    const action = (e.target as HTMLElement).closest("button,input");
    if (action && action !== element) return;
    active = {
      id: e.pointerId,
      x: e.clientX,
      y: e.clientY,
      held: true,
      started: false,
      token: String(++gestureSerial),
    };
    document.body.dataset.filePressed = active.token;
    element.setPointerCapture(e.pointerId);
  });
  element.addEventListener("pointermove", (e) => {
    const g = active;
    if (!g || g.started || g.id !== e.pointerId) return;
    if (!e.buttons) {
      g.held = false;
      if (document.body.dataset.filePressed === g.token)
        delete document.body.dataset.filePressed;
      active = null;
      return;
    }
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) < 6) return;
    e.preventDefault();
    g.started = true;
    void start(() => g.held && element.isConnected).finally(() => {
      if (document.body.dataset.filePressed === g.token)
        delete document.body.dataset.filePressed;
      if (element.hasPointerCapture(g.id)) element.releasePointerCapture(g.id);
      if (active === g) active = null;
    });
  });
  const end = (e: PointerEvent) => {
    if (active?.id !== e.pointerId) return;
    active.held = false;
    if (document.body.dataset.filePressed === active.token)
      delete document.body.dataset.filePressed;
    active = null;
    if (element.hasPointerCapture(e.pointerId))
      element.releasePointerCapture(e.pointerId);
  };
  element.addEventListener("pointerup", end);
  element.addEventListener("pointercancel", end);
  element.addEventListener("lostpointercapture", end);
}
