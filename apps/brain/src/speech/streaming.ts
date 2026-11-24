// The shape shared by voices that take text as it streams: queue text until
// the service says it is ready, then pass it straight on. The service
// decides where sentences end (plan/10 §9.2).
import { once, type Sink, type Speaker, type SpeechError } from "./voice.ts";

export interface Protocol {
  /** Call `ready()` when text may be sent, `audio()` for each chunk,
   * `finished()` when the service is done, `failed()` on its error. */
  open(events: {
    ready(): void;
    audio(pcm: Uint8Array): void;
    finished(): void;
    failed(error: SpeechError): void;
  }): void;
  send(text: string): void;
  finish(): void;
  /** Tell the service to stop and close. */
  cancel(): void;
}

export function streamingSpeaker(protocol: Protocol, sink: Sink): Speaker {
  const finish = once(sink);
  const queue: string[] = [];
  let ready = false,
    ended = false,
    stopped = false;
  protocol.open({
    ready() {
      ready = true;
      for (const text of queue.splice(0)) protocol.send(text);
      if (ended) protocol.finish();
    },
    audio(pcm) {
      if (!stopped) sink.audio(pcm);
    },
    finished() {
      stopped = true;
      finish();
    },
    failed(error) {
      if (stopped) return;
      stopped = true;
      protocol.cancel();
      finish(error);
    },
  });
  return {
    push(text) {
      if (stopped || !text) return;
      if (ready) protocol.send(text);
      else queue.push(text);
    },
    end() {
      if (stopped || ended) return;
      ended = true;
      if (ready) protocol.finish();
    },
    cancel() {
      if (stopped) return;
      stopped = true;
      protocol.cancel();
      finish();
    },
  };
}

/** The bytes of a WebSocket message, or null for text. */
export function binary(data: unknown) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data))
    return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  return null;
}
