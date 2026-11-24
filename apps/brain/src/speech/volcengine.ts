// Volcengine (Doubao speech) bidirectional synthesis: one connection, one
// session; each piece of text is a TaskRequest, the service splits sentences.
import { binary, streamingSpeaker } from "./streaming.ts";
import { decode, encode, Event } from "./volcengineFrames.ts";
import { rate, socket, type Sink, type VoiceConfig } from "./voice.ts";

export function volcengineVoice(c: VoiceConfig, sink: Sink) {
  const session = crypto.randomUUID();
  const params = {
    speaker: c.voice,
    audio_params: { format: "pcm", sample_rate: rate(c) },
  };
  const body = (event: number, extra: object = {}) => ({
    user: { uid: "suiban" },
    event,
    namespace: "BidirectionalTTS",
    req_params: { ...params, ...extra },
  });
  let ws: WebSocket;
  return streamingSpeaker(
    {
      open(on) {
        ws = socket(
          c.baseUrl ?? "wss://openspeech.bytedance.com/api/v3/tts/bidirection",
          {
            ...(c.appId
              ? { "X-Api-App-Id": c.appId, "X-Api-Access-Key": c.apiKey }
              : { "X-Api-Key": c.apiKey }),
            "X-Api-Resource-Id": c.resourceId ?? "seed-tts-2.0",
            "X-Api-Connect-Id": crypto.randomUUID(),
          },
        );
        ws.onopen = () => ws.send(encode(Event.StartConnection, {}));
        ws.onmessage = (e) => {
          const bytes = binary(e.data);
          if (!bytes) return;
          const f = decode(bytes);
          if (f.errorCode !== undefined) return on.failed("voice");
          switch (f.event) {
            case Event.ConnectionStarted:
              return ws.send(
                encode(Event.StartSession, body(Event.StartSession), session),
              );
            case Event.SessionStarted:
              return on.ready();
            case Event.TTSResponse:
              return f.audio && on.audio(f.audio);
            case Event.SessionFinished:
              ws.send(encode(Event.FinishConnection, {}));
              ws.close();
              return on.finished();
            case Event.ConnectionFailed:
              return on.failed("auth");
            case Event.SessionFailed:
              return on.failed("voice");
          }
        };
        ws.onerror = () => on.failed("network");
        ws.onclose = () => on.failed("network");
      },
      send: (text) =>
        ws.send(
          encode(Event.TaskRequest, body(Event.TaskRequest, { text }), session),
        ),
      finish: () => ws.send(encode(Event.FinishSession, {}, session)),
      cancel: () => {
        if (ws.readyState === WebSocket.OPEN)
          ws.send(encode(Event.CancelSession, {}, session));
        ws.close();
      },
    },
    sink,
  );
}
