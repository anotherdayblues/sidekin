// Alibaba Cloud Model Studio, CosyVoice over WebSocket in duplex mode:
// run-task, continue-task per piece of text, finish-task. Audio arrives as
// binary frames.
import { binary, streamingSpeaker } from "./streaming.ts";
import { rate, socket, type Sink, type VoiceConfig } from "./voice.ts";

export function aliyunVoice(c: VoiceConfig, sink: Sink) {
  const id = crypto.randomUUID();
  const header = (action: string) => ({
    action,
    task_id: id,
    streaming: "duplex",
  });
  let ws: WebSocket;
  const send = (message: object) => ws.send(JSON.stringify(message));
  return streamingSpeaker(
    {
      open(on) {
        ws = socket(
          c.baseUrl ?? "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
          { Authorization: "bearer " + c.apiKey },
        );
        ws.onopen = () =>
          send({
            header: header("run-task"),
            payload: {
              task_group: "audio",
              task: "tts",
              function: "SpeechSynthesizer",
              model: c.model ?? "cosyvoice-v3-flash",
              parameters: {
                text_type: "PlainText",
                voice: c.voice,
                format: "pcm",
                sample_rate: rate(c),
              },
              input: {},
            },
          });
        ws.onmessage = (e) => {
          const bytes = binary(e.data);
          if (bytes) return on.audio(bytes);
          const event = JSON.parse(String(e.data))?.header?.event;
          if (event === "task-started") on.ready();
          else if (event === "task-finished") {
            on.finished();
            ws.close();
          } else if (event === "task-failed") on.failed("voice");
        };
        ws.onerror = () => on.failed("network");
        ws.onclose = () => on.failed("network");
      },
      send: (text) =>
        send({ header: header("continue-task"), payload: { input: { text } } }),
      finish: () =>
        send({ header: header("finish-task"), payload: { input: {} } }),
      cancel: () => ws.close(),
    },
    sink,
  );
}
