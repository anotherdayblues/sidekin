// The reply as it types out in the bubble: characters arrive, show at a
// reading pace, catch up once the model is done, and can be rewritten.
// Everything that starts or ends a reply goes through these few calls.
import { renderText } from "./richText.ts";
import { typingRate } from "./bubbleTiming.ts";
import { errorText } from "./errorText.ts";

export function bubbleReply(o: {
  text: HTMLElement;
  messages: HTMLElement;
  cfg: { cps: number; maxCps: number; backlog: number };
  /** True while a request is out; the text then shows a typing cursor. */
  live: () => boolean;
  /** Before and after each paint: the pet's glance, the window's size. */
  look: () => void;
  resize: () => void;
  /** Once the model is done and every character is shown. */
  finished: () => void;
}) {
  let queue: string[] = [],
    visible = "",
    done = false,
    raf = 0,
    credit = 0,
    lastFrame = 0;
  function paint() {
    o.look();
    const m = o.messages;
    const following = m.scrollHeight - m.clientHeight - m.scrollTop < 3;
    renderText(o.text, visible, o.live() && !(done && !queue.length));
    o.resize();
    if (following) m.scrollTop = m.scrollHeight;
  }
  function tick(now: number) {
    const dt = Math.min(0.1, (now - (lastFrame || now)) / 1000);
    lastFrame = now;
    credit += dt * typingRate(o.cfg, queue.length, done);
    const count = Math.min(queue.length, Math.floor(credit));
    if (count) {
      visible += queue.splice(0, count).join("");
      credit -= count;
      paint();
    }
    if (queue.length) raf = requestAnimationFrame(tick);
    else {
      raf = 0;
      lastFrame = 0;
      credit = 0;
      if (done) {
        paint();
        o.finished();
      }
    }
  }
  function drain() {
    if (!raf) raf = requestAnimationFrame(tick);
  }
  return {
    paint,
    /** What is on screen now. */
    get visible() {
      return visible;
    },
    /** On screen and still waiting to type out. */
    partial: () => visible + queue.join(""),
    /** Puts text on screen as it is, without painting. */
    setText(text: string) {
      visible = text;
    },
    /** More characters from the model. */
    push(delta: string) {
      queue.push(...Array.from(delta));
      drain();
    },
    /** The model rewrote what it said so far. */
    rewind(text: string) {
      queue = [];
      visible = text;
      paint();
    },
    /** The whole answer: types out what is missing, or replaces the text
     * when it no longer matches what was shown. */
    finish(full: string) {
      const received = visible + queue.join("");
      if (full.startsWith(received))
        queue.push(...Array.from(full.slice(received.length)));
      else {
        visible = full;
        queue = [];
        paint();
      }
      done = true;
      drain();
    },
    /** Stopped by the user: what arrived stays, or a plain 已停止. */
    stopped() {
      if (!visible && !queue.length) {
        visible = errorText.stopped;
        paint();
      }
      done = true;
      drain();
    },
    clear() {
      cancelAnimationFrame(raf);
      raf = 0;
      lastFrame = 0;
      credit = 0;
      queue = [];
      visible = "";
      done = false;
      o.text.replaceChildren();
    },
  };
}
