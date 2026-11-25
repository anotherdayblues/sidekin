// Unified OS permissions UI & bridge (Single Source of Truth for Settings,
// Onboarding Step 2, and runtime permission prompts).
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";
import { t, type Key } from "./i18n.ts";

export type PermissionKind =
  | "accessibility"
  | "screen"
  | "appData"
  | "localNetwork";

export type OsGrantState = "granted" | "denied" | "on_demand" | "not_needed";

export interface PermissionSnapshot {
  platform: "mac" | "win" | "other";
  prefs: Record<PermissionKind, boolean>;
  os: Record<PermissionKind, OsGrantState>;
}

export interface PermissionMeta {
  kind: PermissionKind;
  titleKey: Key;
  descKey: Key;
}

const MAC_ITEMS: readonly PermissionMeta[] = [
  {
    kind: "accessibility",
    titleKey: "perm.mac.accessibility",
    descKey: "perm.mac.accessibilityDesc",
  },
  {
    kind: "screen",
    titleKey: "perm.mac.screen",
    descKey: "perm.mac.screenDesc",
  },
  {
    kind: "appData",
    titleKey: "perm.mac.appData",
    descKey: "perm.mac.appDataDesc",
  },
  {
    kind: "localNetwork",
    titleKey: "perm.mac.localNetwork",
    descKey: "perm.mac.localNetworkDesc",
  },
];

const WIN_ITEMS: readonly PermissionMeta[] = [
  {
    kind: "screen",
    titleKey: "perm.win.screen",
    descKey: "perm.win.screenDesc",
  },
  {
    kind: "localNetwork",
    titleKey: "perm.win.localNetwork",
    descKey: "perm.win.localNetworkDesc",
  },
];

function guessPlatform(): "mac" | "win" | "other" {
  const hint = document.documentElement.dataset.platform;
  if (hint === "mac") return "mac";
  if (hint === "win") return "win";
  if (/Mac/i.test(navigator.platform || navigator.userAgent)) return "mac";
  if (/Win/i.test(navigator.platform || navigator.userAgent)) return "win";
  return "other";
}

let previewSnapshot: PermissionSnapshot | null = null;
function fallbackSnapshot(): PermissionSnapshot {
  if (!previewSnapshot) {
    const platform = guessPlatform();
    previewSnapshot = {
      platform,
      prefs: {
        accessibility: true,
        screen: true,
        appData: true,
        localNetwork: true,
      },
      os:
        platform === "mac"
          ? {
              accessibility: "denied",
              screen: "denied",
              appData: "on_demand",
              localNetwork: "on_demand",
            }
          : {
              accessibility: "not_needed",
              screen: "on_demand",
              appData: "not_needed",
              localNetwork: "on_demand",
            },
    };
  }
  return structuredClone(previewSnapshot);
}

export function permissionItems(platform: PermissionSnapshot["platform"]) {
  return platform === "mac" ? MAC_ITEMS : WIN_ITEMS;
}

export async function getPermissionStatus(): Promise<PermissionSnapshot> {
  if (!native) return fallbackSnapshot();
  const snap = await invoke<PermissionSnapshot | null>(
    "permissions_status",
  ).catch(() => null);
  return snap?.prefs && snap?.os ? snap : fallbackSnapshot();
}

export async function setPermissionEnabled(
  kind: PermissionKind,
  enabled: boolean,
): Promise<PermissionSnapshot> {
  if (!native) {
    const snap = fallbackSnapshot();
    snap.prefs[kind] = enabled;
    previewSnapshot = snap;
    return structuredClone(snap);
  }
  const snap = await invoke<PermissionSnapshot | null>(
    "set_permission_enabled",
    {
      kind,
      enabled,
    },
  );
  return snap?.prefs && snap?.os ? snap : fallbackSnapshot();
}

export async function openPermissionSettings(kind: PermissionKind) {
  if (!native) return;
  await invoke("open_permission_settings", { kind });
}

export async function openAppPermissionsPage() {
  if (!native) return;
  await invoke("open_companion_page", { history: false, section: "access" });
}

