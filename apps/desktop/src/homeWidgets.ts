// The pet page's side column as cards (plan/35): 今天的待办, 今天的专注,
// 它最近记住的, 上次聊到. Each card is drawn like the settings group on the
// left: its title and one number above, then rows, then at most one key
// to go on. One size for each. 卡片 at the top opens a short list: drag ⋮⋮
// (or ↑ ↓) to change the order, a switch to show or hide. The choice is
// one for all pets, saved with the app settings.
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import type { StudioContext } from "./studioContext.ts";
import type { Block } from "./studioNavigation.ts";
import { t, tn, type Key } from "./i18n.ts";
import {
  clock,
  focusCommand,
  focusState,
  onFocus,
  progress,
  timeLeft,
  type FocusState,
} from "./focus.ts";
import { todos } from "./todo/api.ts";
import { petFace } from "./petFace.ts";
import { topicTime } from "./chatTopics.ts";
import type { Topic } from "./chatBackend.ts";
import { mountTodayNote } from "./todo/note.ts";
import {
  NEEDS_BRAIN,
  cardList,
  moved,
  shownCards,
  type WidgetId,
} from "./homeWidgetList.ts";
import "./styles/home-widgets.css";

/** How many things it remembered the card shows. */
const MEMORY_LINES = 2;

// Outside the app (previews, screenshots): sample lines.
const PREVIEW_MEMORY = [
  "喝咖啡不加糖。",
  "在准备 12 月去大阪的旅行。",
  "周三下午固定开组会，开完会比较累。",
];
const PREVIEW_TOPICS: Topic[] = [
  {
    id: 3,
    title: "大阪三天怎么排",
    lastAt: Date.now() - 864e5,
    turns: 8,
    pet: "lizi",
  },
];

const el = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls = "",
  text = "",
) => {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text) n.textContent = text;
  return n;
};
const button = (cls: string, text: string, onclick: () => void) => {
  const b = el("button", cls, text);
  b.type = "button";
  b.onclick = onclick;
  return b;
};
/** The one key at the foot of a card, drawn like 性格 › on the left. */
const act = (text: string, onclick: () => void) =>
  button("hc-act", text, onclick);
const nameOf = (id: WidgetId) => t(`home.w.${id}` as Key);

interface CardView {
  /** What goes inside the card. */
  body: HTMLElement;
  /** The number or time beside the title. */
  meta: HTMLElement;
  /** A small key at the end of the title row, for the one card that has one. */
  tool?: HTMLElement;
  refresh(): void;
}

