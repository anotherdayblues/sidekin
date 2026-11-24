// How long a reply stays up and how fast it types out. Pure, so it is tested
// on its own; bubble.ts feeds it the CSS-configured base values.

/** Chinese reads at roughly 6–8 characters a second; 120 ms each is relaxed. */
const PER_CHAR_MS = 120;
/** Short replies keep the base time; this many characters are covered by it. */
const FREE_CHARS = 30;
const MAX_MS = 60000;

export function readingMs(baseMs: number, text: string) {
  const extra = Math.max(0, Array.from(text).length - FREE_CHARS) * PER_CHAR_MS;
  return Math.min(MAX_MS, baseMs + extra);
}

/** Once the model has finished, show what is left within about this long. */
const FINISH_SECONDS = 1.2;

export function typingRate(
  cfg: { cps: number; maxCps: number; backlog: number },
  queued: number,
  done: boolean,
) {
  const rate = queued > cfg.backlog ? cfg.maxCps : cfg.cps;
  return done ? Math.max(rate, queued / FINISH_SECONDS) : rate;
}
