// Code-drawn demos of what the pet can do (plan/17 3.5, 3.7). A demo is a
// little fake desktop and a timeline of cues; the cues only set data-*
// attributes, text and the pet's action, and demo.css animates the rest.
// With reduced motion the same timeline is frozen at a few moments instead.
import "../bubble.css";
import "../bubbleChat.css";
import "../styles/demo.css";
import { t } from "../i18n.ts";
import { SpritePlayer } from "../player.ts";
import { demoContext, type Cue, type Demo, type DemoContext, type DemoOptions, type Scene } from "./demoTypes.ts";

const FADE_MS = 600;

function buildScene(stage: HTMLElement, demo: Demo, c: DemoContext, canvas: HTMLCanvasElement, pet: SpritePlayer): Scene {
  const desk = stage.querySelector<HTMLElement>(".demo-desk")!;
  desk.removeAttribute("style");
  desk.innerHTML =
    demo.markup(c) + `<i class="demo-pointer" data-part="pointer"></i><i class="demo-click" data-part="click"></i>`;
  desk.querySelector("[data-part=pet]")!.prepend(canvas);
  const part = (name: string) => desk.querySelector<HTMLElement>(`[data-part="${name}"]`)!;
  const offset = (el: HTMLElement) => {
    let x = 0,
      y = 0;
    for (let n: HTMLElement | null = el; n && n !== desk; n = n.offsetParent as HTMLElement | null)
      (x += n.offsetLeft), (y += n.offsetTop);
    return { x, y };
  };
  // Measured geometry is the one thing CSS cannot know.
  return {
    desk,
    pet,
    part,
    pointAt(el, side = "end", down = 0.55) {
      const { x, y } = offset(el),
        dx = { start: 0, end: el.offsetWidth, middle: el.offsetWidth / 2 }[side];
      // On the desk, so the pointer and its click ring share them.
      desk.style.setProperty("--px", `${x + dx}px`);
      desk.style.setProperty("--py", `${y + el.offsetHeight * down}px`);
    },
    box(name, el) {
      const { x, y } = offset(el),
        target = part(name);
      target.style.setProperty("--bx", `${x}px`);
      target.style.setProperty("--by", `${y}px`);
      target.style.setProperty("--bw", `${el.offsetWidth}px`);
      target.style.setProperty("--bh", `${el.offsetHeight}px`);
    },
  };
}

function frame(demo: Demo) {
  const stage = document.createElement("figure");
  stage.className = "demo";
  stage.dataset.demo = demo.id;
  stage.innerHTML = `<div class="demo-desk" aria-hidden="true"></div>`;
  return stage;
}

function captionList(demo: Demo, c: DemoContext) {
  const list = document.createElement("ol");
  list.className = "demo-captions";
  list.innerHTML = demo
    .captions(c)
    .map((line) => `<li data-at="${line.at}">${line.text}</li>`)
    .join("");
  return list;
}

function light(list: HTMLElement, time: number) {
  for (const li of list.children)
    li.toggleAttribute("data-lit", time >= Number((li as HTMLElement).dataset.at));
}

/** One frozen moment of the demo, for reduced motion. */
async function still(demo: Demo, c: DemoContext, sprite: string, time: number, index: number) {
  const stage = frame(demo);
  stage.dataset.still = "";
  const canvas = document.createElement("canvas"),
    pet = new SpritePlayer(canvas);
  pet.setReducedMotion(true);
  const caption = document.createElement("figcaption");
  // The caption that is lit at this moment.
  caption.textContent = `${index + 1}. ${
    demo
      .captions(c)
      .reverse()
      .find((line) => line.at <= time)?.text ?? ""
  }`;
  stage.append(caption);
  await pet.load(sprite);
  return {
    stage,
    pet,
    show() {
      const scene = buildScene(stage, demo, c, canvas, pet);
      for (const cue of demo.cues(c).sort((a, b) => a.at - b.at)) if (cue.at <= time) cue.run(scene);
    },
  };
}

/**
 * Plays `demo` in `host` with the user's pet, looping until destroyed.
 * Returns a handle to stop it when the host goes away.
 */
export async function mountDemo(host: HTMLElement, demo: Demo, o: DemoOptions) {
  const c = demoContext(o.shortcuts);
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  host.replaceChildren();
  if (reduced) {
    const row = document.createElement("div");
    row.className = "demo-stills";
    host.append(row);
    const stills = await Promise.all(demo.stills.map((time, i) => still(demo, c, demo.examplePet ? o.example : o.sprite, time, i)));
    for (const s of stills) row.append(s.stage);
    for (const s of stills) s.show();
    return {
      destroy() {
        for (const s of stills) s.pet.setActive(false);
        host.replaceChildren();
      },
    };
  }

  const stage = frame(demo),
    canvas = document.createElement("canvas"),
    pet = new SpritePlayer(canvas),
    captions = captionList(demo, c),
    toggle = document.createElement("button");
  toggle.type = "button";
  toggle.className = "demo-toggle";
  stage.append(toggle);
  host.append(stage, captions);
  await pet.load(demo.examplePet ? o.example : o.sprite);

  let scene: Scene,
    cues: Cue[] = [],
    next = 0,
    clock = 0,
    last = 0,
    raf = 0,
    paused = false,
    visible = true,
    alive = true;
  const restart = () => {
    scene = buildScene(stage, demo, c, canvas, pet);
    delete stage.dataset.fading;
    pet.setGaze(null);
    pet.play("idle");
    cues = demo.cues(c).sort((a, b) => a.at - b.at);
    next = 0;
    clock = 0;
  };
  const tick = (now: number) => {
    raf = 0;
    if (!alive || paused || !visible) return;
    clock += Math.min(now - (last || now), 100);
    last = now;
    while (next < cues.length && cues[next].at <= clock) cues[next++].run(scene);
    light(captions, clock);
    if (clock >= demo.length - FADE_MS) stage.dataset.fading = "";
    if (clock >= demo.length) restart();
    raf = requestAnimationFrame(tick);
  };
  const run = () => {
    const going = !paused && visible && alive;
    stage.toggleAttribute("data-paused", paused);
    toggle.dataset.state = paused ? "paused" : "playing";
    toggle.setAttribute("aria-label", paused ? t("demo.play") : t("demo.pause"));
    pet.setActive(going);
    last = 0;
    if (going && !raf) raf = requestAnimationFrame(tick);
  };
  toggle.onclick = () => ((paused = !paused), run());
  // Off screen, a demo costs nothing.
  const seen = new IntersectionObserver(([e]) => ((visible = e.isIntersecting), run()));
  seen.observe(stage);
  restart();
  run();
  return {
    destroy() {
      alive = false;
      seen.disconnect();
      cancelAnimationFrame(raf);
      pet.setActive(false);
      host.replaceChildren();
    },
  };
}
