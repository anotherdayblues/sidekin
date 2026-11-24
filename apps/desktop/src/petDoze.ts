// A few z's drifting up while the pet sleeps, drawn in code so every pet's
// sleep reads the same: only in the held, asleep part of a sleep clip, and
// just above the sleeping pose's own outline, so they never cover the pet.
import "./styles/pet-doze.css";

export interface Hold {
  action: string;
  on: boolean;
  /** The top of the pose's outline and the middle of its top, as shares. */
  top: { x: number; y: number } | null;
}

export function mountDoze(root: HTMLElement) {
  const el = document.createElement("div");
  el.className = "pet-doze";
  el.setAttribute("aria-hidden", "true");
  el.innerHTML = "<i></i><i></i><i></i>";
  root.append(el);
  root.addEventListener("pet-hold", (e) => {
    const { action, on, top } = (e as CustomEvent<Hold>).detail;
    const sleep = action === "sleep" || action === "@sleep";
    // Where the pose's top is: data, the one thing CSS cannot know.
    if (on && top) {
      el.style.setProperty("--doze-x", String(top.x));
      el.style.setProperty("--doze-y", String(top.y));
      // Near the right edge they drift to the left, to stay in the window.
      el.toggleAttribute("data-left", top.x > 0.7);
    }
    el.toggleAttribute("data-on", on && sleep);
  });
  return el;
}
