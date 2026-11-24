// 手机传文件 in the bubble (plan/20): the QR code to scan, the question when
// a phone wants to send (收下 / 不要 / 这台手机以后直接收), and text that came
// from the phone, with 复制 and, for a link, 打开. The host does the rest
// (phone/mod.rs). Under what the bubble shows, or the whole bubble when it
// opened just for this.
import "./bubblePhone.css";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import { t, tn } from "./i18n.ts";

export interface PhoneStatus {
  running: boolean;
  /** Receiving, but the computer is on no local network yet. */
  noNetwork?: boolean;
  qr?: string;
  url?: string;
  firstTime?: boolean;
}
export interface PhoneOffer {
  id: string;
  device: string;
  files: { name: string; size: number }[];
  text?: string | null;
}

const PHOTO = /\.(jpe?g|png|heic|heif|gif|webp|avif|dng)$/i;
const VIDEO = /\.(mov|mp4|m4v|3gp|webm|avi)$/i;

/** "3 张照片、1 个视频（8 MB）" for the question. */
export function offerSummary(o: PhoneOffer) {
  const photos = o.files.filter((f) => PHOTO.test(f.name)).length;
  const videos = o.files.filter((f) => VIDEO.test(f.name)).length;
  const others = o.files.length - photos - videos;
  const parts = [
    photos && tn("phone.photos", photos),
    videos && tn("phone.videos", videos),
    others && tn("phone.files", others),
  ].filter(Boolean);
  const bytes = o.files.reduce((s, f) => s + f.size, 0);
  const mb =
    bytes < 1024 * 1024
      ? `${Math.max(1, Math.round(bytes / 1024))} KB`
      : `${(bytes / 1048576).toFixed(bytes < 10485760 ? 1 : 0)} MB`;
  return (
    parts.join(t("phone.and")) +
    (o.files.length ? t("phone.size", { size: mb }) : "") +
    (o.text && o.files.length ? t("phone.plusText") : "")
  );
}

