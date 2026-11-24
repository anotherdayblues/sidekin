// The other windows' side of a spoken reply (plan/10 §9.1): they hear from
// the pet window while it speaks, show 在说, and typing stops the voice.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";

export async function watchSpeech(shown: HTMLElement, input: HTMLElement) {
  if (!native) return;
  let speaking = false;
  await listen<boolean>("pet-speaking", (e) => {
    speaking = e.payload;
    shown.toggleAttribute("data-speaking", speaking);
  });
  input.addEventListener("input", () => {
    if (speaking) void invoke("stop_speech").catch(() => {});
  });
}