export function mountHomeWidgets(
  c: StudioContext,
  o: { go(block: Block): void },
) {
  const side = c.app.querySelector<HTMLElement>(".block-pet .side")!;
  const list = side.querySelector<HTMLElement>("#widgets")!;
  const key = side.querySelector<HTMLButtonElement>("#cards-key")!;

  let shown: WidgetId[] = shownCards(c.state.snapshot.settings.homeCards);
  // 伙伴大脑 on, and its memory on; outside the app, both.
  let brain = { enabled: !native, memory: !native };
  const shows = (id: WidgetId) =>
    !NEEDS_BRAIN.includes(id) ||
    (brain.enabled && (id !== "memory" || brain.memory));

  const todayMeta = el("span", "hc-meta");
  const todayBody = el("div", "today-note-slot");
  const note = mountTodayNote(todayBody, todayMeta);
  const add = button("hc-tool hc-add", "", () => void note.write());
  add.setAttribute("aria-label", t("home.todoAdd"));
  add.title = t("home.todoAdd");
  const cards: Record<WidgetId, CardView> = {
    today: { body: todayBody, meta: todayMeta, tool: add, refresh() {} },
    focus: focusCard(() => o.go("focus")),
    memory: memoryCard(() => o.go("memory")),
    chats: chatsCard(),
  };
  const wrappers = new Map<WidgetId, HTMLElement>();
  const wrapper = (id: WidgetId) => {
    let w = wrappers.get(id);
    if (w) return w;
    w = el("section", "widget");
    w.dataset.widget = id;
    const label = el("header", "hc-label");
    const title = el("h3", "hc-title", nameOf(id));
    title.id = `hc-${id}`;
    w.setAttribute("aria-labelledby", title.id);
    label.append(title, cards[id].meta);
    if (cards[id].tool) label.append(cards[id].tool!);
    const group = el("div", "hc-group");
    group.append(cards[id].body);
    w.append(label, group);
    wrappers.set(id, w);
    // A card shown later reads its data when it first shows.
    cards[id].refresh();
    return w;
  };

  function render() {
    list.replaceChildren(...shown.filter(shows).map(wrapper));
  }
  async function change(next: WidgetId[]) {
    shown = next;
    render();
    await c.save({ homeCards: shown.map((id) => ({ id })) });
  }

  // 卡片: the list under the key. Hidden ones keep the place they were
  // given while the list is open; saved, they go to the end.
  let pop: HTMLElement | null = null;
  let rows = cardList(shown);
  function closeList() {
    pop?.remove();
    pop = null;
    key.setAttribute("aria-expanded", "false");
  }
  function drawList() {
    if (!pop) return;
    const ul = pop.querySelector("ul")!;
    ul.replaceChildren(
      ...rows
        .filter((r) => shows(r.id))
        .map((r) => {
          const li = el("li", "cards-row");
          li.dataset.widget = r.id;
          const name = nameOf(r.id);
          const grip = el("button", "cards-grip");
          grip.type = "button";
          grip.setAttribute("aria-label", t("home.move", { name }));
          grip.onkeydown = (e) => {
            const step =
              e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
            if (!step) return;
            e.preventDefault();
            void commit(moved(rows, r.id, step)).then(() =>
              pop
                ?.querySelector<HTMLElement>(
                  `[data-widget="${r.id}"] .cards-grip`,
                )
                ?.focus(),
            );
          };
          const label = el("label", "cards-name");
          const sw = el("input", "cards-switch");
          sw.type = "checkbox";
          sw.setAttribute("role", "switch");
          sw.checked = r.on;
          sw.onchange = () =>
            void commit(
              rows.map((x) => (x.id === r.id ? { ...x, on: sw.checked } : x)),
            );
          label.append(el("span", "", name), sw);
          li.append(grip, label);
          li.toggleAttribute("data-off", !r.on);
          return li;
        }),
    );
  }
  async function commit(next: typeof rows) {
    rows = next;
    drawList();
    // Hidden ones (伙伴大脑 off) keep their place in what is saved.
    await change(rows.filter((r) => r.on).map((r) => r.id));
  }
  key.onclick = () => {
    if (pop) return closeList();
    rows = cardList(shown);
    pop = el("div", "cards-pop");
    pop.setAttribute("role", "dialog");
    pop.setAttribute("aria-label", t("home.cardsTitle"));
    pop.append(
      el("p", "cards-pop-head", t("home.cardsTitle")),
      el("ul", "cards-rows"),
      el("p", "cards-pop-hint", t("home.cardsHint")),
    );
    side.append(pop);
    drawList();
    key.setAttribute("aria-expanded", "true");
  };
  addEventListener("pointerdown", (e) => {
    const at = e.target as Node;
    if (pop && !pop.contains(at) && !key.contains(at)) closeList();
  });
  addEventListener("keydown", (e) => {
    if (e.key === "Escape" && pop) {
      closeList();
      key.focus();
    }
  });

  // Dragging a row by ⋮⋮. Listened on the window: moving a row in the list
  // drops a pointer capture.
  side.addEventListener("pointerdown", (e) => {
    const grip = (e.target as HTMLElement).closest<HTMLElement>(".cards-grip");
    if (!grip || !pop || e.button !== 0) return;
    const li = grip.closest<HTMLElement>(".cards-row")!;
    const ul = li.parentElement!;
    e.preventDefault();
    const grab = e.clientY - li.getBoundingClientRect().top;
    li.dataset.dragging = "";
    const move = (m: PointerEvent) => {
      li.style.transform = "";
      const others = [...ul.children].filter((x) => x !== li);
      const below = others.find((x) => {
        const r = x.getBoundingClientRect();
        return m.clientY < r.top + r.height / 2;
      });
      if (below ? li.nextElementSibling !== below : ul.lastElementChild !== li)
        ul.insertBefore(li, below ?? null);
      li.style.transform = `translateY(${m.clientY - grab - li.getBoundingClientRect().top}px)`;
    };
    const up = () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
      li.style.transform = "";
      delete li.dataset.dragging;
      const order = [...ul.children].map(
        (x) => (x as HTMLElement).dataset.widget as WidgetId,
      );
      // Ones not in the list now (伙伴大脑 off) keep their place after.
      const next = [
        ...order.map((id) => rows.find((r) => r.id === id)!),
        ...rows.filter((r) => !order.includes(r.id)),
      ];
      if (next.some((r, i) => r !== rows[i])) void commit(next);
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
  });

  async function refreshBrain() {
    if (native)
      brain = await invoke<{ enabled: boolean; memory: boolean }>(
        "companion_settings",
      ).catch(() => brain);
    const fresh = shown.filter((id) => shows(id) && wrappers.has(id));
    render();
    drawList();
    // New ones read theirs as they are made; the others read again.
    for (const id of fresh) cards[id].refresh();
  }
  void refreshBrain();
  if (native)
    void import("@tauri-apps/api/event").then(({ listen }) =>
      listen("companion-settings", () => void refreshBrain()),
    );
  // What it remembered and the chats change elsewhere: read again when the
  // window comes back.
  addEventListener("focus", () => {
    for (const id of ["memory", "chats"] as const)
      if (shows(id)) cards[id].refresh();
  });
}

