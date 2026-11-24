// Every demo, in the order the skill book lists them (plan/17 3.5).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { defaults, type CompanionSettings } from "../../../shared/companion.ts";
import * as api from "../bridge.ts";
import { chatShortcut } from "./chatShortcut.ts";
import { clipboard } from "./clipboard.ts";
import { copyTranslate } from "./copyTranslate.ts";
import { mountDemo } from "./demoPlayer.ts";
import type { Demo, DemoOptions } from "./demoTypes.ts";
import { memory } from "./memory.ts";
import { menuTranslate } from "./menuTranslate.ts";
import { reminder } from "./reminder.ts";
import { todo } from "./todo.ts";
import { snip } from "./snip.ts";
import { panel } from "./panel.ts";
import { fileTransfer } from "./fileTransfer.ts";
import { teach } from "./teach.ts";
import { makePet } from "./makePet.ts";
import { focusDemo } from "./focusDemo.ts";
import { phoneDemo } from "./phoneDemo.ts";

export const DEMOS: Demo[] = [
  chatShortcut,
  panel,
  focusDemo,
  copyTranslate,
  menuTranslate,
  snip,
  fileTransfer,
  phoneDemo,
  memory,
  clipboard,
  todo,
  reminder,
  teach,
  makePet,
];
export const demoById = (id: string) => DEMOS.find((d) => d.id === id);

/** The user's pet and shortcuts, for a demo shown to them. */
export async function demoOptions(): Promise<DemoOptions> {
  const [snapshot, settings] = await Promise.all([
    api.state(),
    api.native ? invoke<CompanionSettings>("companion_settings") : defaults,
  ]);
  // The pet on the desktop; any pet if none is chosen; the example if none.
  const id = snapshot.settings.activeId ?? snapshot.pets[0]?.id;
  const sprite = id
    ? await api.sprite(id).catch(() => api.exampleSprite)
    : api.exampleSprite;
  return {
    sprite,
    example: api.exampleSprite,
    shortcuts: shortcutsOf(settings),
  };
}

/** The shortcuts a demo shows, from the saved settings. */
export const shortcutsOf = (
  s: Pick<
    CompanionSettings,
    "chatShortcut" | "visionShortcut" | "panelShortcut" | "clipboardShortcut"
  >,
) => ({
  chat: s.chatShortcut,
  vision: s.visionShortcut,
  panel: s.panelShortcut,
  clipboard: s.clipboardShortcut,
});

/**
 * Plays demo `id` in `host`, replacing whatever played there. When the user
 * changes a shortcut while it plays, it starts over with the new keys.
 */
export async function playDemo(host: HTMLElement, id: string) {
  const demo = demoById(id);
  if (!demo) return { destroy: () => host.replaceChildren() };
  let options = await demoOptions(),
    alive = true,
    handle = await mountDemo(host, demo, options),
    unlisten = () => {};
  if (api.native)
    unlisten = await listen<CompanionSettings>(
      "companion-settings",
      async (e) => {
        const next = shortcutsOf(e.payload);
        if (JSON.stringify(next) === JSON.stringify(options.shortcuts)) return;
        options = { ...options, shortcuts: next };
        handle.destroy();
        const again = await mountDemo(host, demo, options);
        if (alive) handle = again;
        else again.destroy();
      },
    );
  return {
    destroy() {
      alive = false;
      unlisten();
      handle.destroy();
    },
  };
}
