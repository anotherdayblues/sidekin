// The screenshot card (window "snipcard"): the capture shown large with its
// text selectable right on the picture, and clear actions underneath.
// Asking and translating hand off to the pet's bubble.
import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import { watchWindowAppearance } from "./skin.ts";
import { glyphs } from "./icons.ts";
import {
  layoutTextLayer,
  renderTextLayer,
  selectionIn,
  watchTextLayer,
  type OcrLine,
} from "./textLayer.ts";
import "./snipCard.css";

export interface CardData {
  generation: number;
  preview: string;
  canVision: boolean;
  brainEnabled: boolean;
  translation: boolean;
  ocr: { lines: OcrLine[]; text: string; error?: string } | null;
}

const MAX_W = 760,
  MAX_H = 520,
  MIN_W = 360;

export async function mountSnipCard(root: HTMLElement) {
  document.documentElement.classList.add("snipcard-window");
  const docLang = (document.documentElement.lang ||= "zh-CN");
  root.innerHTML = `<section class="snipcard-shell"><article class="snipcard" aria-label="${t("snip.title")}">
    <header data-tauri-drag-region><strong data-tauri-drag-region>${t("snip.title")}</strong><small data-status data-tauri-drag-region role="status"></small><button type="button" data-close></button></header>
    <div class="snipcard-stage"><div class="snipcard-frame"><img alt="${t("snip.title")}" draggable="false"><div class="snipcard-text" lang="${docLang}" aria-label="${t("snip.textInImage")}"></div></div></div>
    <div class="snipcard-actions"><button type="button" data-copy-text>${t("snip.copyText")}</button><button type="button" data-copy-image>${t("snip.copyImage")}</button><button type="button" data-translate>${t("selection.translate")}</button></div>
    <label class="snipcard-destination">${t("snip.sendTo")}<select aria-label="${t("snip.sendToChat")}"></select></label>
    <form class="snipcard-ask" data-ask><textarea rows="1" placeholder="${t("snip.askImage")}" aria-label="${t("snip.ask")}"></textarea><button type="submit" data-send>${t("snip.ask")}</button></form>
    <p class="snipcard-hint" data-hint hidden></p>
    <footer class="snipcard-foot" hidden><details class="snipcard-plain"><summary>${t("snip.plain")}</summary><div class="snipcard-plain-text" tabindex="0"></div></details><small class="snipcard-note">${t("snip.ocrNote")}</small></footer>
  </article></section>`;
  const pick = <T extends HTMLElement>(q: string) => root.querySelector<T>(q)!;
  const shell = pick(".snipcard-shell"),
    frame = pick(".snipcard-frame"),
    img = pick<HTMLImageElement>("img"),
    layer = pick(".snipcard-text"),
    status = pick("[data-status]"),
    copyText = pick<HTMLButtonElement>("[data-copy-text]"),
    copyImage = pick<HTMLButtonElement>("[data-copy-image]"),
    translate = pick<HTMLButtonElement>("[data-translate]"),
    ask = pick<HTMLFormElement>("[data-ask]"),
    input = pick<HTMLTextAreaElement>("textarea"),
    hint = pick("[data-hint]"),
    foot = pick(".snipcard-foot"),
    plain = pick<HTMLDetailsElement>(".snipcard-plain"),
    plainText = pick(".snipcard-plain-text"),
    close = pick<HTMLButtonElement>("[data-close]");
  close.innerHTML = glyphs.close;
  close.setAttribute("aria-label", t("common.close"));
  close.title = t("snip.closeEsc");
  watchTextLayer(layer);

  let card: CardData | null = null,
    text = "",
    selected = "";

  const flash = (b: HTMLButtonElement, label: string, done: string) => {
    b.textContent = done;
    setTimeout(() => (b.textContent = label), 1400);
  };
  function labels() {
    copyText.textContent = selected ? t("snip.copySelected") : t("snip.copyText");
    translate.textContent = selected ? t("snip.translateSelected") : t("selection.translate");
    input.placeholder = selected
      ? t("snip.askSelected")
      : t("snip.askImage");
    copyText.disabled = !selected && !text;
    translate.disabled = !selected && !text;
  }
  function track() {
    const now = selectionIn(layer) || selectionIn(plainText);
    if (now === selected) return;
    selected = now;
    labels();
  }
  document.addEventListener("selectionchange", track);

  // Shown at the picture's real size (one image pixel per screen pixel),
  // shrunk only when it would not fit.
  function fit() {
    if (!img.naturalWidth) return;
    const ratio = devicePixelRatio || 1;
    let w = img.naturalWidth / ratio,
      h = img.naturalHeight / ratio;
    const k = Math.min(1, MAX_W / w, MAX_H / h);
    w = Math.max(1, Math.round(w * k));
    h = Math.max(1, Math.round(h * k));
    frame.style.width = w + "px";
    frame.style.height = h + "px";
    // The picture plus the shell's and card's side padding, read from CSS
    // so a skin's padding never pushes the picture past the card.
    const sides = (el: Element) => {
      const s = getComputedStyle(el);
      return parseFloat(s.paddingLeft) + parseFloat(s.paddingRight);
    };
    shell.style.width =
      Math.max(MIN_W, w + sides(shell) + sides(shell.firstElementChild!)) + "px";
  }
  function resize() {
    if (!card || !native) return;
    void invoke("size_snip_card", {
      generation: card.generation,
      width: shell.offsetWidth,
      height: shell.offsetHeight,
    });
  }
  new ResizeObserver(() => {
    layoutTextLayer(layer, frame.clientWidth, frame.clientHeight);
    resize();
  }).observe(shell);
  new ResizeObserver(() =>
    layoutTextLayer(layer, frame.clientWidth, frame.clientHeight),
  ).observe(frame);
  let lastPixelRatio = devicePixelRatio;
  window.addEventListener("resize", () => {
    if (lastPixelRatio !== devicePixelRatio) {
      lastPixelRatio = devicePixelRatio;
      fit();
      resize();
    }
  });
  img.onload = () => {
    fit();
    layoutTextLayer(layer, frame.clientWidth, frame.clientHeight);
    resize();
  };

  function applyOcr(o: CardData["ocr"]) {
    if (!o) {
      status.textContent = t("snip.ocrRunning");
      text = "";
    } else if (o.error) {
      status.textContent = o.error === "ocrLanguage" ? t("snip.ocrLanguage") : t("snip.ocrFailed");
      text = "";
    } else if (!o.lines.length) {
      status.textContent = t("snip.ocrNone");
      text = "";
    } else {
      status.textContent = t("snip.ocrReady");
      text = o.text;
    }
    renderTextLayer(layer, o?.lines ?? []);
    layoutTextLayer(layer, frame.clientWidth, frame.clientHeight);
    plainText.textContent = text;
    foot.hidden = !text;
    selected = "";
    labels();
  }
  const destination = pick<HTMLSelectElement>(".snipcard-destination select");
  /** `chosen`: the topic to select, in place of the open one. */
  async function loadTopics(d: CardData, chosen?: number) {
    destination.replaceChildren(new Option(t("chat.newTopic"), ""));
    destination.disabled = true;
    try {
      const choices = native ? await invoke<{ current: number | null; topics: {id:number; title:string}[] }>("snip_topics") : null;
      if (card !== d) return;
      for (const topic of choices?.topics ?? []) {
        const active = topic.id === choices?.current;
        destination.add(new Option((active ? t("snip.current") : "") + (topic.title || t("snip.untitled")), String(topic.id), false, active));
      }
      if (chosen !== undefined) destination.value = String(chosen);
    } catch {
      if (card === d) status.textContent = t("snip.topicsFailed");
    } finally {
      if (card === d) destination.disabled = false;
    }
  }
  function open(d: CardData) {
    card = d;
    const brain = d.brainEnabled;
    translate.hidden = !d.translation;
    ask.hidden = !brain;
    destination.parentElement!.hidden = !brain;
    if (brain) void loadTopics(d);
    hint.hidden = brain;
    hint.textContent = t("snip.needsModel");
    input.value = "";
    plain.open = false;
    copyImage.textContent = t("snip.copyImage");
    applyOcr(d.ocr);
    if (img.src !== d.preview) img.src = d.preview;
    else img.onload?.(new Event("load"));
    input.focus({ preventScroll: true });
  }

  copyText.onclick = async () => {
    const value = selected || text;
    if (!value) return;
    try {
      await invoke("copy_translation", { text: value });
      flash(copyText, copyText.textContent!, t("common.copied"));
    } catch {
      flash(copyText, copyText.textContent!, t("common.retry"));
    }
  };
  copyImage.onclick = async () => {
    if (!card) return;
    try {
      await invoke("snip_copy_image", { generation: card.generation });
      flash(copyImage, t("snip.copyImage"), t("common.copied"));
    } catch {
      flash(copyImage, t("snip.copyImage"), t("common.retry"));
    }
  };
  translate.onclick = () => {
    const value = selected || text;
    if (value) void invoke("snip_card_translate", { text: value });
  };
  function send() {
    if (!card || destination.disabled) return;
    const typed = input.value.trim();
    const question = selected
      ? t("snip.askAboutText", { text: selected, question: typed || t("snip.whatMeans") })
      : typed || t("chat.whatIsThis");
    void invoke("snip_card_ask", { generation: card.generation, question, topic: destination.value ? Number(destination.value) : null })
      .then(() => {
        input.value = "";
        status.textContent = t("snip.sent");
      })
      .catch(e => (status.textContent = String(e)));
  }
  ask.onsubmit = (e) => {
    e.preventDefault();
    send();
  };
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  };
  // Buttons must not steal the selection they act on.
  for (const b of [copyText, translate])
    b.onmousedown = (e) => e.preventDefault();

  function dismiss() {
    if (card && native)
      void invoke("snip_card_close", { generation: card.generation });
    card = null;
  }
  close.onclick = dismiss;
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && !e.isComposing) dismiss();
    // ⌘C / Ctrl+C with a selection on the picture copies it cleanly.
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "c") {
      const value = selectionIn(layer);
      if (value) {
        e.preventDefault();
        void invoke("copy_translation", { text: value });
      }
    }
  });

  if (native) {
    await watchWindowAppearance();
    await listen<CardData>("snip-card", (e) => open(e.payload));
    // The first message from 新话题 opened a topic: the rest go there too.
    await listen<{ generation: number; topic: number }>("snip-topic", (e) => {
      if (card && e.payload.generation === card.generation)
        void loadTopics(card, e.payload.topic);
    });
    await listen<{ generation: number; ocr: CardData["ocr"] }>(
      "snip-card-ocr",
      (e) => {
        if (!card || e.payload.generation !== card.generation) return;
        card.ocr = e.payload.ocr;
        applyOcr(e.payload.ocr);
      },
    );
    const pending = await invoke<CardData | null>("snip_card");
    if (pending) open(pending);
  } else {
    Object.assign(window, { __snipCard: { open, applyOcr } });
  }
}
