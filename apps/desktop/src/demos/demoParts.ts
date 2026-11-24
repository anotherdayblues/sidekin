// Pieces the demos share: the fake document window, keycaps, the pet with
// its real bubble markup, and the cues that drive them.
import { t } from "../i18n.ts";
import { glyphs } from "../icons.ts";
import { typeIn, words, type Cue, type Scene } from "./demoTypes.ts";

/** A document window; `inner` is its content. */
export const docWindow = (inner: string) =>
  `<div class="demo-window" data-part="window"><i class="demo-titlebar"></i>${inner}</div>`;

/** A sentence whose words can be selected one by one. */
export const selectable = (text: string) =>
  `<p class="demo-doc">${words(text)
    .map((w) => `<span data-word>${w}</span>`)
    .join("")}</p>`;

/** Keycaps in the corner, parts key0, key1, … */
export const keycaps = (labels: string[]) =>
  `<div class="demo-keys" data-part="keys">${labels
    .map((k, i) => `<kbd data-part="key${i}">${k}</kbd>`)
    .join("")}</div>`;

/** Bubble pieces, in the order the real bubble stacks them. */
export const piece = {
  dots: `<div class="bubble-dots"><i></i><i></i><i></i></div>`,
  mine: `<p class="bubble-mine" data-part="mine"></p>`,
  text: `<div class="bubble-text" data-part="text"></div>`,
  remembered: () =>
    `<small data-remembered data-part="remembered"><span>${t("bubble.remembered")}</span><button type="button" tabindex="-1">${t("common.undo")}</button></small>`,
  compose: (placeholder = t("chat.placeholder")) =>
    `<div class="bubble-compose"><p class="demo-field" data-placeholder="${placeholder}"><span data-part="draft"></span><i class="demo-caret"></i></p><button type="button" tabindex="-1" data-send>${glyphs.arrow}</button></div>`,
  copy: () =>
    `<footer><button type="button" tabindex="-1" data-part="copy">${t("common.copy")}</button></footer>`,
};

/** The pet in the corner, with no bubble. */
export const barePet = () => `<div class="demo-pet" data-part="pet"></div>`;

/** A plain AI assistant's chat window: no real product, just the idea. */
export const aiWindow = () =>
  `<div class="demo-ai" data-part="ai"><i class="demo-titlebar"></i><b>${t("demo.ai.title")}</b>
    <div class="demo-ai-body">
      <p class="demo-ai-mine" data-part="ai-mine"><span class="demo-chip" data-part="ai-pasted">${t("demo.ai.pasted")}</span><span data-part="ai-said"></span></p>
      <p class="demo-ai-theirs" data-part="ai-theirs"></p>
      <i class="demo-ai-progress" data-part="ai-progress"></i>
    </div>
    <p class="demo-field demo-ai-input" data-part="ai-input"><span class="demo-chip demo-ai-chip">${t("demo.ai.pasted")}</span><span data-part="ai-draft"></span><i class="demo-caret"></i></p>
  </div>`;

/** Paste the copied note into the AI window, type `ask`, send, and wait
 * for `working` then `done`; returns when it is done. */
export function askAI(at: At, ask: string, working: string, done: string, from: number) {
  at(from, (s) => {
    s.part("ai").dataset.show = "";
    s.pointAt(s.part("ai-input"), "middle");
  });
  at(from + 700, (s) => {
    click(s);
    s.part("ai-input").dataset.pasted = "";
  });
  const ms = 1000 / 12;
  for (const cue of typeIn("ai-draft", ask, from + 1000, ms)) at(cue.at, cue.run);
  const sent = from + 1000 + [...ask].length * ms + 300;
  at(sent, (s) => {
    s.part("ai-draft").textContent = "";
    delete s.part("ai-input").dataset.pasted;
    s.part("ai-said").textContent = ask;
    s.part("ai-mine").dataset.show = "";
  });
  at(sent + 400, (s) => {
    s.part("ai-theirs").textContent = working;
    s.part("ai-theirs").dataset.show = "";
    s.part("ai-progress").dataset.show = "";
  });
  const finished = sent + 2000;
  at(finished, (s) => {
    s.part("ai-theirs").textContent = done;
    s.part("ai-progress").dataset.done = "";
  });
  return finished;
}

/** A file being dragged: it follows the pointer while shown. */
export const ghost = () => `<span class="demo-ghost" data-part="ghost"></span>`;

