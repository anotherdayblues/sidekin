import { t } from "./i18n.ts";
// Shortcut fields record a key press instead of asking for typed text.
// The field shows symbols (⌃⌥T on a Mac, Ctrl+Alt+T elsewhere); the value
// saved stays in the format the global-shortcut plugin parses, kept in
// data-value, for example "Control+Alt+T".

const modifierCodes = /^(Control|Alt|Shift|Meta|OS)(Left|Right)?$/;

/** Turn a keydown into a shortcut string, or null while only modifiers are held. */
export function accelerator(
  e: Pick<
    KeyboardEvent,
    "code" | "ctrlKey" | "altKey" | "shiftKey" | "metaKey"
  >,
) {
  if (!e.code || modifierCodes.test(e.code)) return null;
  const mods = [
    e.ctrlKey && "Control",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
    e.metaKey && "Super",
  ].filter(Boolean);
  // A global shortcut without a modifier would swallow normal typing.
  if (!mods.length) return null;
  const key = e.code.replace(/^Key([A-Z])$/, "$1").replace(/^Digit(\d)$/, "$1");
  return [...mods, key].join("+");
}

const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);
const names: Record<string, string> = {
  Space: t("keys.space"),
  Enter: "↩",
  Tab: "⇥",
  Backspace: "⌫",
  Delete: "⌦",
  Home: "↖",
  End: "↘",
  PageUp: "⇞",
  PageDown: "⇟",
  ArrowUp: "↑",
  ArrowDown: "↓",
  ArrowLeft: "←",
  ArrowRight: "→",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Minus: "-",
  Equal: "=",
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Backquote: "`",
};
/** "Control+Alt+T" → ["⌃", "⌥", "T"] on a Mac, ["Ctrl", "Alt", "T"] elsewhere. */
export function shortcutKeys(value: string, onMac = mac) {
  const mods: Record<string, [string, string]> = {
    Control: ["⌃", "Ctrl"],
    Alt: ["⌥", "Alt"],
    Shift: ["⇧", "Shift"],
    Super: ["⌘", "Win"],
    CommandOrControl: ["⌘", "Ctrl"],
  };
  return value
    .split("+")
    .filter(Boolean)
    .map(
      (p) =>
        mods[p]?.[onMac ? 0 : 1] ??
        names[p] ??
        p.replace(/^Numpad(\d)$/, "Num$1"),
    );
}
/** "Control+Alt+T" → "⌃⌥T" on a Mac, "Ctrl+Alt+T" elsewhere. */
export function shortcutLabel(value: string, onMac = mac) {
  return shortcutKeys(value, onMac).join(onMac ? "" : "+");
}
/** Put a saved shortcut into a recorder field. */
export function showShortcut(input: HTMLInputElement, value: string) {
  input.dataset.value = value;
  input.value = shortcutLabel(value);
}
/** The saved form of a field's shortcut. */
export function shortcutValue(input: HTMLInputElement) {
  return input.dataset.value ?? input.value.trim();
}

export const RECORDING_PROMPT = t("keys.recording");
export const MODIFIER_HINT = mac ? t("keys.needModsMac") : t("keys.needMods");

/** Show currently held modifiers while waiting for the main key. */
export function heldModifiersLabel(
  e: Pick<KeyboardEvent, "ctrlKey" | "altKey" | "shiftKey" | "metaKey">,
  onMac = mac,
) {
  const mods = [
    e.ctrlKey && "Control",
    e.altKey && "Alt",
    e.shiftKey && "Shift",
    e.metaKey && "Super",
  ]
    .filter(Boolean)
    .join("+");
  return mods ? shortcutLabel(mods, onMac) + (onMac ? "…" : "+…") : "";
}

export function recordShortcut(
  input: HTMLInputElement,
  onRecordingChange?: (recording: boolean) => void,
) {
  input.readOnly = true;
  input.dataset.shortcut = "";
  input.title = t("keys.hint");
  let justFocused = false;
  const enterRecording = () => {
    const wasRecording = input.dataset.recording === "true";
    input.dataset.recording = "true";
    delete input.dataset.invalid;
    input.value = RECORDING_PROMPT;
    if (!wasRecording) onRecordingChange?.(true);
  };
  const exitRecording = () => {
    const wasRecording = input.dataset.recording === "true";
    delete input.dataset.recording;
    delete input.dataset.invalid;
    input.value = shortcutLabel(input.dataset.value ?? "");
    if (wasRecording) onRecordingChange?.(false);
  };
  // The old value stays in dataset.value while recording, so a save started
  // by another setting never stores an empty shortcut.
  input.addEventListener("focus", () => {
    justFocused = true;
    enterRecording();
  });
  input.addEventListener("click", () => {
    if (justFocused) {
      justFocused = false;
      return;
    }
    if (input.dataset.recording) {
      exitRecording();
      input.blur();
    } else {
      enterRecording();
    }
  });
  input.addEventListener("blur", () => {
    justFocused = false;
    exitRecording();
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Tab") return;
    e.preventDefault();
    e.stopPropagation();
    if (
      e.key === "Escape" &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      !e.metaKey
    ) {
      exitRecording();
      input.blur();
      return;
    }
    if (
      input.dataset.optional === "true" &&
      (e.key === "Backspace" || e.key === "Delete") &&
      !e.ctrlKey &&
      !e.altKey &&
      !e.shiftKey &&
      !e.metaKey
    ) {
      delete input.dataset.invalid;
      showShortcut(input, "");
      exitRecording();
      input.dispatchEvent(new Event("input", { bubbles: true }));
      input.dispatchEvent(new Event("change", { bubbles: true }));
      input.blur();
      return;
    }
    const value = accelerator(e);
    if (!value) {
      if (modifierCodes.test(e.code)) {
        delete input.dataset.invalid;
        input.value = heldModifiersLabel(e) || RECORDING_PROMPT;
      } else {
        input.dataset.invalid = "true";
        input.value = MODIFIER_HINT;
      }
      return;
    }
    delete input.dataset.invalid;
    showShortcut(input, value);
    exitRecording();
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new Event("change", { bubbles: true }));
    input.blur();
  });
  input.addEventListener("keyup", (e) => {
    if (!input.dataset.recording || input.dataset.invalid) return;
    input.value = heldModifiersLabel(e) || RECORDING_PROMPT;
  });
}
