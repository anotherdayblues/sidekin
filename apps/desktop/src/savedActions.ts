import { invoke } from "@tauri-apps/api/core";
import * as api from "./bridge.ts";
import { ANIMATIONS } from "./animation.ts";
import type { CustomAction } from "./teaching.ts";
export interface SavedAction {
  id: string;
  name: string;
  action: CustomAction;
  createdAt: number;
  summary: string;
  used: boolean;
  original: boolean;
  current: boolean;
}
// Isolated browser previews use the same collection semantics, without app data.
const collections = new Map<string, SavedAction[]>();
const images = new Map<string, string>();
async function add(
  pet: string,
  name: string,
  action: CustomAction,
  source: string,
  used: boolean,
  summary = "",
  original = false,
) {
  const items = collections.get(pet)!;
  const bytes = new TextEncoder().encode(JSON.stringify({ name, action }));
  const hash = Array.from(
    new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    (b) => b.toString(16).padStart(2, "0"),
  )
    .join("")
    .slice(0, 24);
  const existing = items.find((i) => i.id === hash);
  if (existing) {
    existing.used ||= used;
    return;
  }
  items.push({
    id: hash,
    name,
    action: structuredClone(action),
    createdAt: original ? 0 : Date.now() / 1000,
    summary,
    used,
    original,
    current: false,
  });
  images.set(hash, source);
}
export async function savedActions(petId: string): Promise<SavedAction[]> {
  if (api.native) return invoke("saved_actions", { petId });
  const first = !collections.has(petId);
  if (first) {
    collections.set(petId, []);
    const img = new Image();
    img.src = await api.sprite(petId);
    await img.decode();
    for (const [name, a] of Object.entries(ANIMATIONS)) {
      const c = document.createElement("canvas");
      c.width = 192 * a.durations.length;
      c.height = 208;
      c.getContext("2d")!.drawImage(
        img,
        0,
        a.row * 208,
        c.width,
        208,
        0,
        0,
        c.width,
        208,
      );
      await add(
        petId,
        name,
        {
          label: a.label,
          image: `original:${name}`,
          durations: [...a.durations],
        },
        c.toDataURL(),
        true,
        "",
        true,
      );
    }
  }
  const s = api.browserSnapshot();
  const current = s.custom[petId];
  if (current) {
    for (const v of first ? current.history.versions : []) {
      const layer = await api.versionLayer(petId, v.version);
      for (const [name, a] of Object.entries(layer.actions))
        await add(
          petId,
          name,
          a,
          await api.actionImage(petId, name),
          true,
          v.summary,
        );
    }
    for (const [name, a] of Object.entries(current.layer.actions))
      await add(petId, name, a, await api.actionImage(petId, name), true);
  }
  for (const d of s.drafts.filter((d) => d.petId === petId))
    for (const name of d.addedActions) {
      const a = d.preview.actions[name];
      await add(
        petId,
        name,
        a,
        await api.actionImage(petId, name, d.id),
        false,
        d.summary,
      );
    }
  return collections
    .get(petId)!
    .map((i) => ({
      ...structuredClone(i),
      current: i.original
        ? !current?.layer.actions[i.name]
        : JSON.stringify(current?.layer.actions[i.name]) ===
          JSON.stringify(i.action),
    }))
    .sort((a, b) => b.createdAt - a.createdAt);
}
export async function savedActionImage(
  petId: string,
  id: string,
): Promise<string> {
  return api.native
    ? invoke("read_saved_action", { petId, id })
    : images.get(id)!;
}
export async function useSavedAction(petId: string, id: string) {
  if (api.native) return invoke<void>("use_saved_action", { petId, id });
  const item = (await savedActions(petId)).find((i) => i.id === id)!;
  if (item.current) return;
  const s = api.browserSnapshot();
  const custom = (s.custom[petId] ??= {
    history: { current: 0, versions: [] },
    layer: { actions: {}, rules: [] },
  });
  if (item.original) delete custom.layer.actions[item.name];
  else custom.layer.actions[item.name] = item.action;
  custom.history = { current: custom.history.current + 1, versions: [] };
  collections.get(petId)!.find((i) => i.id === id)!.used = true;
  api.setBrowserState(s);
}
export async function deleteSavedAction(petId: string, id: string) {
  if (api.native) return invoke<void>("delete_saved_action", { petId, id });
  const item = (await savedActions(petId)).find((i) => i.id === id)!;
  if (item.current) throw Error("In use");
  collections.set(
    petId,
    collections.get(petId)!.filter((i) => i.id !== id),
  );
  images.delete(id);
  // A deleted pending candidate must not return on the next refresh.
  const s = api.browserSnapshot();
  s.drafts = s.drafts.filter(
    (d) =>
      d.petId !== petId ||
      !d.addedActions.some(
        (n) =>
          n === item.name &&
          JSON.stringify(d.preview.actions[n]) === JSON.stringify(item.action),
      ),
  );
  api.setBrowserState(s);
}
export async function rememberBrowserDraft(id: string) {
  if (api.native) return;
  const draft = api.browserSnapshot().drafts.find((d) => d.id === id);
  if (draft) await savedActions(draft.petId);
}