// ------------------------------------------------------------------ 专注
/** 今天的专注: today's minutes, the week's hours and the week in little
 * bars. 专注 asks in the card which of today's to-dos this one is for
 * (or just the timer) and starts it, 取消 going back; with none to choose
 * it starts at once. While a timer runs: its countdown, what it is for,
 * pause and 结束. */
/** How many to-dos the card offers to focus on. */
const PICKS = 5;
function focusCard(go: () => void): CardView {
  const body = el("div", "hc-focus");
  const meta = el("span", "hc-meta");
  let state: FocusState | null = null,
    doing = "",
    tick = 0,
    picking = false;
  const start = (id: number | null) => {
    picking = false;
    draw();
    void todos.focus(id);
  };
  async function pick() {
    const { candidates } = await todos.focusState();
    if (!candidates.length) return start(null);
    picking = true;
    const ask = el("div", "hc-row hc-ask");
    ask.append(
      el("span", "hc-text", t("home.focusWhich")),
      button("hc-btn", t("common.cancel"), cancel),
    );
    const rows = candidates.slice(0, PICKS).map((x) => {
      const b = button("hc-row hc-pick", "", () => start(x.id));
      b.append(el("span", "hc-text", x.title));
      if (x.time) b.append(el("span", "hc-sub", x.time));
      return b;
    });
    body.replaceChildren(
      ask,
      ...rows,
      act(t("focus.justTimer"), () => start(null)),
    );
    rows[0].focus();
  }
  /** Back to how the card was, nothing started. */
  function cancel() {
    picking = false;
    draw();
  }
  body.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && picking) cancel();
  });

  const bars = (s: FocusState) => {
    const row = el("div", "hc-bars");
    row.setAttribute("aria-hidden", "true");
    const max = Math.max(1, ...s.week.map((d) => d.minutes));
    s.week.forEach((d, i) => {
      const bar = el("i");
      bar.style.setProperty("--h", String(d.minutes / max));
      if (i === s.week.length - 1) bar.dataset.today = "";
      row.append(bar);
    });
    row.toggleAttribute("data-flat", !s.weekMinutes);
    return row;
  };

  function draw() {
    const s = state;
    if (!s) return;
    clearInterval(tick);
    const running = s.phase === "focus" || s.phase === "break";
    // While choosing, a quiet update keeps the list; a timer that starts ends it.
    if (picking && !running) return;
    picking = false;
    body.toggleAttribute("data-running", running);
    if (running) return drawRunning(s);
    meta.textContent = s.streak ? tn("home.streak", s.streak) : "";
    const row = el("div", "hc-row hc-focus-row");
    const words = el("div", "hc-num");
    if (!s.weekMinutes) {
      // Nothing this week: said so, and the bars lie flat.
      words.append(
        el("b", "hc-line-big", t("home.weekNone")),
        el(
          "div",
          "hc-sub",
          t("home.weekNoneHint", { m: s.settings.focusMinutes }),
        ),
      );
    } else {
      const n = el("div");
      n.append(
        el("span", "hc-big", String(s.todayMinutes)),
        el("small", "", t("home.minutes")),
      );
      words.append(
        n,
        el(
          "div",
          "hc-sub",
          t("home.weekHours", { h: (s.weekMinutes / 60).toFixed(1) }),
        ),
      );
    }
    row.append(words, bars(s));
    body.replaceChildren(
      row,
      act(t("home.focusStart"), () => void pick()),
    );
  }

  function drawRunning(s: FocusState) {
    const focusing = s.phase === "focus";
    const paused = s.pausedLeft !== null;
    meta.textContent = `${t(focusing ? "home.focusing" : "home.resting")} · ${t("home.round", { n: s.round })}`;
    const time = el("span", "hc-clock");
    const bar = el("div", "hc-progress");
    const fill = el("i");
    bar.append(fill);
    const show = () => {
      time.textContent = clock(timeLeft(s));
      fill.style.setProperty("--p", String(progress(s)));
    };
    show();
    if (!paused && !document.hidden) tick = window.setInterval(show, 1000);
    const row = el("div", "hc-row hc-clock-row");
    const words = el("div", "hc-num");
    words.append(time);
    if (focusing && doing)
      words.append(el("div", "hc-sub", t("home.doing", { title: doing })));
    row.append(words);
    if (focusing)
      row.append(
        button(
          "hc-btn",
          t(paused ? "home.resume" : "home.pause"),
          () => void focusCommand(paused ? "resume" : "pause"),
        ),
      );
    // Ends the focus or the break, as 结束 on the 专注 page does.
    row.append(
      button("hc-btn", t("focus.stop"), () => void focusCommand("stop")),
    );
    body.replaceChildren(row, bar, act(t("home.openFocus"), go));
  }

  async function load(s: FocusState) {
    state = s;
    draw();
    if (s.phase !== "focus") return void (doing = "");
    const on = await todos.focusState().catch(() => null);
    doing = on?.current?.title ?? "";
    draw();
  }
  void onFocus((s) => void load(s));
  document.addEventListener("visibilitychange", () => {
    if (!state) return;
    if (document.hidden) {
      clearInterval(tick);
      tick = 0;
    } else if (
      (state.phase === "focus" || state.phase === "break") &&
      state.pausedLeft === null
    ) {
      draw();
    }
  });
  return { body, meta, refresh: () => void focusState().then(load) };
}

