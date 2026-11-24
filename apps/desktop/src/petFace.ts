// A pet's face for small places: the chat panel's header and its topics
// (plan/29). The first frame of its sheet, drawn once and kept.
import { invoke } from "@tauri-apps/api/core";
import * as api from "./bridge.ts";

/** One frame of a pet's sheet. */
export const CELL_W = 192,
  CELL_H = 208;

/** First-cell source for avatars; an unavailable cache uses the original sheet. */
export async function thumbnailImage(id: string): Promise<HTMLImageElement> {
  const img = new Image();
  if (api.native) {
    try {
      img.src = await invoke<string>("read_pet_thumbnail", { id });
      await img.decode();
      return img;
    } catch {
      // A missing or unreadable cache must never hide a pet.
    }
  }
  img.src = await api.sprite(id);
  await img.decode();
  return img;
}

const faces = new Map<string, Promise<string>>();

/** The pet's first frame as a picture; "" when it cannot be read. */
export function petFace(id: string): Promise<string> {
  let face = faces.get(id);
  if (!face) {
    face = thumbnailImage(id)
      .then((img) => {
        const c = document.createElement("canvas");
        c.width = CELL_W / 2;
        c.height = CELL_H / 2;
        c.getContext("2d")!.drawImage(
          img,
          0,
          0,
          CELL_W,
          CELL_H,
          0,
          0,
          c.width,
          c.height,
        );
        return c.toDataURL();
      })
      .catch(() => "");
    faces.set(id, face);
  }
  return face;
}
