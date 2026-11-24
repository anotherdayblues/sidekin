// 手机传文件 on the desktop pet (plan/20): the pet looks up when a phone
// starts sending and jumps when the files have landed (the flight into the
// pile is fileTransfer/phoneArrivals.ts). While receiving is on, it hands
// the host a picture of itself for the phone page's header, trimmed to the
// pet so it fills the circle there.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";

/** Quiet time after the last file before the pet jumps once for all. */
const SETTLE_MS = 700;

export async function petPhone(
  canvas: HTMLCanvasElement,
  react: (action: string) => void,
) {
  let on = false;
  if (!native) return { on: () => on };
  const sendAvatar = () => {
    const png = trimmed(canvas);
    if (png)
      void png.then(
        (bytes) => bytes && invoke("phone_avatar", { png: Array.from(bytes) }),
      );
  };
  const apply = (running: boolean) => {
    if (running && !on) sendAvatar();
    on = running;
  };
  // A host that has nothing to report counts as not receiving.
  const first = await invoke<{ running: boolean } | null>("phone_status").catch(
    () => null,
  );
  apply(first?.running ?? false);
  await listen<{ running: boolean }>("phone-changed", (e) =>
    apply(e.payload.running),
  );
  await listen("phone-incoming", () => react("waving"));
  let settle = 0;
  await listen("phone-arrived", () => {
    clearTimeout(settle);
    settle = window.setTimeout(() => react("jumping"), SETTLE_MS);
  });
  return { on: () => on };
}

/** The pet's current frame, cut to its visible pixels with a little room. */
function trimmed(canvas: HTMLCanvasElement): Promise<Uint8Array | null> | null {
  const { width: w, height: h } = canvas;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx || !w || !h) return null;
  const data = ctx.getImageData(0, 0, w, h).data;
  let l = w,
    t = h,
    r = 0,
    b = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++)
      if (data[(y * w + x) * 4 + 3] > 16) {
        l = Math.min(l, x);
        r = Math.max(r, x);
        t = Math.min(t, y);
        b = Math.max(b, y);
      }
  if (r <= l || b <= t) return null;
  const side = Math.max(r - l, b - t) * 1.08;
  const out = document.createElement("canvas");
  out.width = out.height = 192;
  const g = out.getContext("2d")!;
  const cx = (l + r) / 2,
    cy = (t + b) / 2;
  g.drawImage(canvas, cx - side / 2, cy - side / 2, side, side, 0, 0, 192, 192);
  return new Promise((done) =>
    out.toBlob(
      (blob) =>
        blob
          ? void blob.arrayBuffer().then((a) => done(new Uint8Array(a)))
          : done(null),
      "image/png",
    ),
  );
}
