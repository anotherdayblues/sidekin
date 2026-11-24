import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { SpritePlayer } from "../apps/desktop/src/player.ts";

test("a taught action enters once, loops until released, finishes the cycle and exits once", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const canvas = {
    getContext: () => ({ clearRect() {}, drawImage() {} }),
    dispatchEvent: () => true,
  } as unknown as HTMLCanvasElement;
  const p = new SpritePlayer(canvas);
  p.image = {} as HTMLImageElement;
  // Skip PNG decode here; run the same scheduler as the desk and studio.
  Object.assign(p, {
    clips: new Map([
      [
        "paint",
        {
          durations: [100, 100, 100, 100, 100],
          loopFrames: [2, 4],
          image: p.image,
        },
      ],
    ]),
  });
  const done = mock.fn();
  p.onComplete = done;
  p.playSteps("paint");
  const frames = [p.pose().frame];
  for (let i = 0; i < 7; i++) {
    t.mock.timers.tick(100);
    frames.push(p.pose().frame);
  }
  assert.deepEqual(frames, [0, 1, 2, 3, 1, 2, 3, 1]);
  assert.equal(p.endSustained(), true);
  for (const frame of [2, 3, 4]) {
    t.mock.timers.tick(100);
    assert.equal(p.pose().frame, frame);
  }
  t.mock.timers.tick(100);
  assert.equal(p.requestedAction, "idle");
  assert.equal(done.mock.callCount(), 1);
  p.destroy();
});

test("the window hears when a sustained clip enters and leaves its held loop (the sleeping z's)", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const heard: { action: string; on: boolean }[] = [];
  const canvas = {
    getContext: () => ({ clearRect() {}, drawImage() {} }),
    dispatchEvent: (e: CustomEvent) => heard.push(e.detail),
  } as unknown as HTMLCanvasElement;
  const p = new SpritePlayer(canvas);
  p.image = {} as HTMLImageElement;
  Object.assign(p, {
    clips: new Map([
      [
        "sleep",
        {
          durations: [100, 100, 100, 100, 100],
          loopFrames: [2, 4],
          image: p.image,
        },
      ],
    ]),
  });
  p.playSteps("sleep");
  // Lying down (frame 0) is not asleep yet.
  assert.deepEqual(heard, []);
  t.mock.timers.tick(100);
  assert.deepEqual(
    heard.map(({ action, on }) => ({ action, on })),
    [{ action: "sleep", on: true }],
  );
  t.mock.timers.tick(500);
  assert.equal(heard.length, 1, "no repeats while it stays asleep");
  // Waking: the getting-up frames are no longer asleep.
  p.endSustained();
  t.mock.timers.tick(100);
  assert.deepEqual(heard.at(-1), { action: "sleep", on: false, top: null });
  p.destroy();
});

test("the z's stand on the sleeping pose's own top, whatever the pet's shape", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const heard: { top: { x: number; y: number } | null }[] = [];
  const canvas = {
    getContext: () => ({ clearRect() {}, drawImage() {} }),
    dispatchEvent: (e: CustomEvent) => heard.push(e.detail),
  } as unknown as HTMLCanvasElement;
  const p = new SpritePlayer(canvas);
  p.image = {} as HTMLImageElement;
  // Two frames, 192 wide each; the sleeping one holds a block from row 104,
  // columns 40 to 80, and one stray dot above it that must not count.
  const width = 384;
  // The sheet's opacity, one byte a pixel (player.ts keeps only that).
  const alpha = new Uint8Array(width * 208);
  const fill = (x: number, y: number) => (alpha[y * width + x] = 255);
  for (let y = 104; y < 160; y++)
    for (let x = 192 + 40; x <= 192 + 80; x++) fill(x, y);
  fill(192 + 150, 20);
  Object.assign(p, {
    clips: new Map([
      [
        "sleep",
        {
          durations: [100, 100],
          loopFrames: [2, 2],
          image: { width } as HTMLImageElement,
          alpha,
        },
      ],
    ]),
  });
  p.playSteps("sleep");
  t.mock.timers.tick(100);
  const top = heard[0]?.top;
  assert.ok(top);
  assert.equal(top.y, 104 / 208);
  assert.equal(top.x, 60 / 192);
  p.destroy();
});
