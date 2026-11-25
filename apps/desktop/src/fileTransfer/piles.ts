import { t } from "../i18n.ts";
import {
  ShelfStore,
  type ShelfItem,
  type ShelfState,
} from "./vendor/droper/shelfStore.ts";
import { call, native, on, type Rect, type Tracker } from "./bridge.ts";
import { dragPreview } from "./dragPreview.ts";
import {
  DEFAULT_GEOMETRY,
  expandedBounds,
  attachmentPositions,
  panelMaxHeight,
  PANEL,
  type Geometry,
} from "./pileLayout.ts";
import type { FileMeta } from "./fileTypes.ts";
import { fileMenu, sendToPhone } from "./fileMenu.ts";
import {
  buildPanel,
  buildPile,
  refreshSelection as refreshSelectionView,
  refreshTypes as refreshTypeViews,
  type ClickGuard,
  type Selection,
} from "./pileView.ts";
interface View {
  state: ShelfState;
  positions: Record<string, { x: number; y: number }>;
  layoutVersion?: number;
}
const empty: View = {
  state: { items: [], lastRemoved: [] },
  positions: {},
  layoutVersion: 2,
};

export async function mountPiles(root: HTMLElement) {
  document.body.classList.add("files-page");
  let view = (await call<View>("lab_load")) ?? structuredClone(empty);
  let positions = view.positions ?? {},
    expanded: string | null = null,
    dragging = false,
    save = Promise.resolve();
  const selection: Selection = { paths: new Set(), anchor: null };
  const click: ClickGuard = { suppress: null };
  let geometry =
    (await call<Geometry>("lab_geometry")) ?? structuredClone(DEFAULT_GEOMETRY);
  let panelPlacement: {
    id: string;
    x: number;
    y: number;
    width: number;
    height: number;
  } | null = null;
  let pressed = false,
    reflowPending = false;
  const notice = document.createElement("output");
  notice.className = "notice";
  notice.setAttribute("aria-live", "polite");
  const permCard = document.createElement("aside");
  permCard.className = "perm-card";
  permCard.setAttribute("role", "status");
  permCard.hidden = true;
  let permCardMode: "appDataDenied" | "appDataOff" | null = null;
  const cue = document.createElement("div");
  cue.className = "drop-cue";
  cue.hidden = true;
  cue.textContent = t("files.dropCue");
  const items = document.createElement("section");
  items.className = "piles";
  root.append(items, cue, notice, permCard);
  const store = new ShelfStore({
    persistence: {
      load: () => view.state,
      save: (s) => {
        view = { state: s, positions };
      },
    },
    exists: () => true,
  });
  const metadata = new Map<string, FileMeta>();
  const pendingMetadata = new Set<string>();
  async function describe() {
    const paths = store
      .items()
      .flatMap((i) => i.paths)
      .filter((p) => !metadata.has(p) && !pendingMetadata.has(p));
    if (!paths.length) return;
    paths.forEach((p) => pendingMetadata.add(p));
    const result = await call<FileMeta[]>("lab_describe", { paths }).finally(
      // Let a failed lookup be retried on the next render.
      () => paths.forEach((p) => pendingMetadata.delete(p)),
    );
    for (const m of result ?? []) metadata.set(m.path, m);
    if (result) refreshTypes();
  }
  let scheduled = false,
    noticeTimer: number;
  function placeNotice() {
    if (document.documentElement.dataset.petScene !== "true") return;
    if (!notice.textContent?.trim()) return;
    const pet = geometry.pet ?? DEFAULT_GEOMETRY.pet!;
    const w = notice.offsetWidth;
    const h = notice.offsetHeight;
    const minX = geometry.work.x + 12;
    const maxX = Math.max(minX, geometry.work.x + geometry.work.width - w - 12);
    const desiredX = geometry.origin.x + (pet.width - w) / 2;
    const x = Math.max(minX, Math.min(maxX, desiredX));
    const minY = geometry.work.y + 12;
    const maxY = Math.max(
      minY,
      geometry.work.y + geometry.work.height - h - 12,
    );
    const desiredY = geometry.origin.y + Math.max(0, pet.height - h - 4);
    const y = Math.max(minY, Math.min(maxY, desiredY));
    notice.style.left = Math.round(x) + "px";
    notice.style.top = Math.round(y) + "px";
    notice.style.bottom = "auto";
    notice.style.transform = "none";
  }
  function placePermCard() {
    if (permCard.hidden) return;
    const pet = geometry.pet ?? DEFAULT_GEOMETRY.pet!;
    const w = permCard.offsetWidth || 256;
    const h = permCard.offsetHeight || 110;
    const minX = geometry.work.x + 12;
    const maxX = Math.max(minX, geometry.work.x + geometry.work.width - w - 12);
    const desiredX = geometry.origin.x + (pet.width - w) / 2;
    const x = Math.max(minX, Math.min(maxX, desiredX));
    const minY = geometry.work.y + 12;
    const maxY = Math.max(
      minY,
      geometry.work.y + geometry.work.height - h - 12,
    );
    const above = geometry.origin.y - h - 8;
    const below = geometry.origin.y + pet.height + 8;
    const desiredY = above >= minY ? above : below;
    const y = Math.max(minY, Math.min(maxY, desiredY));
    permCard.style.left = Math.round(x) + "px";
    permCard.style.top = Math.round(y) + "px";
  }
  function hidePermCard() {
    if (permCard.hidden) return;
    permCard.hidden = true;
    permCardMode = null;
    permCard.replaceChildren();
    void regions();
  }
  function showPermCard(mode: "appDataDenied" | "appDataOff") {
    permCardMode = mode;
    const isOff = mode === "appDataOff";
    const head = document.createElement("div");
    head.className = "perm-card-head";
    const title = document.createElement("strong");
    title.textContent = t(
      isOff ? "files.permOffTitle" : "files.permDeniedTitle",
    );
    const closeBtn = document.createElement("button");
    closeBtn.type = "button";
    closeBtn.className = "perm-card-close";
    closeBtn.setAttribute("aria-label", t("common.close"));
    closeBtn.textContent = "×";
    closeBtn.onclick = hidePermCard;
    head.append(title, closeBtn);

    const desc = document.createElement("p");
    desc.className = "perm-card-body";
    desc.textContent = t(isOff ? "files.permOffBody" : "files.permDeniedBody");

    const foot = document.createElement("div");
    foot.className = "perm-card-foot";
    const act = document.createElement("button");
    act.type = "button";
    act.className = "perm-card-action";
    act.textContent = t(
      isOff ? "perm.openAppSettings" : "settings.openSystemSettings",
    );
    act.onclick = () => {
      if (isOff) {
        void call("open_companion_page", {
          history: false,
          section: "access",
        });
      } else {
        void call("open_permission_settings", { kind: "appData" });
      }
      hidePermCard();
    };
    foot.append(act);

    permCard.replaceChildren(head, desc, foot);
    permCard.hidden = false;
    placePermCard();
    void regions();
  }
  function say(text: string) {
    notice.textContent = text;
    placeNotice();
    placePermCard();
    void regions();
    clearTimeout(noticeTimer);
    noticeTimer = window.setTimeout(() => {
      notice.textContent = "";
      void regions();
    }, 2400);
  }
  async function regions() {
    const elements: HTMLElement[] = Array.from(
      items.querySelectorAll<HTMLElement>(
        ".pile-top,.file-panel,.remove,.count",
      ),
    );
    if (notice.textContent?.trim()) elements.push(notice);
    if (!permCard.hidden) elements.push(permCard);
    const rects = elements
      .map((e) => {
        const r = e.getBoundingClientRect();
        return { x: r.x, y: r.y, width: r.width, height: r.height };
      })
      .filter((r) => r.width > 0 && r.height > 0);
    // An open panel closes on a click anywhere else, so the host reads the
    // pointer quickly while it is open (tracker.rs).
    await call("lab_regions", {
      regions: rects,
      origin: geometry.origin,
      open: expanded !== null,
    });
  }
  function commit() {
    view = {
      state: view.state,
      positions,
      layoutVersion: 4,
    };
    const next = structuredClone(view);
    save = save
      .then(() => call<void>("lab_save", { view: next }))
      .catch(() => say(t("files.saveFailed")));
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    queueMicrotask(() => {
      scheduled = false;
      render();
      commit();
    });
  }
  store.onChange(schedule);
  function placePanel() {
    const panel = items.querySelector<HTMLElement>(".file-panel");
    const base = items.querySelector<HTMLElement>(".expanded>.pile-top");
    if (panel && base && expanded) {
      const anchor = base.getBoundingClientRect();
      panel.style.width = Math.min(PANEL.width, geometry.work.width) + "px";
      panel.style.maxHeight =
        Math.min(PANEL.height, geometry.work.height) + "px";
      if (!panelPlacement || panelPlacement.id !== expanded) {
        const cs = getComputedStyle(panel);
        const borderY =
          (parseFloat(cs.borderTopWidth) || 0) +
          (parseFloat(cs.borderBottomWidth) || 0);
        panelPlacement = {
          id: expanded,
          ...expandedBounds(anchor, geometry, {
            width: panel.offsetWidth,
            height: Math.min(
              Math.ceil(panel.scrollHeight + borderY),
              PANEL.height,
              geometry.work.height,
            ),
          }),
        };
      }
      panel.style.left = panelPlacement.x - anchor.x + "px";
      panel.style.top = panelPlacement.y - anchor.y + "px";
      panel.style.width = panelPlacement.width + "px";
      panel.style.maxHeight =
        panelMaxHeight(panelPlacement, geometry.work) + "px";
      panel.style.visibility = "visible";
    }
    void regions();
  }
  function removePaths(id: string, paths: string[]) {
    const current = store.items().find((i) => i.id === id);
    if (!current) return;
    const chosen = paths.filter((p) => current.paths.includes(p));
    if (!chosen.length) return;
    if (chosen.length === current.paths.length) {
      store.remove([id]);
      delete positions[id];
      if (expanded === id) {
        expanded = null;
        panelPlacement = null;
      }
    } else for (const path of chosen) store.removePath(id, path);
    for (const path of chosen) selection.paths.delete(path);
    // 手机传文件: files the phone sent may go to the trash; the host knows
    // which those are and leaves every other file alone (phone/mod.rs).
    void call("phone_discard", { paths: chosen }).catch(() => {});
    void call("lab_discard_staged", { paths: chosen }).catch(() => {});
    if (selection.anchor && chosen.includes(selection.anchor))
      selection.anchor = null;
    schedule();
  }
  async function drag(
    event: DragEvent | null,
    item: ShelfItem,
    paths: string[],
    held: () => boolean = () => true,
  ) {
    event?.preventDefault();
    if (dragging || !held()) return;
    // Claim before the first await, so preparation cannot queue a second session.
    dragging = true;
    document.body.dataset.dragging = "true";
    try {
      const valid = native
        ? await call<string[]>("lab_existing", { paths })
        : paths;
      if (!held()) return;
      if (valid.length !== paths.length) {
        say(t("files.moved"));
        return;
      }
      let result: string;
      if (native) {
        const icon = await call<string>("lab_preview", {
          bytes: await dragPreview(valid, metadata.get(valid[0])),
        });
        if (!held()) return;
        result = await call<string>("lab_drag", { paths: valid, icon });
      } else {
        (window as any).labLastDrag = paths;
        result = (window as any).labDragResult ?? "Cancel";
      }
      // Delivered files stay staged: the same files often go to several places.
      say(result === "Dropped" ? t("files.delivered") : t("files.stillHere"));
    } catch (e) {
      if (String(e).includes("file_unreadable")) {
        showPermCard("appDataDenied");
      } else {
        say(t("files.notSent"));
      }
      console.warn(e);
    } finally {
      dragging = false;
      delete document.body.dataset.dragging;
      if (reflowPending) {
        reflowPending = false;
        panelPlacement = null;
        queueMicrotask(placePanel);
      }
    }
  }
  function render() {
    if (!store.items().length) notice.textContent = "";
    items.replaceChildren();
    positions = attachmentPositions(
      store.items().map((i) => i.id),
      geometry,
    );
    for (const item of store.items()) {
      const p = positions[item.id];
      const remove = (paths: string[]) => removePaths(item.id, paths);
      const dragItem = (
        event: DragEvent | null,
        paths: string[],
        held?: () => boolean,
      ) => drag(event, item, paths, held);
      const send = (paths: string[]) => void sendToPhone(paths, say);
      const menu = (event: MouseEvent, paths: string[]) =>
        void fileMenu(event, paths, {
          send: () => send(paths),
          remove: () => remove(paths),
        }).catch(console.error);
      const group = buildPile(item, metadata, click, {
        toggle: () => {
          expanded = expanded === item.id ? null : item.id;
          panelPlacement = null;
          selection.paths.clear();
          selection.anchor = null;
          render();
        },
        drag: dragItem,
        remove,
        menu,
      });
      group.style.left = p.x + geometry.origin.x + "px";
      group.style.top = p.y + geometry.origin.y + "px";
      if (expanded === item.id) {
        group.classList.add("expanded");
        group.append(
          buildPanel(item, metadata, selection, click, {
            drag: dragItem,
            remove,
            refresh: refreshSelection,
            menu,
            send,
          }),
        );
      }
      items.append(group);
    }
    refreshSelection();
    void describe();
    queueMicrotask(placePanel);
  }
  function refreshTypes() {
    refreshTypeViews(items, store.items(), metadata);
  }
  function refreshSelection() {
    refreshSelectionView(items, selection.paths);
  }
  /** New files onto the pet: onto the pile nearest (x, y), else the first.
   * Owned ones (`snippet`) are 随伴's own, saved from the phone. */
  function receive(paths: string[], x: number, y: number, snippet = false) {
    const prior = store.items();
    const target =
      prior.find((i) => {
        const p = positions[i.id];
        return (
          p &&
          Math.hypot(
            x - geometry.origin.x - p.x - 32,
            y - geometry.origin.y - p.y - 32,
          ) < 80
        );
      }) ?? prior[0];
    const added = store.addPaths(paths, { snippet });
    // 上手引导: the pet has held a file (tips.rs).
    if (added.length && !snippet)
      void call("tips_used", { feature: "file-transfer" }).catch(() => {});
    if (!added.length) {
      say(t("files.already"));
      return null;
    }
    const ids = [...(target ? [target.id] : []), ...added.map((i) => i.id)];
    const group = ids.length > 1 ? store.mergeToStack(ids) : added[0];
    if (group) {
      const p = target ? positions[target.id] : { x: 0, y: 0 };
      positions[group.id] = p;
      for (const id of ids) if (id !== group.id) delete positions[id];
    }
    expanded = null;
    panelPlacement = null;
    selection.paths.clear();
    selection.anchor = null;
    schedule();
    return group?.id ?? null;
  }
  await on<{
    paths: string[];
    blocked?: number;
    blockedReason?: "appDataOff" | "appDataDenied" | null;
    x: number;
    y: number;
  }>("lab-drop", (e) => {
    if (e.paths.length) receive(e.paths, e.x, e.y);
    if ((e.blocked ?? 0) > 0) {
      showPermCard(
        e.blockedReason === "appDataOff" ? "appDataOff" : "appDataDenied",
      );
    }
  });
  await on<{ active: boolean; x: number; y: number }>("lab-hover", (e) => {
    cue.hidden = !e.active;
    cue.style.left =
      Math.max(10, Math.min(innerWidth - cue.offsetWidth - 10, e.x - 52)) +
      "px";
    cue.style.top = Math.max(8, e.y - 48) + "px";
  });
  await on<boolean>("lab-expand", (open) => {
    expanded = open ? (store.items()[0]?.id ?? null) : null;
    panelPlacement = null;
    selection.paths.clear();
    selection.anchor = null;
    render();
  });
  await on("lab-collapse", () => {
    if (expanded && !dragging) {
      expanded = null;
      panelPlacement = null;
      render();
    }
  });
  await on<Geometry>("lab-layout", (next) => {
    const previous = JSON.stringify(geometry);
    geometry = { ...geometry, ...next };
    if (previous === JSON.stringify(geometry)) return;
    positions = attachmentPositions(
      store.items().map((i) => i.id),
      geometry,
    );
    for (const group of items.querySelectorAll<HTMLElement>(".pile")) {
      const p = positions[group.dataset.id!];
      if (p) {
        group.style.left = p.x + geometry.origin.x + "px";
        group.style.top = p.y + geometry.origin.y + "px";
      }
    }
    placeNotice();
    placePermCard();
    void regions();
    if (pressed || dragging) reflowPending = true;
    else {
      panelPlacement = null;
      queueMicrotask(placePanel);
    }
  });
  await on<Tracker>("lab-pointer", (p) => {
    pressed = p.left;
    if (!p.left) {
      cue.hidden = true;
      delete document.body.dataset.filePressed;
    }
    if (!pressed && !dragging && reflowPending) {
      reflowPending = false;
      panelPlacement = null;
      queueMicrotask(placePanel);
    }
  });
  document.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a" && expanded) {
      e.preventDefault();
      selection.paths = new Set(
        store.items().find((i) => i.id === expanded)?.paths ?? [],
      );
      refreshSelection();
    }
    if (
      (e.key === "Delete" || e.key === "Backspace") &&
      expanded &&
      selection.paths.size
    ) {
      e.preventDefault();
      removePaths(expanded, Array.from(selection.paths));
    }
    if (e.key === "Escape") {
      if (permCardMode) {
        hidePermCard();
        return;
      }
      expanded = null;
      panelPlacement = null;
      selection.paths.clear();
      render();
    }
  });
  document.addEventListener("pointerdown", (e) => {
    if (!(e.target as HTMLElement).closest(".pile")) {
      expanded = null;
      panelPlacement = null;
      render();
    }
  });
  if (store.items().length > 1)
    store.mergeToStack(store.items().map((i) => i.id));
  render();
  // Read-only view for the browser checks, which also run the native path.
  (window as any).labView = {
    items: () => store.items(),
    positions: () => positions,
    flush: () => save,
  };
  return { receive };
}
