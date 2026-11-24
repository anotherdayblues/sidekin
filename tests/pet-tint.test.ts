import test from "node:test";
import assert from "node:assert/strict";
import { tintColors, tintOf } from "../apps/desktop/src/petTint.ts";

/** RGBA pixels: `n` copies of each [r, g, b, a]. */
function pixels(...runs: [number, [number, number, number, number]][]) {
  const out: number[] = [];
  for (const [n, px] of runs) for (let i = 0; i < n; i++) out.push(...px);
  return out;
}

test("橘猫取到橙色：白肚皮和透明的地方不算", () => {
  const tint = tintOf(
    pixels(
      [60, [230, 140, 60, 255]],
      [30, [250, 248, 244, 255]],
      [200, [0, 0, 0, 0]],
    ),
  )!;
  assert.ok(tint.h > 20 && tint.h < 35, `hue ${tint.h}`);
  assert.ok(tint.s > 0.6);
});

test("颜色多的宠物取占得最多的那种", () => {
  const tint = tintOf(
    pixels([20, [220, 60, 60, 255]], [80, [60, 110, 220, 255]]),
  )!;
  assert.ok(tint.h > 210 && tint.h < 230, `hue ${tint.h}`);
});

test("红色跨过 0 度也取得对", () => {
  const tint = tintOf(
    pixels([50, [230, 50, 70, 255]], [50, [230, 70, 50, 255]]),
  )!;
  assert.ok(tint.h < 10 || tint.h > 350, `hue ${tint.h}`);
});

test("全身偏灰或几乎透明的宠物没有色调，时钟用系统色", () => {
  assert.equal(
    tintOf(pixels([80, [120, 120, 124, 255]], [20, [20, 20, 20, 255]])),
    null,
  );
  assert.equal(tintOf(pixels([100, [230, 140, 60, 40]])), null);
  assert.equal(tintOf([]), null);
});

test("取到的颜色白天深一点、夜里亮一点，饱和度有上下限", () => {
  const dull = tintColors({ h: 30, s: 0.2 });
  assert.equal(dull["--pet-tint"], "hsl(30 55% 52%)");
  assert.equal(dull["--pet-tint-night"], "hsl(30 55% 66%)");
  const loud = tintColors({ h: 350, s: 1 });
  assert.equal(loud["--pet-tint"], "hsl(350 85% 52%)");
  assert.equal(loud["--pet-tint-2"], "hsl(8 85% 58%)");
});
