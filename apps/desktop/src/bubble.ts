import { t } from "./i18n.ts";
import { bubbleSteps } from "./toolSteps.ts";
import { bubbleMarkup } from "./bubbleMarkup.ts";
import type { Notice } from "./reminders.ts";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import { watchWindowAppearance } from "./skin.ts";
import { Motion } from "./spring.ts";
import { companionMotion } from "./companionMotion.ts";
import { clearLook } from "./caretLook.ts";
import { bubbleReply } from "./bubbleReply.ts";
import { bubbleLife } from "./bubbleLife.ts";
import { bubbleChrome } from "./bubbleChrome.ts";
import { bubbleEvents } from "./bubbleEvents.ts";
import { memoryReceipt } from "./bubbleReceipt.ts";
import { bubbleThread } from "./bubbleThread.ts";
import "./bubble.css";
import "./bubbleChat.css";
import "./speech.css";
import { watchSpeech } from "./speechWatch.ts";
import { approvalChoices, approvalKey } from "./bubbleApproval.ts";
import { bubbleNotices } from "./bubbleNotices.ts";
import { previewBubble } from "./bubblePreview.ts";
import { newView } from "./bubbleView.ts";
import { bubbleSelection } from "./bubbleSelection.ts";
import { bubbleTranslate } from "./bubbleTranslate.ts";
import { bubbleError } from "./bubbleError.ts";
import { bubbleOpen, type Intent } from "./bubbleOpen.ts";
import { bubbleTip } from "./bubbleTip.ts";
import { bubbleFocus, type FocusAsk } from "./bubbleFocus.ts";
import { bubblePhone, type PhoneOffer } from "./bubblePhone.ts";
import { bubbleTodo } from "./todo/bubble.ts";
import { snipTooltip, watchChatSnip } from "./snipTool.ts";
export async function mountBubble(root: HTMLElement) {
  document.documentElement.classList.add("bubble-window");
  document.body.classList.add("bubble-window");
  bubbleMarkup(root);
  const pick = <T extends HTMLElement>(q: string) => root.querySelector<T>(q)!;
  const card = pick(".bubble-card"),
    shell = pick(".bubble-shell"),
    messages = pick(".bubble-messages"),
    text = pick(".bubble-text"),
    input = pick<HTMLTextAreaElement>("textarea"),
    note = pick("[data-note]");
  void watchSpeech(card, input);
  // D1: earlier turns, then what you just said, then the reply.
  const thread = bubbleThread(pick(".bubble-thread"), messages);
  const mineEl = pick(".bubble-mine");
  function showMine(text: string) {
    mineEl.textContent = text;
    mineEl.hidden = !text;
  }
  const send = pick("[data-send]"),
    snip = pick<HTMLButtonElement>("[data-snip]"),
    stop = pick("[data-stop]"),
    action = pick("[data-action]"),
    pin = pick("[data-pin]"),
    history = pick("[data-history]");
  const original = pick<HTMLDetailsElement>(".bubble-source"),
    originalText = pick(".bubble-source div"),
    selectionTabs = pick("[data-selection-tabs]"),
    copy = pick("[data-copy]");
  const view = newView();
  const selection = bubbleSelection(selectionTabs, {
    view,
    card,
    original,
    originalText,
    submit,
  });
  const translation = bubbleTranslate(root, {
    view,
    card,
    input,
    original,
    originalText,
    copy,
    rerun() {
      // Only a translation on screen is redone; an empty box waits for typing.
      if (
        !["thinking", "streaming", "answer"].includes(card.dataset.state ?? "")
      )
        return;
      if (view.token) {
        if (native) void invoke("cancel_chat", { token: view.token });
        view.token = "";
      }
      const source = originalText.textContent || view.last;
      if (source.trim()) void submit(source, "translate");
    },
    result: () => reply.visible,
    hide: () => hide(),
  });
  copy.onclick = async () => {
    try {
      await invoke("copy_translation", { text: reply.visible });
      copy.textContent = t("common.copied");
    } catch {
      copy.textContent = t("common.retry");
    }
  };
  const compose = pick(".bubble-compose");
  let canSnip = false;
  const syncSnip = () => {
    // Option A (confirmed): show snip button in chat mode only when multimodal snip is ready;
    // hide in translate mode and when model is text-only so the compact 320px bubble stays clean.
    snip.hidden = !canSnip || view.mode !== "chat";
  };
  watchChatSnip((avail) => {
    canSnip = avail.state === "ready";
    const tip = snipTooltip(avail);
    snip.title = tip;
    snip.setAttribute("aria-label", tip);
    syncSnip();
  });
  snip.onclick = async () => {
    if (!canSnip || !native) return;
    const draft = input.value.trim();
    try {
      await invoke("start_chat_snip", { draftText: draft || null });
    } catch (e) {
      error(String(e).replace(/^Error:\s*/, ""));
    }
  };
  const { grow, lookAtCard, resetCopy } = bubbleChrome(root, {
    shell,
    card,
    input,
    translating: () => view.mode === "translate",
  });
  const cfg = companionMotion(),
    motion = new Motion(
      1,
      (p) => card.style.setProperty("--progress", String(p)),
      cfg,
    );
  const { clearRemembered, showRemembered } = memoryReceipt(
    pick("[data-remembered]"),
  );
  const notices = bubbleNotices(pick("[data-notice]"), (items) => {
    if (items.length) life.hold();
    if (!items.length && card.dataset.state === "reminder") {
      if (life.pinned()) {
        state("input");
        input.focus();
      } else {
        state("closing");
        hide();
      }
    } else if (!items.length) arm();
  });
  const drawNotices = notices.draw;
  const state = (s: string) => {
    if (view.approval && s !== "authorization") return;
    card.dataset.state = s;
    card.dataset.mode = view.mode;
    selection.sync();
    history.textContent =
      view.mode === "translate" ? t("bubble.translations") : t("bubble.seeAll");
    history.hidden = !showHistory();
    // Only a translation or a polish is text to paste back in place.
    copy.hidden =
      view.mode !== "translate" ||
      s !== "answer" ||
      !["translate", "polish"].includes(view.selectionAction);
    const busy = s === "thinking" || s === "streaming" || s === "tool";
    stop.hidden = !busy;
    // After an answer in chat the box stays, so a follow-up needs no new topic.
    // A translation keeps it too: the next sentence is typed right there.
    const typing =
      s === "input" ||
      (s === "answer" && (view.mode === "chat" || view.mode === "translate"));
    compose.hidden = !typing;
    input.placeholder =
      s === "answer" ? t("bubble.followUp") : t("chat.placeholder");
    action.hidden = s !== "error";
    note.hidden = s !== "tool";
    const choices = pick("[data-choices]");
    choices.replaceChildren();
    choices.hidden = s !== "authorization";
    if (!choices.hidden) {
      approvalChoices(choices, view.approval, async (choice) => {
        if (!view.approval) return;
        if (!native) {
          view.approval = undefined;
          reply.setText(
            choice === "deny" ? "这次跳过了。" : "测试名牌是 LZ-QA。",
          );
          state("answer");
          paint();
          return;
        }
        try {
          await invoke("approve_tool", {
            id: view.approval.id,
            choice,
          });
        } catch {
          note.textContent = t("approval.over");
        }
      });
    }
    if (s === "tool") note.textContent = t("bubble.usingTool");
    syncSnip();
    translation.sync(s);
  };
  function overflows() {
    return messages.scrollHeight > messages.clientHeight + 1;
  }
  function showHistory() {
    return (
      overflows() ||
      (view.mode === "translate" && card.dataset.state === "answer")
    );
  }
  let clip:
    ReturnType<typeof import("./clipboardPanel.ts").clipboardPanel> | undefined;
  const resize = () => {
    if (clip) return;
    history.hidden = !showHistory();
    if (native)
      void invoke("size_bubble", {
        width: shell.offsetWidth,
        height: shell.offsetHeight,
      });
  };
  new ResizeObserver(() => requestAnimationFrame(resize)).observe(shell);
  const reply = bubbleReply({
    text,
    messages,
    cfg,
    live: () => Boolean(view.token),
    look: lookAtCard,
    resize,
    finished: () => {
      state("answer");
      view.token = "";
      life.arm();
    },
  });
  const paint = reply.paint;
  const life = bubbleLife({
    root,
    shell,
    card,
    input,
    overflows,
    pin,
    close: pick("[data-close]"),
    cfg,
    closingNow: () => {
      if (native) clearLook();
      clearRemembered();
      if (view.mode === "vision" && view.token)
        void invoke("cancel_chat", { token: view.token });
    },
    held: () => !!clip || notices.any() || focus.any(),
    reading: () => reply.visible,
  });
  const { hide, arm } = life;
  const tip = bubbleTip(pick("[data-tip]"), { card, readMs: cfg.readMs, hide });
  const focus = bubbleFocus(pick("[data-focus]"), { card, hide, arm });
  const focusLocked = () => focus.waiting() && card.dataset.state === "focus";
  const phone = bubblePhone(pick("[data-phone]"), { card, hide, grow });
  const todo = bubbleTodo(pick("[data-todo]"), { card, hide });
  function reset() {
    tip.clear();
    if (!focus.waiting()) focus.clear();
    phone.clear();
    todo.clear();
    pick("[data-lookup]").hidden = true;
    pick("[data-web-source]").replaceChildren();
    clearRemembered();
    reply.clear();
    life.hold();
    action.hidden = true;
    pick("[data-backup]").hidden = true;
    pick("[data-budget]").hidden = true;
    translation.clear();
  }
  const error = bubbleError(action, {
    view,
    reply,
    reset,
    state,
    submit,
    openInput: () => open({ mode: "input" }),
  });
  async function submit(
    message: string,
    operation: "chat" | "translate" | "vision" = "chat",
  ) {
    if (operation === "vision" && !message.trim())
      message = t("chat.whatIsThis");
    if (view.token || !message.trim()) return;
    // A follow-up moves the exchange on screen up into the thread.
    if (
      operation === "chat" &&
      view.mode === "chat" &&
      card.dataset.state === "answer" &&
      mineEl.textContent &&
      reply.visible
    )
      thread.append({ question: mineEl.textContent, answer: reply.visible });
    reset();
    showMine(operation === "translate" ? "" : message);
    view.mode = operation === "vision" ? "chat" : operation;
    original.hidden = operation !== "translate";
    resetCopy();
    view.last = message;
    input.value = "";
    input.style.height = "";
    view.token = crypto.randomUUID();
    const mine = view.token;
    state("thinking");
    messages.scrollTop = messages.scrollHeight;
    const at = Date.now();
    try {
      const r = await invoke<{
        text: string;
        steps?: import("../../shared/toolSteps.ts").ToolStep[];
        turnId?: number;
        topicId?: number;
        into?: string;
      }>(operation === "translate" ? "translate_selection" : "send_chat", {
        token: view.token,
        ...(operation === "vision"
          ? {
              screenshot: view.visionGeneration,
              screenshotTopic: view.screenshotTopic,
            }
          : {}),
        text: message,
        at,
        ...(operation === "translate"
          ? { action: view.selectionAction, tone: translation.tone() }
          : {}),
      });
      if (view.token !== mine) return;
      // The snip card sends what follows to the topic this one went into,
      // instead of opening a new topic for every message.
      if (operation === "vision" && r.topicId)
        void emit("snip-topic", {
          generation: view.visionGeneration,
          topic: r.topicId,
        });
      if (
        operation === "vision" &&
        view.screenshotTopic &&
        r.topicId &&
        r.turnId
      )
        thread.open(r.topicId, r.turnId);
      else if (operation !== "translate" && r.topicId)
        thread.continued(r.topicId);
      if (r.steps?.length && r.turnId && r.topicId) {
        pick("[data-web-source]").replaceChildren(
          bubbleSteps(r.steps, () => {
            void invoke("open_chat_turn", { topic: r.topicId, turn: r.turnId });
          }),
        );
      }
      if (operation === "translate") translation.done(r.into);
      reply.finish(r.text);
    } catch (e) {
      if (view.token !== mine) return;
      if (String(e) === "stopped") reply.stopped();
      else {
        if (operation === "vision") view.mode = "vision";
        error(String(e));
      }
    }
  }
  /** What was typed: a chat message, or in a translation the next sentence. */
  function sendTyped() {
    if (view.token || !input.value.trim()) return;
    if (view.mode === "translate") translation.typed(input.value.trim());
    void submit(input.value, view.mode);
  }
  send.onclick = sendTyped;
  stop.onclick = () => {
    if (view.token) void invoke("cancel_chat", { token: view.token });
  };
  const open = bubbleOpen({
    view,
    root,
    note,
    input,
    stop,
    copy,
    original,
    originalText,
    life,
    motion,
    reply,
    thread,
    state,
    reset,
    submit,
    error,
    showMine,
    drawNotices,
    grow,
    tip: (id) => {
      lookAtCard();
      void tip.say(id, true);
    },
    focus: (phase) => {
      lookAtCard();
      void focus.ask(phase);
    },
    todo: todo.show,
    phone,
    selected: translation.selected,
  });
  history.onclick = () =>
    view.mode === "translate"
      ? void invoke("open_translations")
      : void invoke("open_chat_window");
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendTyped();
    }
  };
  document.addEventListener("keydown", (e) => {
    if (clip) return;
    if (view.approval && !e.isComposing && approvalKey(e, root)) return;
    // Esc while an input method is composing only cancels the composition.
    if (
      e.key === "Escape" &&
      !e.defaultPrevented &&
      !e.isComposing &&
      !focusLocked()
    )
      hide();
  });
  if (native) {
    let openingClip = 0;
    let priorFocus: HTMLElement | null = null;
    const openClip = async (v: { id: number }) => {
      if (clip?.id === v.id) {
        clip.focus();
        return;
      }
      openingClip = v.id;
      const { clipboardPanel } = await import("./clipboardPanel.ts");
      if (openingClip !== v.id || clip?.id === v.id) return;
      priorFocus =
        document.activeElement instanceof HTMLElement
          ? document.activeElement
          : null;
      life.cancelClosing();
      life.hold();
      root.inert = true;
      clip = clipboardPanel(v);
    };
    await listen<{ id: number }>("clip-open", (e) => void openClip(e.payload));
    await listen<{ session: number; text: string }>(
      "clip-insert",
      async ({ payload }) => {
        if (clip?.id !== payload.session) return;
        const dest = priorFocus;
        if (
          !(
            dest instanceof HTMLTextAreaElement ||
            dest instanceof HTMLInputElement
          ) ||
          dest.readOnly ||
          dest.disabled
        ) {
          clip.error(t("clip.pasteFailed"));
          return;
        }
        const start = dest.selectionStart,
          end = dest.selectionEnd;
        if (start === null || end === null) {
          clip.error(t("clip.pasteFailed"));
          return;
        }
        dest.setRangeText(payload.text, start, end, "end");
        dest.dispatchEvent(new Event("input", { bubbles: true }));
        await invoke("clip_close", { session: payload.session });
      },
    );
    await listen<import("./clipboardSettings.ts").ClipPreferences>(
      "clip-preferences-updated",
      ({ payload }) => clip?.preferences(payload),
    );
    await listen("clip-updated", () => clip?.refresh());
    await listen<{ id: number }>("clip-closed", (e) => {
      if (openingClip !== e.payload.id) return;
      openingClip = 0;
      clip?.dispose();
      clip = undefined;
      root.inert = false;
      priorFocus?.focus({ preventScroll: true });
      priorFocus = null;
      resize();
      life.arm();
    });
    const activeClip = await invoke<{ id: number } | null>("clip_session");
    if (activeClip) await openClip(activeClip);
    await watchWindowAppearance();
    await listen<{ side: "above" | "below"; x: number; maxHeight: number }>(
      "bubble-anchor",
      ({ payload }) => {
        shell.dataset.side = payload.side;
        shell.style.setProperty("--bubble-available", payload.maxHeight + "px");
        shell.style.setProperty("--pet-x", payload.x + "px");
      },
    );
    resize();
    const onBrain = bubbleEvents(root, {
      card,
      note,
      reply,
      token: () => view.token,
      approvalId: () => view.approval?.id,
      approvalClosed: () => {
        view.approval = undefined;
        state("tool");
      },
      state,
      showRemembered,
    });
    await listen<any>("brain-event", (e) => onBrain(e.payload));
    await listen<{ enabled: boolean; translation: boolean }>(
      "companion-settings",
      (e) => {
        if (view.mode === "translate" && !e.payload.translation) {
          if (view.token && e.payload.enabled)
            void invoke("cancel_chat", { token: view.token });
          view.token = "";
          reset();
          hide();
        }
      },
    );
    await listen<Notice[]>("reminders-due", (e) => drawNotices(e.payload));
    await listen<{ reminders: boolean }>("companion-settings", (e) => {
      if (!e.payload.reminders) drawNotices([]);
    });
    await listen("bubble-panel-open", () => {
      clearLook();
      if (view.approval) return;
      view.token = "";
      reset();
      state("input");
      root.hidden = true;
    });
    await listen("bubble-pet-click", () => {
      if (focusLocked()) return;
      life.petClick();
    });
    // 番茄钟's question under what the bubble shows now (focus.rs).
    await listen<FocusAsk>("bubble-focus", (e) => {
      lookAtCard();
      void focus.ask(e.payload);
    });
    // 待办: an alert went off while the bubble shows something else.
    await listen("todo-due", () => {
      lookAtCard();
      todo.show("due");
    });
    // 手机传文件: a phone asks to send, under what the bubble shows now.
    await listen<PhoneOffer>("phone-offer", (e) => {
      lookAtCard();
      phone.ask(e.payload);
    });
    // A tip under what the bubble shows now (tips.rs).
    await listen<string>("bubble-tip", (e) => {
      lookAtCard();
      void tip.say(e.payload, false);
    });
    await listen<Intent>("bubble-open", (e) => open(e.payload));
    const pending = await invoke<Intent | null>("bubble_intent");
    if (pending) open(pending);
    drawNotices(await invoke<Notice[]>("pending_reminders"));
    void focus.sync();
  } else
    previewBubble({
      shell,
      input,
      original,
      originalText,
      note,
      action,
      pick,
      thread,
      showMine,
      reset,
      state,
      paint,
      error,
      drawNotices,
      showRemembered,
      openRequest: (request) => open({ mode: "authorization", request }),
      setVisible: reply.setText,
      setMode: (m) => (view.mode = m),
      translated: (into, target) => {
        translation.done(into);
        translation.selected(target);
      },
      clearApproval: () => (view.approval = undefined),
      tip: (id, alone) => void tip.say(id, alone),
      focus: (phase) => void focus.ask(phase),
      phone,
    });
}
