import { ACTIONS, type Action } from "./animation.ts";
import { t } from "./i18n.ts";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type { Behavior } from "./animation.ts";
import type { Layer, Step } from "./teaching.ts";
import { applyPlan, type Plan } from "./actionPlan.ts";
import exampleUrl from "../../../examples/lizi/spritesheet.webp?url";
import liziSleep from "../../../examples/lizi-sleep/actions/sleep.png?url";
export interface Pet {
  id: string;
  displayName: string;
  description: string;
  spriteVersionNumber: number;
  spritesheetPath: string;
  sleepStrip?: string;
  fingerprint: string;
  revision: string;
  behavior?: Partial<Behavior> | null;
}
export interface Settings {
  activeId: string | null;
  visible: boolean;
  paused: boolean;
  size: number;
  position: [number, number] | null;
  behaviors: Record<string, Partial<Behavior>>;
  theme?: "system" | "day" | "night" | "clock";
  skin?: "studio" | "native";
  /** The pet page's cards, top to bottom (homeWidgets.ts); unset until changed. */
  homeCards?: { id: string }[] | null;
}
export interface Version {
  version: number;
  summary: string;
  acceptedAt: number;
}
export interface Custom {
  history: { current: number; versions: Version[] };
  layer: Layer;
}
export interface Draft {
  id: string;
  petId: string;
  summary: string;
  receivedAt: number;
  addedActions: string[];
  addedRules: string[];
  removedActions: string[];
  removedRules: string[];
  preview: Layer;
}
export interface Snapshot {
  pets: Pet[];
  settings: Settings;
  drafts: Draft[];
  custom: Record<string, Custom>;
}
/** Steps to try once on the desktop, using a draft's actions when given. */
export interface Preview {
  petId: string;
  draftId?: string | null;
  steps: Step[];
}
export const native = isTauri();
const blank: Snapshot = {
  drafts: [],
  custom: {},
  pets: [],
  settings: {
    activeId: null,
    visible: false,
    paused: false,
    size: 160,
    position: null,
    behaviors: {},
  },
};
let browserState: Snapshot = {
  ...blank,
  ...JSON.parse(localStorage.getItem("pet-studio-preview") ?? "{}"),
};
const subscribers = new Set<(s: Snapshot) => void>();
export async function state(): Promise<Snapshot> {
  return native ? invoke("get_state") : structuredClone(browserState);
}
export async function readSettings(): Promise<Settings> {
  return native
    ? invoke("get_settings")
    : structuredClone(browserState.settings);
}
export async function save(settings: Settings) {
  if (native) await invoke("save_settings", { settings });
  else {
    const next = { ...browserState, settings: structuredClone(settings) };
    localStorage.setItem("pet-studio-preview", JSON.stringify(next));
    browserState = next;
    for (const f of subscribers) f(structuredClone(browserState));
  }
}
function notify() {
  localStorage.setItem("pet-studio-preview", JSON.stringify(browserState));
  for (const f of subscribers) f(structuredClone(browserState));
}
export async function settingsErrors(fn: (message: string) => void) {
  if (native) return listen<string>("settings-error", (e) => fn(e.payload));
  return () => {};
}
export async function changes(fn: (s: Snapshot) => void) {
  if (native) return listen<Snapshot>("library-changed", (e) => fn(e.payload));
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
/** The bundled example pet, for showing something when there is no pet. */
export const exampleSprite = exampleUrl;
export async function sprite(id: string): Promise<string> {
  return native ? invoke("read_sprite", { id }) : exampleUrl;
}
/** The pet's own sleep strip; 栗子 without one sleeps with the bundled one,
 * as on the desktop (pet.ts). */
export async function renamePet(id: string, name: string) {
  if (native) return void (await invoke("rename_pet", { id, name }));
  const p = browserState.pets.find((p) => p.id === id);
  if (p) p.displayName = name.trim();
  notify();
}
export async function sleepSprite(p: Pet): Promise<string> {
  return native && p.sleepStrip
    ? invoke("read_sprite", { id: p.id, sleep: true })
    : liziSleep;
}
export async function importPackage(folder: boolean) {
  if (!native) throw new Error(t("studio.importInApp"));
  const path = await open({
    directory: folder,
    multiple: false,
    title: folder ? t("studio.pickFolder") : t("studio.pickPackage"),
    ...(!folder
      ? {
          filters: [{ name: t("studio.package"), extensions: ["zip", "json"] }],
        }
      : {}),
  });
  if (!path) return null;
  return invoke<{ pet: Pet; updated: boolean } | { draft: Draft }>(
    "import_pet",
    { path },
  );
}
export async function exportPackage(p: Pet): Promise<boolean> {
  if (!native) throw new Error(t("studio.exportInApp"));
  const safe =
    p.displayName
      .replace(/[\\/:*?"<>|]/g, "")
      .trim() || p.id;
  const path = await saveDialog({
    title: t("studio.exportTitle"),
    defaultPath: `${safe}.zip`,
    filters: [{ name: t("studio.package"), extensions: ["zip"] }],
  });
  if (!path) return false;
  await invoke("export_pet", { id: p.id, path });
  return true;
}
/** Data URL of a taught action, from a pending draft when `draftId` is set. */
export async function actionImage(
  petId: string,
  action: string,
  draftId: string | null = null,
): Promise<string> {
  if (native) return invoke("read_action_image", { petId, action, draftId });
  const layer = draftId
    ? browserState.drafts.find((d) => d.id === draftId)?.preview
    : browserState.custom[petId]?.layer;
  return previewStrip(layer?.actions[action]?.durations.length ?? 6);
}
/** Browser preview only: a stand-in strip cut from the example's waving row. */
async function previewStrip(frames: number) {
  const image = new Image();
  image.src = exampleUrl;
  await image.decode();
  const canvas = document.createElement("canvas");
  canvas.width = 192 * frames;
  canvas.height = 208;
  const ctx = canvas.getContext("2d")!;
  for (let i = 0; i < frames; i++)
    ctx.drawImage(
      image,
      (i % 4) * 192,
      3 * 208,
      192,
      208,
      i * 192,
      0,
      192,
      208,
    );
  return canvas.toDataURL();
}
/** Browser preview only: the layer each mock version holds ("pet:n"). */
const browserLayers = new Map<string, Layer>();
/** Browser preview only: replace the whole mock state (debug and captures). */
export function setBrowserState(
  next: Snapshot,
  layers: Record<string, Layer> = {},
) {
  if (native) return;
  browserState = structuredClone(next);
  for (const [key, layer] of Object.entries(layers))
    browserLayers.set(key, structuredClone(layer));
  notify();
}
function nextVersion(petId: string, layer: Layer, summary: string): Version {
  const custom = (browserState.custom[petId] ??= {
    history: { current: 0, versions: [] },
    layer: { actions: {}, rules: [] },
  });
  const version = {
    version: Math.max(0, ...custom.history.versions.map((v) => v.version)) + 1,
    summary,
    acceptedAt: Math.floor(Date.now() / 1000),
  };
  if (JSON.stringify(custom.layer) === JSON.stringify(layer))
    return { ...version, version: custom.history.current };
  custom.layer = layer;
  custom.history = { current: version.version, versions: [] };
  return version;
}
export function browserSnapshot() {
  return structuredClone(browserState);
}
export async function acceptDraft(id: string): Promise<Version> {
  if (native) return invoke<Version>("accept_draft", { id });
  // Browser preview: same outcome as the app, without files.
  await (await import("./savedActions.ts")).rememberBrowserDraft(id);
  const d = browserState.drafts.find((x) => x.id === id)!;
  const version = nextVersion(d.petId, d.preview, d.summary);
  browserState.drafts = browserState.drafts.filter((x) => x.id !== id);
  notify();
  return version;
}
/** When a learned action plays (plan/29); saved as a new version. */
export async function setActionPlan(petId: string, action: string, plan: Plan) {
  if (native) return invoke<void>("set_action_plan", { petId, action, plan });
  const layer = browserState.custom[petId].layer;
  nextVersion(
    petId,
    applyPlan(structuredClone(layer), action, plan),
    t("host.planSaved", { label: layer.actions[action].label }),
  );
  notify();
}
/**
 * Save a new version without these learned actions or rules. Rules that
 * play a removed action go too. Callers confirm with the user first.
 */
export async function forgetCustom(
  petId: string,
  actions: string[],
  rules: string[],
): Promise<Version> {
  if (native)
    return invoke<Version>("forget_custom", { petId, actions, rules });
  const layer = structuredClone(browserState.custom[petId].layer);
  const gone: string[] = [];
  for (const name of actions) {
    gone.push(t("studio.actionNamed", { label: layer.actions[name].label }));
    delete layer.actions[name];
  }
  layer.rules = layer.rules.filter((r) => {
    const drop =
      rules.includes(r.id) ||
      r.do.some(
        (s) =>
          s.play !== undefined &&
          actions.includes(s.play) &&
          !ACTIONS.includes(s.play as Action),
      );
    if (drop) gone.push(t("studio.ruleNamed", { label: r.label }));
    return !drop;
  });
  const version = nextVersion(
    petId,
    layer,
    t("studio.removedList", { list: gone.join(t("reminders.dayJoiner")) }),
  );
  notify();
  return version;
}
/** What one saved version holds, to show what going back would change. */
export async function versionLayer(
  petId: string,
  version: number,
): Promise<Layer> {
  if (native) return invoke<Layer>("version_layer", { petId, version });
  const custom = browserState.custom[petId];
  if (version === 0) return { actions: {}, rules: [] };
  return structuredClone(
    browserLayers.get(`${petId}:${version}`) ??
      (version === custom?.history.current
        ? custom.layer
        : { actions: {}, rules: [] }),
  );
}
export async function discardDraft(id: string) {
  if (native) return void (await invoke("discard_draft", { id }));
  await (await import("./savedActions.ts")).rememberBrowserDraft(id);
  browserState.drafts = browserState.drafts.filter((x) => x.id !== id);
  notify();
}
/** Deletes the pet's files for good. Callers confirm with the user first. */
export async function removePet(id: string) {
  if (native) return void (await invoke("remove_pet", { id }));
  browserState.pets = browserState.pets.filter((p) => p.id !== id);
  browserState.drafts = browserState.drafts.filter((d) => d.petId !== id);
  delete browserState.custom[id];
  delete browserState.settings.behaviors[id];
  if (browserState.settings.activeId === id)
    browserState.settings.activeId = browserState.pets[0]?.id ?? null;
  notify();
}
export async function previewOnDesktop(preview: Preview) {
  if (native) await invoke("preview_on_desktop", { preview });
}
/** What the app received through its inbox (see docs/收件箱约定.md). */
export function inboxEvents(on: {
  pet: (arrival: { name: string; updated: boolean }) => void;
  draft: (summary: string) => void;
  failed: (error: string) => void;
}) {
  if (!native) return;
  listen<{ name: string; updated: boolean }>("pet-arrived", (e) =>
    on.pet(e.payload),
  );
  listen<string>("draft-arrived", (e) => on.draft(e.payload));
  listen<string>("draft-failed", (e) => on.failed(e.payload));
}
export async function idleSeconds(): Promise<number | null> {
  return native ? invoke("system_idle_seconds") : null;
}
export async function demo() {
  if (native) return invoke("import_example");
  const pet: Pet = {
    id: "lizi",
    displayName: "栗子",
    description: "一只温暖的原创橘白小猫，安静陪伴，也会好奇地四处走走。",
    spriteVersionNumber: 2,
    spritesheetPath: "spritesheet.webp",
    fingerprint: "demo",
    revision: "1",
  };
  if (!browserState.pets.some((p) => p.id === pet.id))
    browserState.pets.push(pet);
  browserState.settings.activeId = pet.id;
  notify();
}
export async function play(action: string) {
  if (native) await invoke("play_action", { action });
}
export async function showStudio() {
  if (native) await invoke("open_studio");
}
export async function quit() {
  if (native) await invoke("quit_app");
}
