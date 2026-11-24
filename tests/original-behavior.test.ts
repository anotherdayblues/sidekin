import test from "node:test";
import assert from "node:assert/strict";
import {
  playbackPlan,
  resolvedPetState,
  PetShape,
  statusAction,
  GAZE_ACTIONS,
  HOVER_CYCLES,
  HOVER_DURATION_MULTIPLIER,
} from "../apps/desktop/src/animation.ts";
import { DragMotion } from "../apps/desktop/src/movement.ts";
test("installed-client playback: slow idle and three action cycles", () => {
  const idle = playbackPlan("idle");
  assert.deepEqual(
    idle.frames.map((f) => f.milliseconds),
    [1680, 660, 660, 840, 840, 1920],
  );
  assert.equal(idle.loopStart, 0);
  const jump = playbackPlan("jumping");
  assert.equal(jump.loopStart, 15);
  assert.equal(jump.frames.length, 21);
  assert.equal(jump.frames[14].row, 4);
  assert.equal(jump.frames[15].row, 0);
  assert.equal(jump.frames[15].milliseconds, 1680);
});
test("hover greets with one slowed waiting cycle; other actions keep three cycles", () => {
  const hover = playbackPlan(
    "waiting",
    false,
    false,
    HOVER_CYCLES,
    HOVER_DURATION_MULTIPLIER,
  );
  assert.equal(HOVER_CYCLES, 1);
  assert.equal(HOVER_DURATION_MULTIPLIER, 2);
  assert.equal(hover.loopStart, 6);
  assert.equal(hover.frames.length, 12);
  assert.equal(hover.frames[0].milliseconds, 300);
  assert.equal(hover.frames[5].milliseconds, 520);
  assert.equal(hover.frames[6].row, 0);
  assert.equal(playbackPlan("jumping", false, false, undefined).loopStart, 15);
});
test("loop and reduced motion retain original semantics", () => {
  assert.equal(playbackPlan("running-right", false, true).frames.length, 8);
  assert.equal(playbackPlan("running-right", false, true).loopStart, 0);
  const reduced = playbackPlan("failed", true);
  assert.equal(reduced.frames.length, 1);
  assert.equal(reduced.frames[0].row, 5);
  assert.equal(reduced.loopStart, null);
});
test("drag overrides hover, hover overrides base state", () => {
  assert.equal(
    resolvedPetState("running-left", true, "failed"),
    "running-left",
  );
  assert.equal(resolvedPetState(null, true, "failed"), "waiting");
  assert.equal(resolvedPetState(null, false, "failed"), "failed");
  assert.deepEqual(GAZE_ACTIONS, ["idle", "running", "waving"]);
});
test("only the pet's own outline counts as hovering", () => {
  // A 20 x 20 cell (its opacity) with a solid 6 x 6 square in the middle.
  const w = 20,
    px = new Uint8Array(w * w);
  for (let y = 7; y < 13; y++) for (let x = 7; x < 13; x++) px[y * w + x] = 255;
  const shape = PetShape.from(px, w, 0, 0, w, w)!;
  const at = (x: number, y: number, hovered = false) =>
    shape.hit((x + 0.5) / w, (y + 0.5) / w, hovered);
  assert.equal(at(10, 10), true); // on the pet
  assert.equal(at(4, 10), true); // a few pixels off: still counts
  assert.equal(at(0, 0), false); // empty corner of the window
  assert.equal(at(0, 10), false);
  assert.equal(at(0, 10, true), true); // already on it: a wider outline
  assert.equal(at(-1, 10, true), false); // outside the window
  // A faint pet still gets an outline; an empty frame gets none.
  const faint = px.map((v) => (v ? 20 : v));
  assert.equal(PetShape.from(faint, w, 0, 0, w, w)!.hit(0.5, 0.5), true);
  assert.equal(PetShape.from(new Uint8Array(w * w), w, 0, 0, w, w), null);
});
test("native drag threshold and direction match the installed client", () => {
  const d = new DragMotion();
  d.begin(100, 100);
  assert.equal(d.moved(103, 100), null);
  assert.equal(d.hasMoved, false);
  assert.equal(d.moved(104, 100), "running-right");
  assert.equal(d.moved(100, 100), "running-left");
  assert.equal(d.end(), true);
  assert.equal(d.action, null);
});
test("notification-to-motion mapping remains available for future agent adapters", () => {
  assert.equal(statusAction({ kind: "first-awake" }), "waving");
  assert.equal(statusAction({ isLoading: true }), "running");
  assert.equal(statusAction({ level: "warning" }), "waiting");
  assert.equal(statusAction({ level: "danger" }), "failed");
  assert.equal(statusAction({ level: "success" }), "review");
  assert.equal(statusAction({ level: "info" }), "idle");
});
