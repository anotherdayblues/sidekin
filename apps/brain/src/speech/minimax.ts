// MiniMax bidirectional speech: text at any size goes in, the service
// gathers sentences. Audio comes back hex-encoded in task_continued.
import { streamingSpeaker } from "./streaming.ts";
import { rate, socket, type Sink, type VoiceConfig } from "./voice.ts";

const hex = (s: string) =>
  Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));

export function minimaxVoice(c: VoiceConfig, sink: Sink) {
  let ws: WebSocket;
  const send = (message: object) => ws.send(JSON.stringify(message));
  return streamingSpeaker(
    {
      open(on) {
        ws = socket(c.baseUrl ?? "wss://api.minimax.cn/ws/v1/t2a_v2_bidi", {
          Authorization: "Bearer " + c.apiKey,
        });
        ws.onmessage = (e) => {
          const m = JSON.parse(String(e.data));
          const status = m.base_resp?.status_code ?? 0;
          if (status && status !== 2205)
            return on.failed(status === 1004 ? "auth" : "voice");
          if (m.event === "connected_success")
            send({
              event: "task_start",
              model: c.model ?? "speech-2.8-turbo",
              language_boost: "auto",
              voice_setting: { voice_id: c.voice, speed: 1, vol: 1, pitch: 0 },
              audio_setting: {
                sample_rate: rate(c),
                format: "pcm",
                channel: 1,
              },
            });
          else if (m.event === "task_started") on.ready();
          // The final message of a request repeats its audio in full.
          else if (m.event === "task_continued" && m.data?.audio && !m.is_final)
            on.audio(hex(m.data.audio));
          else if (m.event === "task_finished") {
            on.finished();
            ws.close();
          } else if (m.event === "task_failed") on.failed("voice");
        };
        ws.onerror = () => on.failed("network");
        ws.onclose = () => on.failed("network");
      },
      send: (text) => send({ event: "task_continue", text }),
      finish: () => send({ event: "task_finish" }),
      cancel: () => {
        if (ws.readyState === WebSocket.OPEN) send({ event: "task_cancel" });
        ws.close();
      },
    },
    sink,
  );
}
