// The binary frames of Volcengine's bidirectional speech API (V3): a 4-byte
// header, then an event number, an id and a payload, all big-endian.
import { gunzipSync } from "node:zlib";

export const Event = {
  StartConnection: 1,
  FinishConnection: 2,
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  StartSession: 100,
  CancelSession: 101,
  FinishSession: 102,
  SessionStarted: 150,
  SessionCanceled: 151,
  SessionFinished: 152,
  SessionFailed: 153,
  TaskRequest: 200,
  TTSResponse: 352,
} as const;
const CONNECTION = new Set<number>([1, 2, 50, 51, 52]);
const FULL_CLIENT = 0b0001,
  AUDIO_SERVER = 0b1011,
  ERROR = 0b1111,
  WITH_EVENT = 0b0100,
  JSON_BODY = 0b0001,
  GZIP = 0b0001;

/** A JSON request with an event; session events carry the session id. */
export function encode(event: number, payload: object, session?: string) {
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const id =
    session === undefined ? undefined : new TextEncoder().encode(session);
  const out = new Uint8Array(
    4 + 4 + (id ? 4 + id.length : 0) + 4 + body.length,
  );
  const view = new DataView(out.buffer);
  out.set([0x11, (FULL_CLIENT << 4) | WITH_EVENT, JSON_BODY << 4, 0]);
  let at = 4;
  view.setInt32(at, event);
  at += 4;
  if (id) {
    view.setUint32(at, id.length);
    out.set(id, at + 4);
    at += 4 + id.length;
  }
  view.setUint32(at, body.length);
  out.set(body, at + 4);
  return out;
}

export interface Frame {
  event?: number;
  /** Audio bytes for TTSResponse; otherwise the parsed JSON, if any. */
  audio?: Uint8Array;
  json?: Record<string, unknown>;
  errorCode?: number;
}

export function decode(bytes: Uint8Array): Frame {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const type = bytes[1] >> 4,
    flags = bytes[1] & 0x0f,
    serialization = bytes[2] >> 4,
    compression = bytes[2] & 0x0f;
  let at = (bytes[0] & 0x0f) * 4;
  const frame: Frame = {};
  if (type === ERROR) {
    frame.errorCode = view.getUint32(at);
    at += 4;
  } else if (flags & WITH_EVENT) {
    frame.event = view.getInt32(at);
    at += 4;
    // Every event the server sends carries an id: the connection id for
    // connection events, the session id for the rest.
    if (frame.event >= 50 || !CONNECTION.has(frame.event)) {
      const size = view.getUint32(at);
      at += 4 + size;
    }
  }
  const size = view.getUint32(at);
  let body = bytes.subarray(at + 4, at + 4 + size);
  if (compression === GZIP) body = gunzipSync(body);
  if (type === AUDIO_SERVER) frame.audio = body;
  else if (serialization === JSON_BODY && body.length)
    frame.json = JSON.parse(new TextDecoder().decode(body));
  return frame;
}
