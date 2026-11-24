// How the host opens the bubble, one handler per mode. A new way to open
// the bubble is a new entry in `modes`; anything not handled there opens the
// chat input.
import type { FocusAsk } from "./bubbleFocus.ts";
import type { PhoneOffer, PhoneStatus } from "./bubblePhone.ts";
import type { TodoAsk } from "./todo/bubble.ts";
import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import { showRequest, type ApprovalRequest } from "./bubbleApproval.ts";
import type { BubbleMode, BubbleView } from "./bubbleView.ts";
import type { Notice } from "./reminders.ts";

export type Intent = {
  mode: string;
  request?: ApprovalRequest;
  reason?: string;
  at?: number;
  source?: string;
  generation?: number;
  topic?: number;
  // From the screenshot card: a question about the picture.
  question?: string;
  // A tip from the pet, by id (tips.rs).
  tip?: string;
  // The pet's first words, said in its own personality (persona.rs).
  text?: string;
  // 番茄钟: a tomato is done, or a break is over (focus.rs).
  focus?: FocusAsk;
  // 手机传文件 (phone/mod.rs): the QR code, a phone's question, its text.
  phone?: PhoneStatus;
  offer?: PhoneOffer;
  link?: string | null;
  // 待办 (todo/mod.rs): add one, pick one for a tomato, or an alert.
  todo?: TodoAsk;
  // A selection to translate: where it came from, for 替换为译文 (plan/41).
  target?: number;
};

