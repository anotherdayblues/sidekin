import { invoke } from "@tauri-apps/api/core";

// Coalesce motion events, but always finish one drop before moving the next pet drag.
// The promise returned resolves once every move asked so far has been made.
export function petDragPosition() {
  type Move = { grabX: number; grabY: number; release: boolean };
  const pending: Move[] = [];
  let sending: Promise<void> | null = null;
  async function send() {
    try {
      while (pending.length) {
        const move = pending.shift()!;
        await invoke("drag_pet", move).catch(console.warn);
      }
    } finally {
      sending = null;
    }
  }
  return (grabX: number, grabY: number, release: boolean) => {
    if (pending.length && !pending[pending.length - 1].release) pending.pop();
    pending.push({ grabX, grabY, release });
    sending ??= send();
    return sending;
  };
}
