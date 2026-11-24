// Plays a spoken reply: 16-bit mono PCM chunks, queued back to back
// (plan/10 §9.2). Pure playback; who stops it and when is up to the caller.
/** `onSpeaking` hears when sound starts and when the last of it ends. */
export function speechPlayer(onSpeaking: (on: boolean) => void = () => {}) {
  let context: AudioContext | undefined,
    next = 0;
  const playing = new Set<AudioBufferSourceNode>();
  const settle = () => {
    if (!playing.size) {
      onSpeaking(false);
      void context?.suspend?.()?.catch(() => {});
    }
  };
  return {
    get speaking() {
      return playing.size > 0;
    },
    /** Queues one chunk after the ones already queued. */
    play(pcm: Uint8Array, rate: number) {
      const samples = Math.floor(pcm.length / 2);
      if (!samples) return;
      context ??= new AudioContext();
      void context.resume?.()?.catch(() => {});
      const view = new DataView(pcm.buffer, pcm.byteOffset, samples * 2);
      const buffer = context.createBuffer(1, samples, rate);
      const channel = buffer.getChannelData(0);
      for (let i = 0; i < samples; i++)
        channel[i] = view.getInt16(i * 2, true) / 32768;
      const source = context.createBufferSource();
      source.buffer = buffer;
      source.connect(context.destination);
      // A small lead keeps the first chunk from clicking in late.
      next = Math.max(next, context.currentTime + 0.05);
      source.start(next);
      next += buffer.duration;
      if (!playing.size) onSpeaking(true);
      playing.add(source);
      source.onended = () => {
        playing.delete(source);
        settle();
      };
    },
    stop() {
      for (const source of playing) {
        source.onended = null;
        source.stop();
      }
      const was = playing.size > 0;
      playing.clear();
      next = 0;
      if (was) onSpeaking(false);
      void context?.suspend?.()?.catch(() => {});
    },
  };
}

/** Base64 to bytes. */
export function fromBase64(text: string) {
  return Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
}
