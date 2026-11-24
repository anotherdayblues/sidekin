// Speaks a chat reply while it streams (plan/10 §9). The reply's text goes
// through the spoken filter to the configured voice; audio and the end go
// out as notifications the host sends to the pet window to play.
import { aliyunVoice } from "./aliyun.ts";
import { elevenlabsVoice } from "./elevenlabs.ts";
import { minimaxVoice } from "./minimax.ts";
import { openaiVoice } from "./openai.ts";
import { spokenFilter } from "./spoken.ts";
import { volcengineVoice } from "./volcengine.ts";
import { rate, type Sink, type Speaker, type VoiceConfig } from "./voice.ts";

export type { VoiceConfig } from "./voice.ts";
const voices = {
  openai: openaiVoice,
  aliyun: aliyunVoice,
  volcengine: volcengineVoice,
  minimax: minimaxVoice,
  elevenlabs: elevenlabsVoice,
};

export function validVoice(c: unknown): c is VoiceConfig {
  const v = c as VoiceConfig;
  return (
    !!v &&
    Object.hasOwn(voices, v.provider) &&
    typeof v.apiKey === "string" &&
    !!v.apiKey &&
    typeof v.voice === "string" &&
    !!v.voice
  );
}

/** Numbers every run of audio, across replies, so the pet window can drop
 * late audio from one it already stopped. */
let parts = 0;

export interface Speech {
  /** The reply's next delta. */
  push(delta: string): void;
  /** The reply's text was replaced (a retry, a correction). What was
   * already said stays said; a different text starts over. */
  rewind(text: string): void;
  /** The reply is complete. */
  end(): void;
  /** Stop now: the user stopped it, or a new message began. */
  cancel(): void;
}

export function speak(
  config: VoiceConfig,
  notify: (method: string, data: object) => void,
): Speech {
  let heard = "",
    filter = spokenFilter(),
    speaker: Speaker;
  const open = () => {
    const mine = ++parts;
    const sink: Sink = {
      audio: (pcm) =>
        notify("speech.audio", {
          part: mine,
          rate: rate(config),
          audio: Buffer.from(pcm).toString("base64"),
        }),
      done: (error) =>
        notify("speech.end", { part: mine, ...(error && { error }) }),
    };
    speaker = voices[config.provider](config, sink);
  };
  open();
  const push = (delta: string) => {
    heard += delta;
    const text = filter.push(delta);
    if (text) speaker.push(text);
  };
  return {
    push,
    rewind(text) {
      if (text.startsWith(heard)) return push(text.slice(heard.length));
      speaker.cancel();
      notify("speech.stop", {});
      filter = spokenFilter();
      open();
      // Cut back to what was already said: nothing new to say yet.
      const shorter = heard.startsWith(text);
      heard = "";
      if (!shorter) push(text);
      else heard = text;
    },
    end() {
      const rest = filter.flush();
      if (rest) speaker.push(rest);
      speaker.end();
    },
    cancel() {
      speaker.cancel();
      notify("speech.stop", {});
    },
  };
}
