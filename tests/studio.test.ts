import assert from "node:assert/strict";
import test from "node:test";
import { Spring } from "../apps/desktop/src/spring.ts";
import { resolveTheme } from "../apps/desktop/src/theme.ts";

test("springs settle on target and keep thrown velocity", () => {
  const s = new Spring(0);
  s.target = 1;
  let overshoot = 0;
  for (let i = 0; i < 120; i++) {
    s.step(1 / 60);
    overshoot = Math.max(overshoot, s.value);
  }
  assert.equal(s.value, 1);
  assert.ok(s.settled);
  assert.ok(overshoot > 1, "a little overshoot reads as physical");
  assert.ok(overshoot < 1.2, "but never wobbly");

  const thrown = new Spring(0);
  thrown.velocity = 20;
  thrown.step(1 / 60);
  assert.ok(thrown.value > 0.2, "velocity carries into the first frame");
});

test("springs survive long frames without exploding", () => {
  const s = new Spring(0, { stiffness: 900, damping: 10 });
  s.target = 100;
  s.step(2);
  assert.ok(Number.isFinite(s.value) && Math.abs(s.value) < 400);
});

test("theme follows the system, a fixed choice, or the clock", () => {
  assert.equal(resolveTheme("system", true), "night");
  assert.equal(resolveTheme("system", false), "day");
  assert.equal(resolveTheme("night", false), "night");
  assert.equal(
    resolveTheme("clock", false, new Date(2026, 10, 4, 22)),
    "night",
  );
  assert.equal(resolveTheme("clock", true, new Date(2026, 10, 4, 7)), "day");
  assert.equal(
    resolveTheme("clock", true, new Date(2026, 10, 4, 6, 59)),
    "night",
  );
});