// ---------------------------------------------------------------- 记住的
function memoryCard(go: () => void): CardView {
  const body = el("div", "hc-memory");
  const meta = el("span", "hc-meta");
  let entries: string[] = [];
  function draw() {
    // The newest are written last.
    const latest = entries.slice(-MEMORY_LINES).reverse();
    meta.textContent = entries.length
      ? tn("home.memoryCount", entries.length)
      : "";
    if (!latest.length) {
      body.replaceChildren(
        el("p", "hc-row hc-empty", t("home.memoryEmpty")),
        act(t("home.memoryWrite"), go),
      );
      return;
    }
    body.replaceChildren(
      ...latest.map((text) => el("p", "hc-row hc-text", text)),
      act(t("home.memoryGo"), go),
    );
  }
  async function refresh() {
    entries = native
      ? await invoke<{ user: { entries: string[] } }>("memory_view")
          .then((v) => v.user.entries)
          .catch(() => [])
      : PREVIEW_MEMORY;
    draw();
  }
  return { body, meta, refresh: () => void refresh() };
}

// ------------------------------------------------------------------ 聊天
function chatsCard(): CardView {
  const body = el("div", "hc-chats");
  const meta = el("span", "hc-meta");
  let topics: Topic[] = [];
  const openChat = () => void (native && invoke("open_chat_window"));
  const reopen = async (topic: Topic) => {
    if (!native) return;
    await invoke("reopen_chat_topic", { id: topic.id });
    await invoke("open_chat_window");
  };
  function draw() {
    const last = topics[0];
    meta.textContent = last ? topicTime(last.lastAt) : "";
    if (!last) {
      body.replaceChildren(
        el("p", "hc-row hc-empty", t("home.chatsEmpty")),
        act(t("home.chatsGo"), openChat),
      );
      return;
    }
    const row = el("div", "hc-row hc-chat");
    const face = el("img", "hc-face");
    face.alt = "";
    void petFace(last.pet)
      .then((url) => url && (face.src = url))
      .catch(() => {});
    row.append(face, el("span", "hc-text", last.title));
    body.replaceChildren(
      row,
      act(t("home.chatsResume"), () => void reopen(last)),
    );
  }
  async function refresh() {
    topics = native
      ? await invoke<Topic[]>("chat_topics", { query: "" }).catch(() => [])
      : PREVIEW_TOPICS;
    draw();
  }
  return { body, meta, refresh: () => void refresh() };
}
