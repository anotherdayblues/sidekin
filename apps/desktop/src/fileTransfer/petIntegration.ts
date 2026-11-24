import "./lab.css";
import { call, native, on } from "./bridge.ts";
import { watchWindowAppearance } from "../skin.ts";
import { mountPiles } from "./piles.ts";
import { mountPhoneArrivals } from "./phoneArrivals.ts";
import type { Geometry } from "./pileLayout.ts";
import type { PetShape } from "../animation.ts";
export async function mountPetScene(
  root: HTMLElement,
  mountPet: (root: HTMLElement) => Promise<void>,
) {
  document.documentElement.dataset.petScene = "true";
  // The file list wears the chosen skin and day/night colors too.
  if (native) await watchWindowAppearance();
  const pet = document.createElement("div");
  pet.className = "pet-surface";
  const files = document.createElement("div");
  files.className = "file-surface";
  root.replaceChildren(pet, files);
  function place(g: Geometry) {
    if (!g.pet) return;
    pet.style.left = g.origin.x + "px";
    pet.style.top = g.origin.y + "px";
    pet.style.width = g.pet.width + "px";
    pet.style.height = g.pet.height + "px";
  }
  const initial = await call<Geometry>("lab_geometry");
  place(
    initial ?? {
      origin: { x: 0, y: 0 },
      work: { x: 0, y: 0, width: innerWidth, height: innerHeight },
      pet: {
        width: innerWidth,
        height: innerHeight,
        body: { x: 0, y: 0, width: 1, height: 1 },
      },
    },
  );
  await on<Geometry>("lab-layout", place);
  pet.addEventListener("pet-shape", (e) => {
    const shape = (e as CustomEvent<PetShape | null>).detail;
    if (!shape) return;
    let l = shape.width,
      t = shape.height,
      r = 0,
      b = 0;
    const regions = [];
    for (let y = 0; y < shape.height; y++) {
      let start = -1;
      for (let x = 0; x <= shape.width; x++) {
        const inside =
          x < shape.width &&
          shape.hit((x + 0.5) / shape.width, (y + 0.5) / shape.height);
        if (inside) {
          l = Math.min(l, x);
          t = Math.min(t, y);
          r = Math.max(r, x + 1);
          b = Math.max(b, y + 1);
          if (start < 0) start = x;
        } else if (start >= 0) {
          regions.push({
            x: start / shape.width,
            y: y / shape.height,
            width: (x - start) / shape.width,
            height: 1 / shape.height,
          });
          start = -1;
        }
      }
    }
    if (r > l && b > t)
      void call("lab_pet_shape", {
        bounds: {
          x: l / shape.width,
          y: t / shape.height,
          width: (r - l) / shape.width,
          height: (b - t) / shape.height,
        },
        regions,
      });
  });
  await on<boolean>("file-transfer-drag", (active) => {
    document.documentElement.dataset.fileDragging = String(active);
  });
  await mountPet(pet);
  const piles = await mountPiles(files);
  await mountPhoneArrivals(files, pet, piles.receive);
}
