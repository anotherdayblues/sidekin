// ElevenLabs input streaming: text goes in as it is written, base64 PCM
// comes back. An empty text ends the stream.
import { streamingSpeaker } from "./streaming.ts";
import { rate, socket, type Sink, type VoiceConfig } from "./voice.ts";

export function elevenlabsVoice(c: VoiceConfig, sink: Sink) {
  let ws: WebSocket;
  const send = (message: object) => ws.send(JSON.stringify(message));
  return streamingSpeaker(
    {
      open(on) {
        const base = c.baseUrl ?? "wss://api.elevenlabs.io/v1";
        const query = new URLSearchParams({
          model_id: c.model ?? "eleven_flash_v2_5",
          output_format: "pcm_" + rate(c),
        });
        ws = socket(
          `${base}/text-to-speech/${encodeURIComponent(c.voice)}/stream-input?${query}`,
          { "xi-api-key": c.apiKey },
        );
        ws.onopen = () => {
          send({ text: " " });
          on.ready();
        };
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data));
          if (m.error)
            return on.failed(/auth|key/i.test(m.error) ? "auth" : "voice");
          if (m.audio)
            on.audio(Uint8Array.from(atob(m.audio), (ch) => ch.charCodeAt(0)));
          if (m.isFinal) {
            on.finished();
            ws.close();
          }
        };
        ws.onerror = () => on.failed("network");
        ws.onclose = () => on.failed("network");
      },
      // A trailing space after a word tells it the word is complete.
      send: (text) => send({ text: /\w$/.test(text) ? text + " " : text }),
      finish: () => send({ text: "" }),
      cancel: () => ws.close(),
    },
    sink,
  );
}
