// The pet speaks: plays the audio the brain sends for a spoken reply, and
// stops when the pet is clicked (plan/10 §9.1). Late audio from a reply that
// was already stopped is dropped by its part number.
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { fromBase64, speechPlayer } from "./speechPlayer.ts";

interface SpeechEvent {
  method: "speech.audio" | "speech.end" | "speech.stop";
  params: { part?: number; rate?: number; audio?: string; error?: string };
}

export async function petSpeech(canvas: HTMLCanvasElement) {
  // The bubble and chat show 在说 while sound plays, and stop it on typing.
  const player = speechPlayer((on) => {
    canvas.toggleAttribute("data-speaking", on);
    void emit("pet-speaking", on);
  });
  let latest = 0,
    droppedUpTo = 0;
  const silence = () => {
    droppedUpTo = latest;
    player.stop();
  };
  await listen<SpeechEvent>("speech", ({ payload: { method, params } }) => {
    if (method === "speech.stop") return silence();
    if (method !== "speech.audio" || !params.audio || !params.part) return;
    latest = Math.max(latest, params.part);
    if (params.part <= droppedUpTo) return;
    player.play(fromBase64(params.audio), params.rate ?? 24000);
  });
  canvas.addEventListener("pointerdown", () => {
    if (!player.speaking) return;
    silence();
    void invoke("stop_speech").catch(() => {});
  });
}
