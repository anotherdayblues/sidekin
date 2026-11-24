// A tip from the pet (plan/17 3.2, 3.6): one line under what the bubble
// shows, or the whole bubble when it opened just to say it. 看看怎么用 opens
// the demo in 它会的事; 知道了 puts it away; 不用教我了 stops all tips.
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import { defaults } from "../../shared/companion.ts";
import { readingMs } from "./bubbleTiming.ts";
import { t } from "./i18n.ts";
import { DEMO_FEATURES, tipText } from "./tips.ts";

/** Tips said before a model is set up offer to set one up instead. */
const SET_UP = new Set(["hello", "double-click"]);

export function bubbleTip(
  el: HTMLElement,
  o: {
    card: HTMLElement;
    readMs: number;
    /** Hides the whole bubble. */
    hide(): void;
  },
) {
  const text = el.querySelector<HTMLElement>("[data-tip-text]")!;
  const show = el.querySelector<HTMLElement>("[data-tip-show]")!;
  const setUp = el.querySelector<HTMLElement>("[data-tip-setup]")!;
  const ok = el.querySelector<HTMLElement>("[data-tip-ok]")!;
  const off = el.querySelector<HTMLElement>("[data-tip-off]")!;
  let id = "",
    timer = 0;
  const shortcuts = async () => {
    const s = native
      ? await invoke<{
          chatShortcut: string;
          visionShortcut: string;
          panelShortcut: string;
          clipboardShortcut?: string;
        }>("companion_settings")
      : defaults;
    return {
      chat: s.chatShortcut,
      vision: s.visionShortcut,
      panel: s.panelShortcut,
      clipboard: s.clipboardShortcut ?? defaults.clipboardShortcut,
    };
  };
  const clear = () => {
    clearTimeout(timer);
    el.hidden = true;
    delete el.dataset.tipId;
    id = "";
  };
  /** Put the tip away; a bubble that only held the tip goes with it. */
  const done = () => {
    const alone = o.card.dataset.state === "tip";
    clear();
    if (alone) o.hide();
  };
  async function say(next: string, alone: boolean) {
    id = next;
    const isWelcome = next === "hello";
    el.dataset.tipId = next;
    text.textContent = tipText(next, await shortcuts());
    show.hidden = !DEMO_FEATURES.includes(next);
    setUp.hidden = !SET_UP.has(next);
    setUp.textContent = isWelcome ? t("tip.startSetup") : t("tip.setup");
    ok.textContent = isWelcome ? t("tip.exploreFirst") : t("tip.ok");
    off.hidden = isWelcome;
    el.hidden = false;
    clearTimeout(timer);
    // First-launch welcome stays until the user chooses; routine tips fade out.
    if (alone && !isWelcome)
      timer = window.setTimeout(
        function away() {
          if (o.card.matches(":hover")) timer = window.setTimeout(away, 1000);
          else if (o.card.dataset.state === "tip") done();
        },
        readingMs(o.readMs, text.textContent),
      );
  }
  show.onclick = () => {
    const feature = id;
    done();
    if (!native) return;
    void invoke("open_studio");
    void emit("studio-block", "pet");
    void emit("skill-book-open", feature);
  };
  setUp.onclick = () => {
    const isWelcome = id === "hello";
    done();
    if (!native) return;
    void invoke("open_studio");
    if (isWelcome) void emit("guide-open", null);
    else void emit("companion-open", false);
  };
  ok.onclick = done;
  off.onclick = () => {
    done();
    if (native) void invoke("tips_off", { off: true });
  };
  return { say, clear };
}
