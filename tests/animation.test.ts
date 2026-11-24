import assert from "node:assert/strict";
import test from "node:test";
import {
  ACTIONS,
  ANIMATIONS,
  frameAt,
  gazeFrame,
  duration,
  RandomBehavior,
  normalizeBehavior,
  GazeAttention,
  GAZE,
  playbackPlan,
} from "../apps/desktop/src/animation.ts";
test("imported packages with a null optional behavior use defaults", () => {
  assert.equal(normalizeBehavior(null).minSeconds, 45);
  assert.equal(normalizeBehavior(null).clickAction, "open-studio");
});
test("all nine actions wrap without showing unused cells", () => {
  for (const a of ACTIONS) {
    assert.deepEqual(frameAt(a, 0).frame, 0);
    assert.equal(frameAt(a, duration(a)).frame, 0);
    assert.equal(
      frameAt(a, duration(a) - 1).frame,
      ANIMATIONS[a].durations.length - 1,
    );
  }
});
test("v2 gaze uses viewer coordinates and all sixteen cells", () => {
  assert.deepEqual(gazeFrame(0, -1), { row: 9, frame: 0 });
  assert.deepEqual(gazeFrame(1, 0), { row: 9, frame: 4 });
  assert.deepEqual(gazeFrame(0, 1), { row: 10, frame: 0 });
  assert.deepEqual(gazeFrame(-1, 0), { row: 10, frame: 4 });
  const cells = new Set(
    Array.from({ length: 16 }, (_, i) =>
      JSON.stringify(
        gazeFrame(Math.sin((i * Math.PI) / 8), -Math.cos((i * Math.PI) / 8)),
      ),
    ),
  );
  assert.equal(cells.size, 16);
});
test("base actions never come up at random; learned ones at their own rate (plan/29)", () => {
  const r = new RandomBehavior(() => 0.5),
    b = normalizeBehavior({ enabled: false, weights: { waving: 1 } });
  // Old saved weights and the old on/off switch no longer apply.
  assert.deepEqual(b.weights, {});
  assert.equal(b.enabled, true);
  assert.equal(r.next(0, b), null);
  assert.equal(r.deadline, null, "nothing random: no timer at all");
  // 20 an hour: about every 3 minutes.
  assert.equal(r.next(0, b, false, { "rule:spin": 20 }), null);
  assert.equal(r.deadline, 180_000);
  assert.equal(r.next(179_999, b, false, { "rule:spin": 20 }), null);
  assert.equal(r.next(180_000, b, false, { "rule:spin": 20 }), "rule:spin");
  // Two at 20 and 40 an hour: together 60, about every minute.
  const two = new RandomBehavior(() => 0.5);
  two.next(0, b, false, { "rule:spin": 20, "rule:yawn": 40 });
  assert.equal(two.deadline, 60_000);
});
test("quiet and interruption reset deadlines instead of catching up", () => {
  const r = new RandomBehavior(() => 0),
    b = normalizeBehavior(),
    pool = { "rule:spin": 40 };
  r.next(0, b, false, pool);
  r.next(1000, b, true, pool);
  // 40 an hour is 90 s on average; the roll of 0 takes half of it.
  assert.equal(r.deadline, 46000);
  assert.equal(r.next(100000, { ...b, enabled: false }, false, pool), null);
  assert.equal(r.deadline, null);
  assert.equal(r.next(200000, b, false, pool), null);
  assert.equal(r.deadline, 245000);
});
test("invalid or empty random pools remain safe", () => {
  const b = normalizeBehavior({
    minSeconds: -5,
    maxSeconds: Infinity,
    weights: { idle: 2, waving: NaN, jumping: -5 },
  });
  assert.equal(b.minSeconds, 5);
  assert.deepEqual(b.weights, {});
  const r = new RandomBehavior(() => 0);
  r.next(0, b);
  assert.equal(r.next(999999, b), null);
});

test("the desktop pet watches the mouse only for a while after a double-click", () => {
  const g = new GazeAttention();
  // Without a double-click it never looks at the mouse, near or far.
  assert.equal(g.update(0, 40, 0), null);
  assert.equal(g.update(500, 40, -20), null);
  assert.equal(g.awake, false);
  g.wake(1000);
  assert.equal(g.awake, true);
  assert.deepEqual(g.update(1100, 40, -20), { x: 40, y: -20 });
  assert.deepEqual(g.update(1000 + GAZE.afterDoubleClick - 1, 300, 0), {
    x: 300,
    y: 0,
  });
  // Time is up: back to the idle animation.
  assert.equal(g.update(1000 + GAZE.afterDoubleClick, 300, 0), null);
  assert.equal(g.awake, false);
});

test("focus looped running slows down 3x without affecting non-loop running or other actions", () => {
  const focusRun = playbackPlan("running", false, true);
  assert.deepEqual(
    focusRun.frames.map((f) => f.milliseconds),
    ANIMATIONS.running.durations.map((ms) => ms * 3),
  );
  const briskRun = playbackPlan("running", false, false);
  assert.deepEqual(
    briskRun.frames.slice(0, ANIMATIONS.running.durations.length).map((f) => f.milliseconds),
    ANIMATIONS.running.durations,
  );
  const loopedWait = playbackPlan("waiting", false, true);
  assert.deepEqual(
    loopedWait.frames.map((f) => f.milliseconds),
    ANIMATIONS.waiting.durations,
  );
});
