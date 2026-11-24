import assert from "node:assert/strict";
import { test } from "node:test";
import { accelerator } from "../apps/desktop/src/shortcutRecorder.ts";

const press = (
  code: string,
  mods: Partial<
    Record<"ctrlKey" | "altKey" | "shiftKey" | "metaKey", boolean>
  > = {},
) => ({
  code,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  metaKey: false,
  ...mods,
});

test("a pressed combination becomes the plugin's shortcut format", () => {
  assert.equal(
    accelerator(press("KeyT", { ctrlKey: true, altKey: true })),
    "Control+Alt+T",
  );
  assert.equal(
    accelerator(press("Space", { ctrlKey: true, altKey: true })),
    "Control+Alt+Space",
  );
  assert.equal(
    accelerator(press("Digit1", { metaKey: true, shiftKey: true })),
    "Shift+Super+1",
  );
});

test("modifiers alone or a key without a modifier are not recorded", () => {
  assert.equal(accelerator(press("AltLeft", { altKey: true })), null);
  assert.equal(accelerator(press("KeyT")), null);
});

test("saved shortcuts are shown with the platform's key names", async () => {
  const { shortcutLabel, heldModifiersLabel } =
    await import("../apps/desktop/src/shortcutRecorder.ts");
  assert.equal(shortcutLabel("Control+Alt+T", true), "⌃⌥T");
  // The default snip key on a Mac, written the way Apple writes ⇧⌘3.
  assert.equal(shortcutLabel("Shift+Super+2", true), "⇧⌘2");
  assert.equal(shortcutLabel("Shift+Super+1", true), "⇧⌘1");
  assert.equal(shortcutLabel("Control+Alt+Space", false), "Ctrl+Alt+空格");
  assert.equal(shortcutLabel("Alt+Numpad1", false), "Alt+Num1");
  assert.equal(
    heldModifiersLabel(press("ControlLeft", { ctrlKey: true, altKey: true }), true),
    "⌃⌥…",
  );
  assert.equal(
    heldModifiersLabel(
      press("ControlLeft", { ctrlKey: true, altKey: true }),
      false,
    ),
    "Ctrl+Alt+…",
  );
});

test("recorder shows prompt, held modifiers, invalid hint, and restores on cancel", async () => {
  const {
    recordShortcut,
    showShortcut,
    shortcutValue,
    shortcutLabel,
    RECORDING_PROMPT,
    MODIFIER_HINT,
  } = await import("../apps/desktop/src/shortcutRecorder.ts");
  const listeners = new Map<string, ((e: any) => void)[]>();
  const input: any = {
    readOnly: false,
    title: "",
    value: "",
    dataset: {} as Record<string, string>,
    blurred: false,
    events: [] as string[],
    addEventListener(type: string, fn: (e: any) => void) {
      listeners.set(type, [...(listeners.get(type) ?? []), fn]);
    },
    dispatchEvent(e: { type: string }) {
      input.events.push(e.type);
      for (const fn of listeners.get(e.type) ?? []) fn(e);
      return true;
    },
    blur() {
      input.blurred = true;
      for (const fn of listeners.get("blur") ?? []) fn({});
    },
  };
  const states: boolean[] = [];
  showShortcut(input, "Control+Alt+Space");
  const initialLabel = shortcutLabel("Control+Alt+Space");
  assert.equal(input.value, initialLabel);
  recordShortcut(input, (rec) => states.push(rec));

  // Focus enters recording state and shows prompt while preserving saved value
  for (const fn of listeners.get("focus") ?? []) fn({});
  assert.equal(input.dataset.recording, "true");
  assert.equal(input.value, RECORDING_PROMPT);
  assert.equal(shortcutValue(input), "Control+Alt+Space");
  assert.deepEqual(states, [true]);

  // Holding modifiers shows live preview; releasing returns to prompt
  for (const fn of listeners.get("keydown") ?? [])
    fn({
      ...press("ControlLeft", { ctrlKey: true }),
      key: "Control",
      preventDefault() {},
      stopPropagation() {},
    });
  assert.ok(input.value.endsWith("…"));
  for (const fn of listeners.get("keyup") ?? []) fn(press("ControlLeft"));
  assert.equal(input.value, RECORDING_PROMPT);

  // Pressing a single key without modifier shows invalid hint
  for (const fn of listeners.get("keydown") ?? [])
    fn({
      ...press("KeyK"),
      key: "k",
      preventDefault() {},
      stopPropagation() {},
    });
  assert.equal(input.dataset.invalid, "true");
  assert.equal(input.value, MODIFIER_HINT);

  // Escape cancels and restores previous label
  for (const fn of listeners.get("keydown") ?? [])
    fn({
      ...press("Escape"),
      key: "Escape",
      preventDefault() {},
      stopPropagation() {},
    });
  assert.equal(input.dataset.recording, undefined);
  assert.equal(input.value, initialLabel);
  assert.equal(shortcutValue(input), "Control+Alt+Space");
  assert.deepEqual(states, [true, false]);

  // Recording a valid combination updates value and fires input/change
  for (const fn of listeners.get("focus") ?? []) fn({});
  for (const fn of listeners.get("keydown") ?? [])
    fn({
      ...press("KeyK", { ctrlKey: true, altKey: true }),
      key: "k",
      preventDefault() {},
      stopPropagation() {},
    });
  assert.equal(shortcutValue(input), "Control+Alt+K");
  assert.equal(input.value, shortcutLabel("Control+Alt+K"));
  assert.equal(input.dataset.recording, undefined);
  assert.deepEqual(input.events, ["input", "change"]);
  assert.deepEqual(states, [true, false, true, false]);
});
