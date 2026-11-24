// A short burst of confetti, drawn in code so every pet gets the same
// celebration (plan/19): paper strips thrown up from the pet's head, never
// higher than the window, then fluttering down, turning over as they fall.
// Colors come from CSS variables on the canvas (--confetti-1 … --confetti-5);
// canvas colors are the one place colors are read in code.
const PIECES = 30;
const LIFE = 1600;
const FADE = 450;

export function burst(
  canvas: HTMLCanvasElement,
  from: { x: number; y: number },
) {
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const ratio = devicePixelRatio || 1;
  const w = (canvas.width = Math.round(canvas.clientWidth * ratio));
  const h = (canvas.height = Math.round(canvas.clientHeight * ratio));
  const css = getComputedStyle(canvas);
  const colors = [1, 2, 3, 4, 5]
    .map((i) => css.getPropertyValue(`--confetti-${i}`).trim())
    .filter(Boolean);
  const unit = Math.min(w, h) / 100;
  const x0 = from.x * w,
    y0 = from.y * h;
  // Times in seconds. A piece rises for `up` seconds to a peak inside the
  // window, then falls slowly, as paper does, swaying side to side.
  const pieces = Array.from({ length: PIECES }, (_, i) => {
    const up = 0.32 + Math.random() * 0.18;
    const rise = Math.min(y0 - 4 * unit, (0.45 + Math.random() * 0.5) * y0);
    return {
      up,
      rise,
      // Spread sideways, but not out of the window.
      drift: (Math.random() - 0.5) * Math.min(x0, w - x0) * 1.6,
      fall: (14 + Math.random() * 14) * unit,
      sway: (2 + Math.random() * 3) * unit,
      swayRate: 5 + Math.random() * 4,
      flipRate: 7 + Math.random() * 7,
      turn: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 3,
      phase: Math.random() * Math.PI * 2,
      long: (5 + Math.random() * 3) * unit,
      wide: (1.8 + Math.random() * 0.8) * unit,
      color: colors[i % colors.length] || "#f3c518",
    };
  });
  const start = performance.now();
  function frame(now: number) {
    const t = (now - start) / 1000;
    ctx!.clearRect(0, 0, w, h);
    if (t * 1000 > LIFE) return;
    const fade = Math.min(1, (LIFE - t * 1000) / FADE);
    for (const p of pieces) {
      // Up with easing out to the peak, then a steady flutter down.
      const k = Math.min(1, t / p.up);
      const y =
        t < p.up
          ? y0 - p.rise * (1 - (1 - k) * (1 - k))
          : y0 - p.rise + p.fall * (t - p.up);
      const x =
        x0 +
        p.drift * Math.min(1, t / (p.up * 2)) +
        (t > p.up ? Math.sin((t - p.up) * p.swayRate + p.phase) * p.sway : 0);
      ctx!.save();
      ctx!.globalAlpha = fade;
      ctx!.fillStyle = p.color;
      ctx!.translate(x, y);
      ctx!.rotate(p.turn + p.spin * t);
      // Turning over: the strip narrows and widens as it flips.
      ctx!.scale(1, Math.cos(t * p.flipRate + p.phase));
      ctx!.fillRect(-p.long / 2, -p.wide / 2, p.long, p.wide);
      ctx!.restore();
    }
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);
}
