import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
export const native = isTauri();
/** Lists follow the host system's conventions; Linux uses the Windows ones. */
export const mac = /Mac/.test(navigator.platform || navigator.userAgent);
export async function call<T>(
  command: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (native) return invoke<T>(command, args);
  return (window as any).labInvoke?.(command, args);
}
export async function on<T>(event: string, handler: (value: T) => void) {
  if (native) return listen<T>(event, (e) => handler(e.payload));
  const h = (e: Event) => handler((e as CustomEvent<T>).detail);
  window.addEventListener(event, h);
  return () => window.removeEventListener(event, h);
}
export interface Tracker {
  x: number;
  y: number;
  petX: number;
  petY: number;
  left: boolean;
  external: boolean;
  near: boolean;
}
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