export function describePermissionState(
  enabled: boolean,
  osState: OsGrantState,
): { label: string; tone: "ok" | "warn" | "neutral" | "off" } {
  if (!enabled) return { label: t("perm.state.off"), tone: "off" };
  if (osState === "granted")
    return { label: t("perm.state.granted"), tone: "ok" };
  if (osState === "denied")
    return { label: t("perm.state.denied"), tone: "warn" };
  return { label: t("perm.state.onDemand"), tone: "neutral" };
}

/** Mounts the unified OS permissions list inside Settings (#set-access). */
export function mountPermissionsSettings(
  group: HTMLElement,
  note: HTMLElement | null = null,
) {
  const list = document.createElement("div");
  list.className = "perm-list";
  const footer = document.createElement("p");
  footer.className = "perm-footnote";
  footer.hidden = true;
  group.append(list, footer);

  let latest: PermissionSnapshot = fallbackSnapshot();
  let busyKind: PermissionKind | null = null;

  function render(snap: PermissionSnapshot) {
    if (!snap?.prefs || !snap?.os) return;
    latest = snap;
    const rows = permissionItems(snap.platform);
    if (note) {
      note.textContent = t(
        snap.platform === "mac" ? "perm.noteMac" : "perm.noteWin",
      );
    }
    list.innerHTML = rows
      .map((item) => {
        const enabled = snap.prefs[item.kind];
        const osState = snap.os[item.kind];
        const state = describePermissionState(enabled, osState);
        const title = t(item.titleKey);
        const desc = t(item.descKey);
        return `<div class="perm-row" data-perm-kind="${item.kind}" data-enabled="${enabled}" data-os="${osState}">
          <div class="perm-meta">
            <span class="perm-title">${title}</span>
            <small class="perm-desc">${desc}</small>
          </div>
          <div class="perm-controls">
            <span class="perm-state" data-tone="${state.tone}"><i class="perm-dot" aria-hidden="true"></i>${state.label}</span>
            <button type="button" class="perm-link" data-perm-open="${item.kind}">${t("settings.openSystemSettings")}<span class="perm-chev" aria-hidden="true">›</span></button>
            <input type="checkbox" role="switch" class="slide-switch" data-perm-toggle="${item.kind}" ${enabled ? "checked" : ""} ${busyKind === item.kind ? "disabled" : ""} aria-label="${title}">
          </div>
        </div>`;
      })
      .join("");
    if (snap.platform !== "mac") {
      footer.textContent = t("perm.win.footerNote");
      footer.hidden = false;
    } else {
      footer.hidden = true;
    }
  }

  async function refresh() {
    const snap = await getPermissionStatus().catch(() => latest);
    render(snap);
  }

  list.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLElement>(
      "[data-perm-open]",
    );
    if (!btn) return;
    e.stopPropagation();
    const kind = btn.dataset.permOpen as PermissionKind;
    void openPermissionSettings(kind);
  });

  // Never bubble permission toggle changes into companion.ts's settings form.
  list.addEventListener("input", (e) => {
    if ((e.target as HTMLElement).matches("[data-perm-toggle]"))
      e.stopPropagation();
  });
  list.addEventListener("change", (e) => {
    const input = (e.target as HTMLElement).closest<HTMLInputElement>(
      "[data-perm-toggle]",
    );
    if (!input) return;
    e.stopPropagation();
    const kind = input.dataset.permToggle as PermissionKind;
    const enabled = input.checked;
    busyKind = kind;
    void setPermissionEnabled(kind, enabled)
      .then((snap) => {
        busyKind = null;
        render(snap);
        // When re-enabling a live-checked permission that OS hasn't granted yet,
        // take the user straight to OS Settings in one step.
        if (enabled && snap.os[kind] === "denied") {
          void openPermissionSettings(kind);
        }
      })
      .catch(() => {
        busyKind = null;
        void refresh();
      });
  });

  window.addEventListener("focus", () => void refresh());
  if (native) {
    void listen<PermissionSnapshot>("permissions-changed", (e) =>
      render(e.payload),
    );
  }

  render(latest);
  void refresh();

  return { refresh };
}
