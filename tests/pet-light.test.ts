import test from "node:test";
import assert from "node:assert/strict";
import { petLight } from "../apps/desktop/src/petLight.ts";

test("精密玩具的光保持原样，系统原生有自己的光，其他皮肤不打光", () => {
  assert.deepEqual(petLight("studio", "night", 0), {
    rim: "rgb(255, 205, 140)",
    top: "rgba(255, 186, 104, 0.26)",
    mid: "rgba(255, 170, 90, 0.06)",
    base: "rgba(18, 9, 3, 0.55)",
    glow: 0.5,
  });
  assert.deepEqual(petLight("studio", "day", 1), {
    rim: "rgb(255, 226, 172)",
    top: "rgba(255, 226, 170, 0.22)",
    mid: "rgba(255, 240, 220, 0)",
    base: "rgba(70, 60, 80, 0.16)",
    glow: 0.2,
  });

  const noon = petLight("native", "day", 0)!,
    evening = petLight("native", "day", 1)!;
  assert.notEqual(noon.rim, evening.rim, "a low sun warms the native rim");
  assert.ok(evening.glow <= 0.2, "native light stays gentler than the toy's");
  assert.match(petLight("native", "night", 0)!.rim, /rgb\(1\d\d, 2\d\d, 255\)/);
});
