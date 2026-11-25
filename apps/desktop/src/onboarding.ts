// 上手引导 (plan/17 3.1, 3.4): three steps at the top of 设置 — connect a
// model, see what the two permissions are for, then really call the pet
// once. It opens by itself on the first launch (tips.rs), stays while the
// brain is off, and 通用 can open it again. Each step shows a demo instead
// of a list of shortcuts to learn.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { presets, type CompanionSettings } from "../../shared/companion.ts";
import { native } from "./bridge.ts";
import { playDemo } from "./demos/index.ts";
import { named, t } from "./i18n.ts";
import {
  describePermissionState,
  getPermissionStatus,
  openPermissionSettings,
  type PermissionKind,
  type PermissionSnapshot,
} from "./permissionsView.ts";
import { shortcutLabel } from "./shortcutRecorder.ts";
import "./styles/onboarding-demo.css";
import { guideShown, tipsOff, tipsState } from "./tips.ts";

export function mountGuide(o: {
  page: HTMLElement;
  /** The 上手引导 settings group. */
  group: HTMLElement;
  current: () => CompanionSettings;
  setup: { open(): void };
}) {
  const { page, current, setup } = o;
  const onboard = document.createElement("section");
  onboard.className = "onboard";
  onboard.hidden = true;
  // While the brain is off the guide waits as one line; 继续设置 opens the
  // three steps in its place. First launch and 通用 open the steps directly.
  const banner = document.createElement("div");
  banner.className = "onboard-banner";
  banner.hidden = true;
  page.prepend(banner, onboard);
  let step = 1,
    dismissed = false,
    talked = false,
    greeted = false,
    permDemo = "menu-translate",
    permSnap: PermissionSnapshot | null = null,
    demo: { destroy(): void } | null = null;

  const permRow = (
    kind: PermissionKind,
    title: string,
    why: string,
    demoId: string,
  ) => {
    const enabled = permSnap ? permSnap.prefs[kind] : true;
    const osState = permSnap ? permSnap.os[kind] : "on_demand";
    const state = describePermissionState(enabled, osState);
    return `<div class="onboard-row" data-on="${permDemo === demoId}">
      <span class="onboard-row-copy">${title}<small>${why}</small></span>
      <div class="onboard-row-actions">
        <span class="perm-state" data-tone="${state.tone}"><i class="perm-dot" aria-hidden="true"></i>${state.label}</span>
        <button type="button" class="link" data-demo="${demoId}">${t("onboard.seeHow")}</button>
        <button type="button" class="perm-link" data-perm="${kind}">${t("settings.openSystemSettings")}<span class="perm-chev" aria-hidden="true">›</span></button>
      </div>
    </div>`;
  };

  const body = (saved: CompanionSettings) => {
    if (step === 1)
      return `<h2>${t("onboard.modelTitle")}</h2><p class="set-note">${t("onboard.modelNote")}</p>
        <p class="onboard-connection">${saved.modelVerified ? t("onboard.verified", { service: named("service." + saved.service, presets[saved.service][0]) }) : t("onboard.waiting")}</p>
        <button type="button" data-onboard-model>${t("onboard.pickService")}</button>`;
    if (step === 2) {
      const mac = permSnap
        ? permSnap.platform === "mac"
        : /Mac/i.test(navigator.platform || navigator.userAgent);
      if (!mac && permDemo === "menu-translate") permDemo = "snip";
      return `<h2>${t(mac ? "onboard.permTitle" : "onboard.permTitleWin")}</h2><p class="set-note">${t("onboard.permNote")}</p>
        ${
          mac
            ? `${permRow("accessibility", t("perm.mac.accessibility"), t("onboard.accessibilityWhy"), "menu-translate")}
               ${permRow("screen", t("perm.mac.screen"), t("onboard.screenWhy"), "snip")}`
            : `${permRow("screen", t("perm.win.screen"), t("onboard.screenWhy"), "snip")}
               <p class="perm-footnote">${t("perm.win.footerNote")}</p>`
        }
        <p class="onboard-perm-all"><button type="button" class="link" data-perm-all>${t("onboard.manageAllPerms")}</button></p>
        <div class="onboard-demo" data-demo-host></div>`;
    }
    return `<h2>${t("onboard.helloTitle")}</h2><p class="set-note">${saved.chatShortcut ? t("onboard.helloNote", { key: shortcutLabel(saved.chatShortcut) }) : t("onboard.helloNoteClick")}</p>
      <div class="onboard-demo" data-demo-host></div>
      <p class="onboard-connection" data-talked="${talked}">${talked ? t("onboard.talked") : t("onboard.waitingHello")}</p>
      <p class="set-note">${t("onboard.makePetTip")}</p>
      <div class="onboard-explore" data-onboard-explore>
        <p class="onboard-explore-title">${t("onboard.exploreTitle")}</p>
        <p class="set-note">${t("onboard.exploreNote")}</p>
        <button type="button" data-skill-book>${t("onboard.skillBook")}</button>
      </div>`;
  };

  const syncSkillsHighlight = (on: boolean) => {
    const key = page.ownerDocument.querySelector<HTMLElement>("#skills-key");
    if (key) key.toggleAttribute("data-guide-highlight", on);
  };

  const draw = () => {
    const saved = current();
    const steps = [t("onboard.step1"), t("onboard.step2"), t("onboard.step3")];
    demo?.destroy();
    demo = null;
    syncSkillsHighlight(step === 3);
    const step1Ready = saved.enabled && saved.modelVerified;
    const nextLabel =
      step === 3
        ? t("common.done")
        : step === 1 && !step1Ready
          ? t("onboard.skipStep")
          : t("common.next");
    onboard.innerHTML = `<ol class="onboard-steps">${steps.map((s, i) => `<li data-on="${i + 1 === step}" data-done="${i + 1 < step}">${s}</li>`).join("")}</ol>
      <div class="onboard-body">${body(saved)}</div>
      <footer class="onboard-foot">${step > 1 ? `<button type="button" data-onboard="prev">${t("common.back")}</button>` : `<button type="button" class="link" data-onboard="later">${t("common.later")}</button>`}<span></span><button type="button" class="primary" data-onboard="next">${nextLabel}</button></footer>`;
    // On reaching 打个招呼 with a model, the pet speaks first, once.
    if (
      step === 3 &&
      native &&
      saved.enabled &&
      saved.modelVerified &&
      !greeted &&
      !talked
    ) {
      greeted = true;
      void invoke("greet_user").catch(() => {});
    }
    const host = onboard.querySelector<HTMLElement>("[data-demo-host]");
    if (host) {
      const id = step === 2 ? permDemo : "chat-shortcut";
      const shown = id;
      void playDemo(host, id).then((d) => {
        // A redraw while loading has its own demo by now.
        if (host.isConnected && (step === 3 || permDemo === shown)) demo = d;
        else d.destroy();
      });
    }
  };

  /** Steps still to do: a verified model, and the permissions the OS denied. */
  const remaining = () => {
    const saved = current();
    const left: number[] = [];
    if (!(saved.enabled && saved.modelVerified)) left.push(1);
    if (permSnap) {
      const kinds: PermissionKind[] =
        permSnap.platform === "mac" ? ["accessibility", "screen"] : ["screen"];
      const denied = kinds.some(
        (k) =>
          describePermissionState(permSnap!.prefs[k], permSnap!.os[k]).tone ===
          "warn",
      );
      if (denied) left.push(2);
    }
    return left;
  };
  const drawBanner = () => {
    const left = remaining();
    const names = left.map((n) => t(`onboard.step${n}` as "onboard.step1"));
    banner.dataset.first = String(left[0] ?? 1);
    banner.innerHTML = `<span class="onboard-ring" style="--done:${(2 - left.length) / 2}" aria-hidden="true"></span>
      <span class="onboard-banner-copy"><b>${t("onboard.bannerLeft", { n: left.length })}</b>${names.length ? `<span> · ${names.join(" · ")}</span>` : ""}</span>
      <button type="button" class="primary" data-banner="go">${t("onboard.bannerGo")}</button>
      <button type="button" class="onboard-banner-close" data-banner="close" aria-label="${t("common.later")}" title="${t("common.later")}">×</button>`;
  };
  banner.onclick = (e) => {
    const go = (e.target as HTMLElement).closest<HTMLElement>("[data-banner]")
      ?.dataset.banner;
    // Same as the passive card before it: not a first-launch showing.
    if (go === "go") open(Number(banner.dataset.first) || 1, false);
    if (go === "close") {
      dismissed = true;
      banner.hidden = true;
    }
  };

  const refreshPerms = () => {
    void getPermissionStatus()
      .then((snap) => {
        permSnap = snap;
        if (!onboard.hidden && step === 2) draw();
        if (!banner.hidden) drawBanner();
      })
      .catch(() => {});
  };

  onboard.onclick = (e) => {
    const target = e.target as HTMLElement;
    if (target.closest("[data-onboard-model]")) return setup.open();
    if (target.closest("[data-perm-all]")) {
      dismissed = true;
      close();
      page.dispatchEvent(
        new CustomEvent("settings-reveal", { detail: "access", bubbles: true }),
      );
      return;
    }
    const perm = target.closest<HTMLElement>("[data-perm]")?.dataset.perm as
      | PermissionKind
      | undefined;
    if (perm) return void openPermissionSettings(perm);
    const demoId = target.closest<HTMLElement>("[data-demo]")?.dataset.demo;
    if (demoId) {
      permDemo = demoId;
      return draw();
    }
    if (target.closest("[data-skill-book]"))
      return void page.ownerDocument.dispatchEvent(
        new CustomEvent("skill-book-open"),
      );
    const go = target.closest<HTMLElement>("[data-onboard]")?.dataset.onboard;
    if (go === "later") {
      dismissed = true;
      close();
    }
    if (go === "prev") {
      step--;
      draw();
      if (step === 2) refreshPerms();
    }
    if (go === "next") {
      if (step === 3) close();
      else {
        step++;
        draw();
        if (step === 2) refreshPerms();
      }
    }
  };
  const close = () => {
    demo?.destroy();
    demo = null;
    syncSkillsHighlight(false);
    onboard.hidden = true;
    delete page.dataset.guiding;
  };
  const open = (from = 1, markShown = true) => {
    banner.hidden = true;
    step = from;
    draw();
    if (step === 2) refreshPerms();
    onboard.hidden = false;
    if (markShown) {
      page.dataset.guiding = "true";
      guideShown();
    }
    onboard.scrollIntoView({ block: "start" });
  };

  window.addEventListener("focus", () => {
    if (!onboard.hidden && step === 2) refreshPerms();
  });
  if (native) {
    void listen<PermissionSnapshot>("permissions-changed", (e) => {
      permSnap = e.payload;
      if (!onboard.hidden && step === 2) draw();
      if (!banner.hidden) drawBanner();
    });
  }

  // Step 3 waits for a real first chat.
  if (native)
    void listen("chat-updated", () => {
      talked = true;
      if (!onboard.hidden && step === 3) draw();
    });

  // 设置 · 上手引导: the three steps, 它会的事, and teaching on or off.
  o.group.insertAdjacentHTML(
    "beforeend",
    `<button type="button" class="set-row-link" data-guide-steps><span class="row-label"><span class="row-name">${t("guide.steps")}</span><small class="row-desc">${t("guide.stepsNote")}</small></span><span class="row-chev" aria-hidden="true">›</span></button>
    <button type="button" class="set-row-link" data-guide-skills><span class="row-label"><span class="row-name">${t("guide.skills")}</span><small class="row-desc">${t("guide.skillsNote")}</small></span><span class="row-chev" aria-hidden="true">›</span></button>
    <div class="switch-row"><span>${t("onboard.teach")}</span><input type="checkbox" role="switch" class="slide-switch" data-guide-teach aria-label="${t("onboard.teach")}"></div>`,
  );
  const teach = o.group.querySelector<HTMLInputElement>("[data-guide-teach]")!;
  // Not a companion setting: keep its change out of the form's save.
  teach.addEventListener("change", (e) => {
    e.stopPropagation();
    void tipsOff(!teach.checked);
  });
  o.group.querySelector<HTMLElement>("[data-guide-steps]")!.onclick = () =>
    open();
  o.group.querySelector<HTMLElement>("[data-guide-skills]")!.onclick = () =>
    document.dispatchEvent(new CustomEvent("skill-book-open"));
  void tipsState().then((r) => (teach.checked = !r.off));

  return {
    refresh() {
      if (!onboard.hidden) draw();
    },
    /** While the brain is off, the guide waits as one line under the tabs. */
    show() {
      if (current().enabled) {
        banner.hidden = true;
        return;
      }
      if (dismissed || !onboard.hidden) return;
      drawBanner();
      banner.hidden = false;
      if (!permSnap) refreshPerms();
    },
    open,
  };
}
