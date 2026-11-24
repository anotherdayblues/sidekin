// OpenAI-compatible speech (OpenAI, Groq, SiliconFlow, local servers): one
// request per sentence, the PCM body streamed back as it is made.
import { sentences } from "./spoken.ts";
import {
  once,
  rate,
  type Sink,
  type Speaker,
  type VoiceConfig,
} from "./voice.ts";

export function openaiVoice(c: VoiceConfig, sink: Sink): Speaker {
  const finish = once(sink);
  const chunker = sentences();
  const queue: string[] = [];
  const stop = new AbortController();
  let busy = false,
    ended = false;
  const base = (c.baseUrl ?? "https://api.openai.com/v1").replace(/\/+$/, "");

  async function say(text: string) {
    const response = await fetch(base + "/audio/speech", {
      method: "POST",
      signal: stop.signal,
      headers: {
        Authorization: "Bearer " + c.apiKey,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: c.model ?? "gpt-4o-mini-tts",
        input: text,
        voice: c.voice,
        response_format: "pcm",
        ...(c.instructions && { instructions: c.instructions }),
        ...(c.sampleRate && { sample_rate: rate(c) }),
      }),
    });
    if (!response.ok || !response.body)
      throw Error([401, 403].includes(response.status) ? "auth" : "voice");
    // Samples are two bytes; a chunk can end in the middle of one.
    let carry: number | undefined;
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      let bytes = chunk;
      if (carry !== undefined) bytes = Uint8Array.of(carry, ...bytes);
      carry = bytes.length % 2 ? bytes[bytes.length - 1] : undefined;
      const even = bytes.subarray(0, bytes.length - (bytes.length % 2));
      if (even.length) sink.audio(even);
    }
  }
  async function pump() {
    if (busy) return;
    busy = true;
    try {
      while (queue.length && !stop.signal.aborted) await say(queue.shift()!);
    } catch (e) {
      if (!stop.signal.aborted) {
        stop.abort();
        const code = String((e as Error).message);
        finish(code === "auth" || code === "voice" ? code : "network");
      }
      return;
    } finally {
      busy = false;
    }
    if (ended && !queue.length && !stop.signal.aborted) finish();
  }
  return {
    push(text) {
      queue.push(...chunker.push(text));
      void pump();
    },
    end() {
      const rest = chunker.flush();
      if (rest) queue.push(rest);
      ended = true;
      void pump();
    },
    cancel() {
      stop.abort();
      finish();
    },
  };
}
