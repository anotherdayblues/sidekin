import test from "node:test";
import assert from "node:assert/strict";
import {
  attachmentPositions,
  expandedBounds,
  type Geometry,
} from "../../apps/desktop/src/fileTransfer/pileLayout.ts";
test("right-side list clears the visible pet; narrow displays can open vertically", () => {
  const g: Geometry = {
    origin: { x: 0, y: 0 },
    pet: {
      width: 160,
      height: (160 * 208) / 192,
      body: { x: 0.2, y: 0.35, width: 0.6, height: 0.6 },
    },
    work: { x: -900, y: -200, width: 1280, height: 690 },
  };
  const p = attachmentPositions(["a"], g).a,
    anchor = { ...p, width: 64, height: 78 };
  const panel = expandedBounds(anchor, g, { width: 230, height: 220 });
  assert.ok(
    panel.x + panel.width <= g.pet!.body.x * 160 - 8,
    "left-opening list must clear the pet, not just the stack",
  );
  const tiny = { ...g, work: { x: 0, y: 0, width: 240, height: 500 } };
  const vertical = expandedBounds(anchor, tiny, { width: 230, height: 220 });
  assert.ok(
    vertical.y >=
      Math.max(
        anchor.y + anchor.height,
        (g.pet!.body.y + g.pet!.body.height) * g.pet!.height,
      ),
  );
  assert.ok(vertical.x >= 0 && vertical.x + vertical.width <= 240);
});
test("viewport rebasing moves pet and stack together and keeps their right-upper offset", () => {
  for (const width of [80, 160, 280]) {
    const pet = {
      width,
      height: (width * 208) / 192,
      body: { x: 0.2, y: 0.35, width: 0.6, height: 0.6 },
    };
    const base = {
      origin: { x: 0, y: 0 },
      pet,
      work: { x: 0, y: 0, width: 1280, height: 690 },
    };
    const shifted = { ...base, origin: { x: 240, y: -63 } };
    assert.deepEqual(
      attachmentPositions(["a"], base),
      attachmentPositions(["a"], shifted),
    );
    const point = attachmentPositions(["a"], base).a;
    assert.equal(point.y, pet.body.y * pet.height);
  }
});
