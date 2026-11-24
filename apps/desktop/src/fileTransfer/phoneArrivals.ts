// 手机传文件 on the pet (plan/20): each file the phone sends drops in from
// above the pet, arcs down and is swallowed by the pile, which gulps; the
// file is then on the pile like any other, with a small phone mark. The
// flight's path is geometry measured here; its look and timing are in
// phone.css.
import "./phone.css";
import { on } from "./bridge.ts";

const STAGGER_MS = 140;

export async function mountPhoneArrivals(
  layer: HTMLElement,
  pet: HTMLElement,
  receive: (
    paths: string[],
    x: number,
    y: number,
    snippet?: boolean,
  ) => string | null,
) {
  let queued = 0;
  await on<{ path: string; text: boolean }>("phone-arrived", (e) => {
    const box = layer.getBoundingClientRect();
    const id = receive([e.path], box.right, box.top, true);
    if (!id) return;
    const delay = queued++ * STAGGER_MS;
    window.setTimeout(() => {
      queued = Math.max(0, queued - 1);
      // After the pile is drawn with the new file.
      requestAnimationFrame(() => fly(layer, pet, id, e.path, e.text));
    }, delay);
  });
}

function fly(
  layer: HTMLElement,
  pet: HTMLElement,
  id: string,
  path: string,
  text: boolean,
) {
  const pile = layer.querySelector<HTMLElement>(
    `.pile[data-id="${CSS.escape(id)}"]`,
  );
  const target = pile
    ?.querySelector<HTMLElement>(".pile-top")
    ?.getBoundingClientRect();
  if (!pile || !target) return;
  const from = pet.getBoundingClientRect();
  const card = document.createElement("div");
  card.className = "phone-fly";
  card.dataset.kind = text ? "text" : "file";
  card.dataset.ext = text
    ? ""
    : (path.split(/[\\/]/).pop()?.split(".").slice(1).pop() ?? "")
        .slice(0, 4)
        .toUpperCase();
  layer.append(card);
  // From just above the pet's middle, up and over, down into the pile.
  const start = { x: from.left + from.width / 2 - 20, y: from.top - 56 };
  const end = {
    x: target.left + target.width / 2 - 20,
    y: target.top + target.height / 2 - 24,
  };
  const peak = { x: (start.x + end.x) / 2, y: Math.min(start.y, end.y) - 34 };
  const ms =
    parseFloat(getComputedStyle(card).getPropertyValue("--phone-fly-ms")) ||
    760;
  const at = (p: { x: number; y: number }, scale: number, turn: number) =>
    `translate(${p.x}px, ${p.y}px) scale(${scale}) rotate(${turn}deg)`;
  if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
    card.remove();
    return gulp(pile);
  }
  card
    .animate(
      [
        { transform: at(start, 0.4, -14), opacity: 0 },
        { transform: at(peak, 1.05, 8), opacity: 1, offset: 0.45 },
        { transform: at(end, 0.32, 0), opacity: 0.4 },
      ],
      {
        duration: ms,
        easing: "cubic-bezier(0.33, 0.8, 0.4, 1)",
        fill: "forwards",
      },
    )
    .finished.then(() => {
      card.remove();
      gulp(pile);
    });
}

/** The pile swallows: a squash and a little ring. */
function gulp(pile: HTMLElement) {
  delete pile.dataset.gulp;
  requestAnimationFrame(() => (pile.dataset.gulp = ""));
  window.setTimeout(() => delete pile.dataset.gulp, 700);
}
