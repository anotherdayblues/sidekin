// The pieces every voice service shares (plan/10 §9.4).

export type VoiceProvider =
  "openai" | "aliyun" | "volcengine" | "minimax" | "elevenlabs";

/** One voice as the host configures it. Only `provider`, `apiKey` and
 * `voice` are required; the rest fall back to each service's default. */
export interface VoiceConfig {
  provider: VoiceProvider;
  apiKey: string;
  voice: string;
  /** Overrides the service's endpoint (a region, a workspace, a proxy). */
  baseUrl?: string;
  model?: string;
  /** PCM samples per second; 24000 unless set. */
  sampleRate?: number;
  /** OpenAI-compatible: how to speak, e.g. "温柔、轻快". */
  instructions?: string;
  /** Volcengine: X-Api-Resource-Id, "seed-tts-2.0" unless set. */
  resourceId?: string;
  /** Volcengine's older console: the App ID; the key is then the access key. */
  appId?: string;
}

/** Where a voice sends its audio: 16-bit mono PCM at the configured rate. */
export interface Sink {
  audio(pcm: Uint8Array): void;
  /** Called once: when all audio is out, or with why it stopped. */
  done(error?: SpeechError): void;
}
/** auth: the key or endpoint was refused; voice: the service said no;
 * network: the connection failed or closed early. */
export type SpeechError = "auth" | "voice" | "network";

/** A running voice. Text goes in as it is written; `end` says no more is
 * coming; `cancel` stops it at once and tells the service. */
export interface Speaker {
  push(text: string): void;
  end(): void;
  cancel(): void;
}

export const rate = (c: VoiceConfig) => c.sampleRate ?? 24000;

/** A WebSocket with request headers (Bun and Node both take them). */
export function socket(url: string, headers: Record<string, string>) {
  const ws = new WebSocket(url, { headers } as unknown as string[]);
  ws.binaryType = "arraybuffer";
  return ws;
}

/** Runs `done` once, however the voice ends. */
export function once(sink: Sink) {
  let finished = false;
  return (error?: SpeechError) => {
    if (finished) return;
    finished = true;
    sink.done(error);
  };
}
