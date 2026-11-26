import assert from "node:assert/strict";
import test from "node:test";
import { dropEventPoint, isMacPlatform } from "../apps/desktop/src/dropPoint.ts";
import {
  fileMenuItems,
  sendPetLabel,
} from "../apps/desktop/src/fileTransfer/fileMenu.ts";

test("isMacPlatform detects macOS platform/userAgent strings and rejects Windows/Linux", () => {
  assert.equal(isMacPlatform("MacIntel"), true);
  assert.equal(isMacPlatform("MacARM"), true);
  assert.equal(
    isMacPlatform("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)"),
    true,
  );
  assert.equal(isMacPlatform("Win32"), false);
  assert.equal(isMacPlatform("Linux x86_64"), false);
  assert.equal(isMacPlatform(""), false);
});

test("dropEventPoint keeps macOS logical points unscaled and divides Windows/Linux physical pixels by dpr", () => {
  // macOS Retina (2x / 3x): wry already reports logical points
  assert.deepEqual(
    dropEventPoint({ x: 320, y: 480 }, { mac: true, dpr: 2 }),
    { x: 320, y: 480 },
  );
  assert.deepEqual(
    dropEventPoint({ x: 180, y: 92 }, { mac: true, dpr: 3 }),
    { x: 180, y: 92 },
  );

  // Windows / Linux HiDPI: physical pixels -> CSS viewport coords
  assert.deepEqual(
    dropEventPoint({ x: 640, y: 960 }, { mac: false, dpr: 2 }),
    { x: 320, y: 480 },
  );
  assert.deepEqual(
    dropEventPoint({ x: 450, y: 300 }, { mac: false, dpr: 1.5 }),
    { x: 300, y: 200 },
  );
  assert.deepEqual(
    dropEventPoint({ x: 120, y: 240 }, { mac: false, dpr: 1 }),
    { x: 120, y: 240 },
  );

  // Guard against invalid/zero dpr
  assert.deepEqual(
    dropEventPoint({ x: 200, y: 300 }, { mac: false, dpr: 0 }),
    { x: 200, y: 300 },
  );
  assert.deepEqual(
    dropEventPoint({ x: 200, y: 300 }, { mac: false, dpr: Number.NaN }),
    { x: 200, y: 300 },
  );
});

test("fileMenuItems places sendPet directly below sendPhone only when companion is enabled and falls back cleanly on empty pet name", () => {
  assert.equal(sendPetLabel("栗子"), "发给栗子");
  assert.equal(sendPetLabel("  小橘  "), "发给小橘");
  assert.equal(sendPetLabel(""), "发给随伴");
  assert.equal(sendPetLabel("   "), "发给随伴");

  const offItems = fileMenuItems(
    1,
    ["/tmp/a.pdf"],
    { send: () => {}, remove: () => {} },
    true,
  );
  assert.deepEqual(
    offItems.map((i) => ("id" in i ? i.id : i.item)),
    ["file-send-1", "file-reveal-1", "Separator", "file-remove-1"],
  );

  let sentToPet = false;
  const onItems = fileMenuItems(
    2,
    ["/tmp/a.pdf"],
    {
      send: () => {},
      sendPet: {
        label: sendPetLabel("栗子"),
        action: () => {
          sentToPet = true;
        },
      },
      remove: () => {},
    },
    true,
  );
  assert.deepEqual(
    onItems.map((i) => ("id" in i ? i.id : i.item)),
    [
      "file-send-2",
      "file-send-pet-2",
      "file-reveal-2",
      "Separator",
      "file-remove-2",
    ],
  );
  const sendPetItem = onItems[1];
  assert.ok("text" in sendPetItem && sendPetItem.text === "发给栗子");
  assert.ok("action" in sendPetItem);
  sendPetItem.action();
  assert.equal(sentToPet, true);
});