/** The pet in the corner with its bubble above, hidden until shown. */
export const petWithBubble = (body: string, mode: "chat" | "" = "") =>
  `<div class="demo-pet" data-part="pet">
    <section class="bubble-shell" data-side="above" data-part="bubble">
      <article class="bubble-card" data-part="card" data-state="input" ${mode ? `data-mode="${mode}"` : ""}>
        <header><span>${t("app.name")}</span></header>${body}<i class="bubble-tail"></i>
      </article>
    </section>
  </div>`;

type At = (time: number, run: Cue["run"]) => void;

/** Collects cues: `at(ms, scene => …)`. */
export function timeline() {
  const cues: Cue[] = [];
  const at: At = (time, run) => void cues.push({ at: time, run });
  return { cues, at };
}

/** Drag the I-beam across the sentence between `from` and `to`. */
export function selectSentence(at: At, text: string, from: number, to: number) {
  at(from - 250, (s) => {
    s.pointAt(s.desk.querySelector<HTMLElement>("[data-word]")!, "start");
    s.part("pointer").dataset.show = "";
    s.pet.setGaze({ x: -1, y: -0.4 });
  });
  at(from, (s) => (s.part("pointer").dataset.drag = ""));
  const n = words(text).length;
  for (let i = 0; i < n; i++)
    at(from + ((i + 1) * (to - from)) / n, (s) => {
      const word = s.desk.querySelectorAll<HTMLElement>("[data-word]")[i];
      word.dataset.on = "";
      s.pointAt(word);
    });
}

/** Show the keycaps, press them in turn, hold, and let go. */
export function pressKeys(at: At, count: number, from: number, gap = 180, hold = 350) {
  at(from - 250, (s) => (s.part("keys").dataset.show = ""));
  for (let i = 0; i < count; i++) at(from + i * gap, (s) => s.part(`key${i}`).toggleAttribute("data-down", true));
  const up = from + (count - 1) * gap + hold;
  for (let i = 0; i < count; i++) at(up, (s) => s.part(`key${i}`).removeAttribute("data-down"));
  return up;
}

/** Dim the keycaps once they have done their job. */
export const keysDone = (s: Scene) => (s.part("keys").dataset.done = "");

/** The pet notices: a small hop. */
export const hop = (s: Scene) => {
  const pet = s.part("pet");
  delete pet.dataset.hop;
  void pet.offsetWidth; // restart the animation
  pet.dataset.hop = "";
};

/** A click where the pointer is: a ring spreads out. */
export const click = (s: Scene) => {
  const ring = s.part("click");
  delete ring.dataset.show;
  void ring.offsetWidth; // restart the animation
  ring.dataset.show = "";
};

/** The bubble shows in `state`. */
export const bubbleState = (s: Scene, state: string) => {
  s.part("bubble").dataset.show = "";
  s.part("card").dataset.state = state;
};

/** Type `text` into the bubble's field, then send it as the user's line. */
export function typeAndSend(at: At, text: string, from: number, cps = 14) {
  const ms = 1000 / cps,
    sent = from + [...text].length * ms + 350;
  for (const cue of typeIn("draft", text, from, ms)) at(cue.at, cue.run);
  at(sent, (s) => {
    s.part("draft").textContent = "";
    s.part("mine").textContent = text;
    s.part("card").dataset.state = "thinking";
    s.pet.play("running", false);
  });
  return sent;
}

/** The pet's answer, typed in from `from` over `ms`. */
export function answer(at: At, text: string, from: number, ms = 1200) {
  at(from, (s) => {
    s.part("card").dataset.state = "answer";
    s.pet.play("idle");
  });
  for (const cue of typeIn("text", text, from, ms / [...text].length)) at(cue.at, cue.run);
  return from + ms;
}

/** The studio's "copy this for your AI" card: a few lines and 复制. */
export const copyCard = () =>
  `<div class="demo-pop" data-part="pop"><i></i><i></i><i></i><button type="button" tabindex="-1" data-part="copy-btn">${t("common.copy")}</button></div>`;

/** Click the copy card's button; it says 已复制. */
export function copyNote(at: At, from: number) {
  at(from, (s) => s.pointAt(s.part("copy-btn"), "middle"));
  at(from + 400, (s) => {
    click(s);
    s.part("copy-btn").textContent = t("common.copied");
    s.part("copy-btn").dataset.done = "";
  });
  return from + 400;
}

/** Point at part `name`, then click it. */
export function pointAndClick(at: At, name: string, from: number, run?: (s: Scene) => void) {
  at(from, (s) => {
    const pointer = s.part("pointer");
    pointer.dataset.shape = "arrow";
    pointer.dataset.show = "";
    s.pointAt(s.part(name), "middle");
  });
  at(from + 600, (s) => {
    click(s);
    run?.(s);
  });
  return from + 600;
}
