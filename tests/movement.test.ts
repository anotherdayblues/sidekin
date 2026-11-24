import assert from "node:assert/strict";
import test from "node:test";
import { DragMotion } from "../apps/desktop/src/movement.ts";
import { normalizeBehavior } from "../apps/desktop/src/animation.ts";
test("releasing a stationary press remains a click", () => {
  const drag = new DragMotion();
  drag.begin(20, 20);
  drag.moved(22, 22);
  assert.equal(drag.end(), false);
});
test("cancelled or finished drags no longer change animation", () => {
  const drag = new DragMotion();
  drag.begin(20, 20);
  drag.moved(10, 20);
  drag.end();
  assert.equal(drag.moved(100, 100), null);
});
test("no base action comes up at random, locomotion included (plan/29)", () => {
  assert.deepEqual(
    normalizeBehavior({
      weights: { "running-left": 2, "running-right": 2, waving: 1 },
    }).weights,
    {},
  );
});