export function bubbleOpen(p: {
  view: BubbleView;
  root: HTMLElement;
  note: HTMLElement;
  input: HTMLTextAreaElement;
  stop: HTMLElement;
  copy: HTMLElement;
  original: HTMLDetailsElement;
  originalText: HTMLElement;
  life: { cancelClosing(): void; hold(): void; arm(): void };
  motion: { value: number; set(v: number): void; to(v: number): void };
  reply: { setText(text: string): void; paint(): void };
  thread: { open(): void; reset(): void };
  state(s: string): void;
  reset(): void;
  submit(message: string, operation: BubbleMode): Promise<void>;
  error(code: string): void;
  showMine(text: string): void;
  drawNotices(items: Notice[]): void;
  grow(): void;
  tip(id: string): void;
  focus(phase: FocusAsk): void;
  todo(kind: TodoAsk): void;
  phone: {
    qr(s: PhoneStatus): void;
    ask(o: PhoneOffer): void;
    received(text: string, link: string | null): void;
  };
  selected(target?: number): void;
}) {
  const { view } = p;
  /** Stops the request the bubble waits for. */
  const drop = () => {
    if (view.token) void invoke("cancel_chat", { token: view.token });
    view.token = "";
  };
  /** The bubble opens for this alone, with nothing else in it. */
  const alone = () => {
    drop();
    p.reset();
    p.showMine("");
    p.thread.reset();
    p.original.hidden = true;
    view.mode = "chat";
    p.state("phone");
  };
  /** True when the mode is handled; false falls through to the chat input. */
  const modes: Record<string, (data: Intent) => boolean> = {
    authorization(data) {
      if (!data.request) return false;
      view.approval = data.request;
      p.state("authorization");
      p.note.hidden = false;
      const request = data.request;
      showRequest(p.note, request, () => view.approval === request);
      p.root
        .querySelector<HTMLElement>("[data-choices] button")!
        .focus({ preventScroll: true });
      return true;
    },
    // 上手引导: the pet speaks first and waits for the user's answer.
    greeting(data) {
      if (!data.text) return false;
      drop();
      p.reset();
      p.showMine("");
      p.thread.reset();
      p.original.hidden = true;
      view.mode = "chat";
      p.reply.setText(data.text);
      p.reply.paint();
      p.state("answer");
      p.input.focus();
      return true;
    },
    // 番茄钟: the bubble opened only to ask what comes next.
    focus(data) {
      if (!data.focus) return false;
      drop();
      p.reset();
      p.showMine("");
      p.thread.reset();
      p.original.hidden = true;
      view.mode = "chat";
      p.state("focus");
      p.focus(data.focus);
      return true;
    },
    // 待办: the bubble opened to add one, to pick one, or for an alert.
    todo(data) {
      if (!data.todo) return false;
      drop();
      p.reset();
      p.showMine("");
      p.thread.reset();
      p.original.hidden = true;
      view.mode = "chat";
      p.state("todo");
      p.todo(data.todo);
      return true;
    },
    // 手机传文件: the bubble opened for the QR code, a question or a text.
    phone(data) {
      if (!data.phone) return false;
      alone();
      p.phone.qr(data.phone);
      return true;
    },
    "phone-offer"(data) {
      if (!data.offer) return false;
      alone();
      p.phone.ask(data.offer);
      return true;
    },
    "phone-text"(data) {
      if (data.text === undefined) return false;
      alone();
      p.phone.received(data.text, data.link ?? null);
      return true;
    },
    // The bubble opened only to say a tip.
    tip(data) {
      if (!data.tip) return false;
      drop();
      p.reset();
      p.showMine("");
      p.thread.reset();
      p.original.hidden = true;
      view.mode = "chat";
      p.state("tip");
      p.tip(data.tip);
      return true;
    },
    reminder() {
      if (!view.token) {
        p.reset();
        p.state("reminder");
      }
      void invoke<Notice[]>("pending_reminders").then(p.drawNotices);
      return true;
    },
    "snip-ask"(data) {
      drop();
      p.reset();
      view.visionGeneration = data.generation ?? 0;
      view.screenshotTopic = data.topic;
      p.thread.reset();
      view.mode = "vision";
      p.original.hidden = true;
      void p.submit(data.question ?? "", "vision");
      return true;
    },
    // The selection is being read: the card comes in before the text does.
    selecting(data) {
      drop();
      p.reset();
      view.mode = "translate";
      p.original.hidden = true;
      p.state("thinking");
      p.stop.hidden = true;
      const at = data.at;
      if (at)
        requestAnimationFrame(() =>
          requestAnimationFrame(
            () =>
              void invoke("companion_timing", {
                kind: "translate-visible",
                at,
              }),
          ),
        );
      return true;
    },
    translate(data) {
      if (!data.source || data.generation === view.lastGeneration) return false;
      view.lastGeneration = data.generation ?? 0;
      view.selectionAction = "translate";
      p.selected(data.target);
      p.originalText.textContent = data.source;
      p.original.open = Array.from(data.source).length <= 72;
      void p.submit(data.source, "translate");
      return true;
    },
    // 输入要翻译的话, or the translation shortcut with nothing selected.
    "translate-input"() {
      drop();
      p.reset();
      p.showMine("");
      p.thread.reset();
      view.mode = "translate";
      view.selectionAction = "translate";
      p.selected(0);
      view.typed = true;
      p.original.hidden = true;
      p.state("input");
      p.input.focus();
      return true;
    },
    "empty-selection"() {
      p.reset();
      view.mode = "translate";
      p.original.hidden = true;
      p.reply.setText(t("bubble.selectFirst"));
      p.reply.paint();
      p.state("answer");
      p.copy.hidden = true;
      p.life.arm();
      return true;
    },
    error(data) {
      p.error(data.reason || "crash");
      return true;
    },
    // Detach this view; the pending answer still finishes in the chat
    // history. Then the input, as for a plain open.
    "return-input"() {
      view.token = "";
      p.input.value = "";
      p.grow();
      return false;
    },
  };
  function chatInput() {
    if (view.mode !== "chat") drop();
    if (view.token) return;
    p.reset();
    p.showMine("");
    view.mode = "chat";
    p.original.hidden = true;
    p.state("input");
    p.input.focus();
    if (native) p.thread.open();
  }
  return function open(data: Intent) {
    p.life.cancelClosing();
    p.life.hold();
    p.root.hidden = false;
    const identity = JSON.stringify([data.mode, data.at, data.generation]);
    if (view.seenOpen === identity && data.at) return;
    view.seenOpen = identity;
    // A translation usually follows the 正在读 step, which already brought the
    // card in; a copy-twice translation arrives on its own, so bring it in.
    if (data.mode !== "translate" || p.motion.value < 0.5) {
      p.motion.set(0);
      p.motion.to(1);
    }
    if (Object.hasOwn(modes, data.mode) && modes[data.mode](data)) return;
    chatInput();
  };
}
