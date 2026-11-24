import { t } from "./i18n.ts";
import { native } from "./bridge.ts";
import { Motion } from "./spring.ts";
import { applySkin, type Skin } from "./skin.ts";

export type Block = "pet" | "memory" | "reminders" | "focus" | "settings";

export function mountStudioNavigation(
  app: HTMLElement,
  openCompanion: () => Promise<void>,
) {
  const reducedQuery = matchMedia("(prefers-reduced-motion: reduce)");
  // ---------- the five blocks ----------
  const BLOCKS: Block[] = ["pet", "memory", "reminders", "focus", "settings"];
  let block: Block = "pet";
  const blocksNav = app.querySelector<HTMLElement>("#blocks")!;
  const blocksKey = blocksNav.querySelector<HTMLElement>(".blocks-key")!;
  let keyAt = { x: 0, w: 0 };
  let keyFrom = { x: 0, w: 0 };
  const keyMotion = new Motion(
    0,
    (t) => {
      blocksKey.style.transform = `translateX(${keyFrom.x + (keyAt.x - keyFrom.x) * t}px)`;
      blocksKey.style.width = `${keyFrom.w + (keyAt.w - keyFrom.w) * t}px`;
    },
    { stiffness: 420, damping: 30 },
  );
  function placeKey(animate: boolean) {
    const on = blocksNav.querySelector<HTMLElement>(`[data-block="${block}"]`)!;
    const next = { x: on.offsetLeft, w: on.offsetWidth };
    keyFrom = animate && keyAt.w ? { ...current() } : next;
    keyAt = next;
    keyMotion.set(0);
    if (animate && !reducedQuery.matches) keyMotion.to(1);
    else keyMotion.set(1);
    function current() {
      const m = new DOMMatrixReadOnly(getComputedStyle(blocksKey).transform);
      return { x: m.m41, w: blocksKey.offsetWidth };
    }
  }
  function changeBlock(next: Block, animate = true, remember = true) {
    if (next !== block) {
      block = next;
      for (const b of blocksNav.querySelectorAll<HTMLElement>("[data-block]"))
        b.setAttribute("aria-selected", String(b.dataset.block === block));
      for (const panel of app.querySelectorAll<HTMLElement>(".block"))
        panel.hidden = panel.dataset.for !== block;
      const studio = app.querySelector<HTMLElement>(".studio")!;
      studio.dataset.block = block;
      // The native skin names the page in its toolbar.
      studio.dataset.title =
        blocksNav
          .querySelector<HTMLElement>(`[data-block="${block}"]`)
          ?.textContent?.trim() ?? "";
      if (native && remember)
        void import("@tauri-apps/api/core").then(({ invoke }) =>
          invoke("studio_remember_block", { block }).catch(() => {}),
        );
      if (block !== "pet") void openCompanion();
      placeKey(animate);
    }
  }
  blocksNav.onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>("[data-block]");
    if (b) changeBlock(b.dataset.block as Block);
  };
  // ⌘1–⌘5 jump to a block.
  addEventListener("keydown", (e) => {
    if (
      !(e.metaKey || e.ctrlKey) ||
      !/^[1-9]$/.test(e.key) ||
      Number(e.key) > BLOCKS.length
    )
      return;
    e.preventDefault();
    changeBlock(BLOCKS[Number(e.key) - 1]);
  });
  function openLibrary() {
    changeBlock("memory");
    app.dispatchEvent(new CustomEvent("memory-view", { detail: "library" }));
  }
  // Older names still arrive (tips, the host): 资料库 is
  // a part of 记忆 now, and chatting is the chat panel's (plan/29).
  function go(name: string) {
    if (name === "chat") {
      if (native)
        void import("@tauri-apps/api/core").then(({ invoke }) =>
          invoke("open_chat_window"),
        );
      return;
    }
    if (name === "library") {
      changeBlock("memory");
      return openLibrary();
    }
    if (BLOCKS.includes(name as Block)) changeBlock(name as Block);
  }
  app.addEventListener("show-block", (e) =>
    go((e as CustomEvent<string>).detail),
  );
  // The pet's right-click menu can open the studio on a given block.
  const readyListener = native
    ? import("@tauri-apps/api/event").then(({ listen }) =>
        listen<string>("studio-block", (e) => go(e.payload)),
      )
    : Promise.resolve();
  requestAnimationFrame(() => placeKey(false));
  addEventListener("resize", () => placeKey(false));
  addEventListener("focus", () => {
    if (!keyAt.w) placeKey(false);
  });

  async function restore() {
    await readyListener;
    if (!native) return;
    const saved = await import("@tauri-apps/api/core")
      .then(({ invoke }) => invoke<string | null>("studio_last_block"))
      .catch(() => null);
    if (saved && BLOCKS.includes(saved as Block))
      changeBlock(saved as Block, false, false);
  }

  async function updateSkin(skin: Skin, isCurrent: () => boolean) {
    await applySkin(skin);
    if (!isCurrent()) return false;
    return true;
  }
  return {
    placeKey,
    restore,
    updateSkin,
    select(next: Block) {
      if (BLOCKS.includes(next)) changeBlock(next);
    },
  };
}
