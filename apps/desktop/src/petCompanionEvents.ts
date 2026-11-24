import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import { companionMotion } from "./companionMotion.ts";
export async function petCompanionEvents(
  canvas: HTMLCanvasElement,
  glasses: HTMLElement,
  sync: () => void,
  motion: (kind: string) => void,
  currentAction: () => string | null,
  act: (action: string, sleep: boolean) => void,
) {
  await listen<boolean>("companion-glasses", (e) => {
    glasses.hidden = !e.payload;
    sync();
  });
  await listen<{
    kind: string;
    at?: number;
    action?: string;
    sleep?: boolean;
  }>("companion-motion", (e) => {
    // An action picked by the answer or the due task (plan/10 §8.2).
    const { action, sleep = false } = e.payload;
    if (e.payload.kind === "empty-selection") {
      canvas.dataset.pose = "curious";
      motion("idle");
      setTimeout(() => {
        delete canvas.dataset.pose;
      }, companionMotion().curiousMs);
      return;
    }
    if (e.payload.kind === "reminder") {
      if (action) {
        motion("idle");
        act(action, sleep);
        return;
      }
      motion("reminder");
      setTimeout(() => {
        if (currentAction() === "jumping") motion("idle");
      }, companionMotion().reminderJumpMs);
      return;
    }
    motion(e.payload.kind);
    if (action) act(action, sleep);
    if (e.payload.kind === "thinking" && e.payload.at)
      void invoke("companion_timing", { kind: "reaction", at: e.payload.at });
  });
  await listen<{ method: string; params?: { name?: string } }>(
    "brain-event",
    (e) => {
      if (e.payload.method === "crash") motion("error");
      if (e.payload.method === "chat.delta") motion("streaming");
      // Picking an action is not work: no "working" pose for it.
      if (
        e.payload.method === "chat.toolStart" &&
        e.payload.params?.name !== "pet_action"
      )
        motion(e.payload.params?.name === "web_read" ? "reading" : "tool");
      if (e.payload.method === "chat.remembered") motion("remembered");
    },
  );
}
