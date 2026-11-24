// 番茄钟 sounds (plan/19), made in code so there are no audio files: a soft
// two-note chime when a tomato is done, and an optional background while
// focusing (white noise, rain, or now and then a turning page). The pet
// window plays them, the same way it plays the pet's voice.
import type { FocusSettings } from "./focus.ts";

let context: AudioContext | undefined;
let ambientOn = false;
let chimeUntil = 0;
let suspendTimer = 0;

const audio = () => {
  clearTimeout(suspendTimer);
  suspendTimer = 0;
  context ??= new AudioContext();
  void context.resume?.()?.catch(() => {});
  return context;
};

const scheduleSuspend = (delayMs: number) => {
  clearTimeout(suspendTimer);
  suspendTimer = window.setTimeout(() => {
    suspendTimer = 0;
    if (!ambientOn && Date.now() >= chimeUntil && context?.state === "running")
      void context.suspend?.()?.catch(() => {});
  }, delayMs);
};

/** A soft two-note chime, at `volume` 0–100. */
export function chime(volume: number, kind: "done" | "rested" = "done") {
  const ctx = audio(),
    now = ctx.currentTime;
  const notes =
    kind === "rested"
      ? [
          [784, 0],
          [1046.5, 0.16],
        ]
      : [
          [880, 0],
          [1318.5, 0.18],
        ];
  notes.forEach(([freq, delay]) => {
    const osc = ctx.createOscillator(),
      gain = ctx.createGain();
    osc.type = "sine";
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0, now + delay);
    gain.gain.linearRampToValueAtTime((volume / 100) * 0.25, now + delay + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + delay + 1.4);
    osc.connect(gain).connect(ctx.destination);
    osc.start(now + delay);
    osc.stop(now + delay + 1.5);
  });
  chimeUntil = Math.max(chimeUntil, Date.now() + 1800);
  scheduleSuspend(1850);
}

/** Two seconds of noise, looped: white, or softer brown for "noise". */
function noise(ctx: AudioContext, brown: boolean) {
  const buffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const data = buffer.getChannelData(0);
  let last = 0;
  for (let i = 0; i < data.length; i++) {
    const white = Math.random() * 2 - 1;
    last = brown ? (last + 0.02 * white) / 1.02 : white;
    data[i] = brown ? last * 3.5 : white;
  }
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  return source;
}

/** The background sound while focusing; one at a time. */
export function ambience() {
  let stop: (() => void) | null = null,
    playing = "";
  return {
    set(kind: FocusSettings["ambient"] | "", volume: number) {
      const key = kind ? `${kind}:${volume}` : "";
      if (key === playing) return;
      stop?.();
      stop = null;
      playing = key;
      if (!kind || kind === "off") return;
      ambientOn = true;
      const ctx = audio(),
        out = ctx.createGain(),
        level = (volume / 100) * 0.35;
      out.gain.setValueAtTime(0, ctx.currentTime);
      out.gain.linearRampToValueAtTime(level, ctx.currentTime + 2);
      out.connect(ctx.destination);
      const parts: AudioScheduledSourceNode[] = [];
      let timer = 0;
      if (kind === "noise") {
        const src = noise(ctx, true);
        src.connect(out);
        parts.push(src);
      } else if (kind === "rain") {
        // Rain: band-passed noise that swells a little, like gusts.
        const src = noise(ctx, false),
          band = ctx.createBiquadFilter(),
          swell = ctx.createGain(),
          lfo = ctx.createOscillator(),
          depth = ctx.createGain();
        band.type = "bandpass";
        band.frequency.value = 1800;
        band.Q.value = 0.6;
        lfo.frequency.value = 0.12;
        depth.gain.value = 0.25;
        swell.gain.value = 0.75;
        lfo.connect(depth).connect(swell.gain);
        src.connect(band).connect(swell).connect(out);
        parts.push(src, lfo);
      } else {
        // Pages: quiet now and then, a short swish.
        const turn = () => {
          const src = noise(ctx, false),
            band = ctx.createBiquadFilter(),
            env = ctx.createGain(),
            t = ctx.currentTime;
          band.type = "bandpass";
          band.frequency.setValueAtTime(2500, t);
          band.frequency.linearRampToValueAtTime(900, t + 0.35);
          env.gain.setValueAtTime(0, t);
          env.gain.linearRampToValueAtTime(1, t + 0.06);
          env.gain.exponentialRampToValueAtTime(0.001, t + 0.45);
          src.connect(band).connect(env).connect(out);
          src.start(t);
          src.stop(t + 0.5);
          timer = window.setTimeout(turn, 5000 + Math.random() * 7000);
        };
        timer = window.setTimeout(turn, 1500);
      }
      for (const p of parts) p.start();
      stop = () => {
        clearTimeout(timer);
        ambientOn = false;
        const t = ctx.currentTime;
        out.gain.cancelScheduledValues(t);
        out.gain.setValueAtTime(out.gain.value, t);
        out.gain.linearRampToValueAtTime(0, t + 1.5);
        for (const p of parts) p.stop(t + 1.6);
        scheduleSuspend(1700);
      };
    },
  };
}