export function bubblePhone(
  el: HTMLElement,
  o: { card: HTMLElement; hide(): void; grow(): void },
) {
  let showing: "" | "qr" | "offer" | "text" = "";
  let offerId = "";
  let text = "";
  /** No phone 40 s after the code showed: the “连不上？” link glows once,
   *  inviting a look; the reasons open only when clicked. */
  let nudgeTimer = 0;
  const NUDGE_MS = 40_000;
  const mac = /Mac/.test(navigator.platform || navigator.userAgent);
  const helpList = () => {
    const tips = [
      "phone.help.wifi",
      mac ? "phone.help.firewallMac" : "phone.help.firewallWin",
      "phone.help.hotspot",
    ] as const;
    return `<div class="phone-help" data-phone-help hidden><p>${t("phone.help")}</p><ul>${tips.map((k) => `<li>${t(k)}</li>`).join("")}</ul></div>`;
  };
  const clear = () => {
    clearTimeout(nudgeTimer);
    showing = "";
    el.hidden = true;
    el.replaceChildren();
    delete el.dataset.show;
  };
  /** Closes this part; the whole bubble when it opened just for it. */
  const done = () => {
    const alone = o.card.dataset.state === "phone";
    clear();
    if (alone) o.hide();
  };
  const show = (kind: typeof showing, html: string) => {
    showing = kind;
    el.dataset.show = kind;
    el.innerHTML = html;
    el.hidden = false;
    o.grow();
  };

  /** Phones that opened the page while the code shows: several may. */
  let phones: string[] = [];
  let last: PhoneStatus | null = null;
  function qr(s: PhoneStatus) {
    if (!s.running) return done();
    const fresh = showing !== "qr";
    if (fresh) phones = [];
    last = s;
    // No network: say so; the code comes by itself once there is one.
    if (s.noNetwork || !s.qr)
      return show(
        "qr",
        `<p>${t("phone.noNetwork")}</p><span><button type="button" data-phone-act="stop">${t("phone.stop")}</button></span>`,
      );
    const open =
      !el.querySelector("[data-phone-help]")?.hasAttribute("hidden") &&
      !!el.querySelector("[data-phone-help]");
    // The QR code is SVG the host drew from its own address. It stays after
    // a phone connects, so another phone can scan it too. Phone names are
    // text the phones gave, set as text below.
    show(
      "qr",
      `<figure class="phone-qr" title="${s.url ?? ""}">${s.qr}</figure>
      <ul class="phone-linked" data-phone-linked${phones.length ? "" : " hidden"}>${phones.map(() => "<li></li>").join("")}</ul>
      <p>${t(phones.length ? "phone.scanMore" : "phone.scan")}</p>
      ${s.firstTime && !phones.length ? `<p class="phone-note">${t(mac ? "phone.firewallMac" : "phone.firewallWin")}</p>` : ""}
      ${helpList()}
      <span class="phone-foot"><button type="button" data-phone-act="stop">${t("phone.stop")}</button><button type="button" class="phone-link" data-phone-act="help" aria-expanded="false">${t("phone.helpToggle")}</button></span>`,
    );
    el.querySelectorAll("[data-phone-linked] li").forEach(
      (li, i) => (li.textContent = t("phone.connected", { device: phones[i] })),
    );
    if (open) {
      el.querySelector("[data-phone-help]")?.removeAttribute("hidden");
      el.querySelector("[data-phone-act=help]")?.setAttribute(
        "aria-expanded",
        "true",
      );
    }
    clearTimeout(nudgeTimer);
    if (!phones.length)
      nudgeTimer = window.setTimeout(() => {
        el.querySelector("[data-phone-act=help]")?.toggleAttribute(
          "data-nudge",
          true,
        );
      }, NUDGE_MS);
  }
  function ask(offer: PhoneOffer) {
    offerId = offer.id;
    const what = offer.files.length
      ? t("phone.ask", { device: offer.device, what: offerSummary(offer) })
      : t("phone.askText", { device: offer.device, text: offer.text ?? "" });
    const p = document.createElement("p");
    p.textContent = what;
    show(
      "offer",
      `${p.outerHTML}<span><button type="button" data-phone-answer="accept">${t("phone.accept")}</button><button type="button" data-phone-answer="reject">${t("phone.reject")}</button><button type="button" data-phone-answer="trust">${t("phone.trust")}</button></span>`,
    );
  }
  function received(body: string, link: string | null) {
    text = body;
    const head = document.createElement("p");
    head.className = "phone-head";
    head.textContent = link ? t("phone.linkFrom") : t("phone.textFrom");
    const quote = document.createElement("blockquote");
    quote.textContent = body;
    show(
      "text",
      `${head.outerHTML}${quote.outerHTML}<span><button type="button" data-phone-act="copy">${t("phone.copy")}</button>${link ? `<button type="button" data-phone-act="open" data-link="${encodeURI(link)}">${t("phone.open")}</button>` : ""}<button type="button" data-phone-act="hide">${t("phone.hide")}</button></span>`,
    );
  }

  el.onclick = (e) => {
    const target = e.target as HTMLElement;
    const answer = target.closest<HTMLElement>("[data-phone-answer]")?.dataset
      .phoneAnswer;
    if (answer) {
      if (native) void invoke("phone_answer", { id: offerId, answer });
      return done();
    }
    const act = target.closest<HTMLElement>("[data-phone-act]");
    switch (act?.dataset.phoneAct) {
      case "help": {
        const list = el.querySelector<HTMLElement>("[data-phone-help]");
        if (!list) return;
        list.hidden = !list.hidden;
        act.setAttribute("aria-expanded", String(!list.hidden));
        act.removeAttribute("data-nudge");
        o.grow();
        return;
      }
      case "stop":
        if (native) void invoke("phone_stop");
        return done();
      case "copy":
        void navigator.clipboard?.writeText(text);
        act.textContent = t("phone.copied");
        return;
      case "open":
        if (native) void invoke("open_bubble_link", { url: act.dataset.link });
        return done();
      case "hide":
        return done();
    }
  };
  /** A phone opened the page: its name joins the list under the code,
   *  which stays for the next phone. */
  function linked(device: string) {
    if (showing !== "qr" || !last) return;
    const name = device || t("phone.page.aPhone");
    if (!phones.includes(name)) phones.push(name);
    qr(last);
  }
  // Stopped (by the menu, or after ten quiet minutes), or a new network:
  // the code goes away or changes.
  if (native) {
    void listen<PhoneStatus>("phone-changed", (e) => {
      if (showing === "qr") qr(e.payload);
    });
    void listen<{ device: string }>("phone-connected", (e) =>
      linked(e.payload.device),
    );
  }
  return { qr, ask, received, linked, clear };
}
