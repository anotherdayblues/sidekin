// When the bubble goes away: a finished reply stays for its reading time,
// longer while hovered, pinned or being typed into; closing fades out and
// a second click on the pet in the meantime takes it back.
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import { readingMs } from "./bubbleTiming.ts";

export function bubbleLife(o: {
  root: HTMLElement;
  shell: HTMLElement;
  card: HTMLElement;
  input: HTMLTextAreaElement;
  overflows: () => boolean;
  pin: HTMLElement;
  close: HTMLElement;
  cfg: { fadeMs: number; readMs: number };
  /** Runs first when the bubble starts to close. */
  closingNow: () => void;
  /** True while something must stay up, such as a due reminder. */
  held: () => boolean;
  /** The reply on screen, which sets how long it stays. */
  reading: () => string;
}) {
  let pinned = false,
    hover = false,
    timer = 0,
    closing = 0;
  function hide() {
    if(o.root.inert)return;
    o.closingNow();
    clearTimeout(closing);
    clearTimeout(timer);
    o.shell.toggleAttribute("data-closing", true);
    closing = window.setTimeout(
      () => {
        closing = 0;
        if (native) void invoke("hide_bubble");
        else o.root.hidden = true;
      },
      matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : o.cfg.fadeMs,
    );
  }
  /** Starts the reading time, when nothing keeps the bubble up. */
  function arm() {
    clearTimeout(timer);
    const writing =
      document.activeElement === o.input || !!o.input.value.trim();
    // A reply too long for the card stays until you close it or open 看全部.
    const long = o.overflows();
    if (
      !o.held() &&
      !hover &&
      !pinned &&
      !writing &&
      !long &&
      o.card.dataset.state === "answer"
    )
      timer = window.setTimeout(hide, readingMs(o.cfg.readMs, o.reading()));
  }
  /** Stops the reading time. */
  const hold = () => clearTimeout(timer);
  function cancelClosing() {
    clearTimeout(closing);
    closing = 0;
    o.shell.removeAttribute("data-closing");
  }
  o.pin.onclick = () => {
    pinned = !pinned;
    o.pin.setAttribute("aria-pressed", String(pinned));
    arm();
  };
  o.close.onclick = hide;
  o.card.onmouseenter = () => {
    hover = true;
    hold();
  };
  o.card.onmouseleave = () => {
    hover = false;
    arm();
  };
  o.input.addEventListener("focus", hold);
  o.input.addEventListener("blur", () => arm());
  return {
    hide,
    arm,
    hold,
    cancelClosing,
    pinned: () => pinned,
    /** A click on the pet: closes, or takes back a close still fading. */
    petClick() {
      if (closing) {
        cancelClosing();
        arm();
      } else hide();
    },
  };
}
