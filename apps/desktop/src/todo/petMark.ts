// The pet's face as the mark of what 伙伴大脑 does in 待办 (plan/31), in
// place of a sparkle: the one on the desk is the one helping.
import { state } from "../bridge.ts";
import { petFace } from "../petFace.ts";

/** A small face, filled in once the active pet's face is drawn. */
export function petMark() {
  const img = document.createElement("img");
  img.className = "todo-pet-mark";
  img.alt = "";
  img.hidden = true;
  void state()
    .then((s) => (s.settings.activeId ? petFace(s.settings.activeId) : ""))
    .then((url) => {
      if (!url) return;
      img.src = url;
      img.hidden = false;
    })
    .catch(() => {});
  return img;
}
