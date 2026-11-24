// The pet's own hue, for the 番茄钟 clock's light to take on (系统原生 skin).
// Read once when the pet's sheet loads, never per frame: the first cell is
// shrunk to a few thousand pixels and the clear, grey, near-black and
// near-white ones are skipped; the remaining hues are weighed in 24 bins and
// the heaviest wins. A pet that is grey all over has no hue: the clock keeps
// the system accent.

export interface PetTint {
  /** Hue in degrees. */
  h: number;
  /** Saturation, 0–1, of the winning hue. */
  s: number;
}

/** The first cell of a pet sheet (player.ts reads frames at this size). */
const CELL = { w: 192, h: 208 };
/** How wide the cell is read: enough to find a hue, cheap to scan. */
const READ_W = 48;

function hsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255;
  g /= 255;
  b /= 255;
  const max = Math.max(r, g, b),
    min = Math.min(r, g, b),
    l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h =
    max === r
      ? (g - b) / d + (g < b ? 6 : 0)
      : max === g
        ? (b - r) / d + 2
        : (r - g) / d + 4;
  return [h * 60, s, l];
}

/** The main hue of RGBA pixels, or null when they are grey all over. */
export function tintOf(rgba: ArrayLike<number>): PetTint | null {
  const bins = Array.from({ length: 24 }, () => ({ w: 0, x: 0, y: 0, s: 0 }));
  let seen = 0,
    total = 0;
  for (let i = 0; i + 3 < rgba.length; i += 4) {
    if (rgba[i + 3] < 200) continue;
    seen++;
    const [h, s, l] = hsl(rgba[i], rgba[i + 1], rgba[i + 2]);
    if (s < 0.22 || l < 0.14 || l > 0.9) continue;
    const weight = s * (1 - Math.abs(l - 0.5) * 1.6);
    const bin = bins[Math.floor(h / 15) % 24];
    const a = (h * Math.PI) / 180;
    bin.w += weight;
    bin.x += Math.cos(a) * weight;
    bin.y += Math.sin(a) * weight;
    bin.s += s * weight;
    total += weight;
  }
  if (!seen || total / seen < 0.08) return null;
  const best = bins.reduce((m, b) => (b.w > m.w ? b : m));
  return {
    h: ((Math.atan2(best.y, best.x) * 180) / Math.PI + 360) % 360,
    s: best.s / best.w,
  };
}

/** Reads the first cell of a decoded pet sheet. */
export function petTint(image: HTMLImageElement): PetTint | null {
  const h = Math.round((READ_W * CELL.h) / CELL.w);
  const c = document.createElement("canvas");
  c.width = READ_W;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(image, 0, 0, CELL.w, CELL.h, 0, 0, READ_W, h);
  const tint = tintOf(ctx.getImageData(0, 0, READ_W, h).data);
  c.width = c.height = 0;
  return tint;
}

/** The clock's colors for a tint, as CSS custom properties: darker by day
 * and lighter by night so they read on glass, plus two neighbouring hues
 * and a pale one for the light's colors. */
export function tintColors(t: PetTint): Record<string, string> {
  const s = Math.round(Math.min(0.85, Math.max(0.55, t.s)) * 100);
  const at = (turn: number, l: number) =>
    `hsl(${Math.round((t.h + turn + 360) % 360)} ${s}% ${l}%)`;
  return {
    "--pet-tint": at(0, 52),
    "--pet-tint-2": at(18, 58),
    "--pet-tint-3": at(-20, 56),
    "--pet-tint-4": at(8, 74),
    "--pet-tint-night": at(0, 66),
    "--pet-tint-2-night": at(18, 70),
    "--pet-tint-3-night": at(-20, 68),
    "--pet-tint-4-night": at(8, 80),
  };
}
