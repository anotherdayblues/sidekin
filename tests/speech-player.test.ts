import test from "node:test";
import assert from "node:assert/strict";

// A stand-in for the browser's AudioContext: records what was scheduled.
const started: { at: number; samples: number[] }[] = [];
const sources: any[] = [];
let stopped = 0;
let resumed = 0;
let suspended = 0;
class FakeContext {
  currentTime = 1;
  destination = {};
  resume() {
    resumed++;
    return Promise.resolve();
  }
  suspend() {
    suspended++;
    return Promise.resolve();
  }
  createBuffer(_channels: number, length: number, rate: number) {
    const data = new Float32Array(length);
    return { duration: length / rate, getChannelData: () => data };
  }
  createBufferSource() {
    const source: any = {
      connect() {},
      start(at: number) {
        started.push({ at, samples: [...source.buffer.getChannelData(0)] });
      },
      stop() {
        stopped++;
      },
    };
    sources.push(source);
    return source;
  }
}
(globalThis as any).AudioContext = FakeContext;
const { speechPlayer, fromBase64 } =
  await import("../apps/desktop/src/speechPlayer.ts");

test("朗读播放：PCM 转成声音，一段接一段排着放，停止后全部停下", () => {
  const p = speechPlayer();
  // Two little-endian samples: 16384 (0.5) and -32768 (-1).
  p.play(Uint8Array.of(0x00, 0x40, 0x00, 0x80), 4);
  p.play(Uint8Array.of(0x00, 0x00, 0xff), 4); // half a sample is dropped
  assert.deepEqual(started[0].samples, [0.5, -1]);
  assert.equal(started[0].at, 1.05);
  assert.equal(
    started[1].at,
    1.05 + 0.5,
    "the second starts when the first ends",
  );
  assert.deepEqual(started[1].samples, [0]);
  assert.ok(p.speaking);
  p.stop();
  assert.equal(stopped, 2);
  assert.ok(!p.speaking);
  assert.equal(resumed, 2);
  assert.equal(suspended, 1);
  // Finishing naturally also suspends the AudioContext so its render thread stops.
  p.play(Uint8Array.of(0x00, 0x40), 4);
  sources.at(-1).onended();
  assert.ok(!p.speaking);
  assert.equal(suspended, 2);
  assert.deepEqual([...fromBase64("AEA=")], [0x00, 0x40]);
});
