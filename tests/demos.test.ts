// The demos show the user's own shortcuts: change one and the keycaps and
// captions change with it, on both systems (plan/17).
import assert from "node:assert/strict";
import test from "node:test";
import { chatShortcut } from "../apps/desktop/src/demos/chatShortcut.ts";
import { snip } from "../apps/desktop/src/demos/snip.ts";
import { demoContext, type Demo, type Shortcut } from "../apps/desktop/src/demos/demoTypes.ts";

const keycaps = (markup: string) =>
  [...markup.matchAll(/<kbd data-part="key\d+">([^<]*)<\/kbd>/g)].map((m) => m[1]);
const shown = (demo: Demo, mac: boolean, shortcuts: Record<Shortcut, string>) => {
  const c = demoContext(shortcuts, mac);
  return { keys: keycaps(demo.markup(c)), captions: demo.captions(c).map((l) => l.text).join(" ") };
};
const defaults = {
  chat: "Alt+Space",
  vision: "Alt+Shift+S",
  panel: "Alt+Shift+Space",
  clipboard: "Control+Shift+2",
};
const changed = {
  chat: "Super+Shift+K",
  vision: "Control+Shift+4",
  panel: "Alt+P",
  clipboard: "Alt+V",
};

test("聊天快捷键演示：改了快捷键，键帽和字幕跟着变", () => {
  assert.deepEqual(shown(chatShortcut, false, defaults).keys, ["Alt", "空格"]);
  const win = shown(chatShortcut, false, changed);
  assert.deepEqual(win.keys, ["Win", "Shift", "K"]);
  assert.match(win.captions, /Win\+Shift\+K/);
  const mac = shown(chatShortcut, true, changed);
  assert.deepEqual(mac.keys, ["⌘", "⇧", "K"]);
  assert.match(mac.captions, /⌘⇧K/);
});

test("截屏识图演示：改了快捷键，键帽和字幕跟着变", () => {
  const win = shown(snip, false, changed);
  assert.deepEqual(win.keys, ["Ctrl", "Shift", "4"]);
  assert.match(win.captions, /Ctrl\+Shift\+4/);
  assert.deepEqual(shown(snip, true, changed).keys, ["⌃", "⇧", "4"]);
});

test("聊天侧边栏演示：改了快捷键，键帽和字幕跟着变", async () => {
  const { panel } = await import("../apps/desktop/src/demos/panel.ts");
  const win = shown(panel, false, changed);
  assert.deepEqual(win.keys, ["Alt", "P"]);
  assert.match(win.captions, /Alt\+P/);
  assert.deepEqual(shown(panel, true, defaults).keys, ["⌥", "⇧", "空格"]);
});

test("剪贴板演示：改了快捷键，键帽和字幕跟着变", async () => {
  const { clipboard } = await import("../apps/desktop/src/demos/clipboard.ts");
  assert.equal(clipboard.id, "clipboard");
  const win = shown(clipboard, false, changed);
  assert.deepEqual(win.keys, ["Alt", "V"]);
  assert.match(win.captions, /Alt\+V/);
  const mac = shown(clipboard, true, defaults);
  assert.deepEqual(mac.keys, ["⌃", "⇧", "2"]);
  assert.match(mac.captions, /⌃⇧2/);
});
