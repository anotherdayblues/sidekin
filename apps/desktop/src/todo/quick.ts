// The one line a to-do is typed in (plan/27), for the page, the bubble and
// the note. Words for a day, time or repeat are marked in the line and
// summed up under it, and can be dropped with one click (Super
// Productivity's add bar marks them; Todoist and TickTick let a recognised
// date be turned back into words). With `controls`, the day, time and
// repeat can also be picked by hand, and an 添加 key shows once there is
// something to add (Super Productivity's add bar shows its send key the
// same way): what was picked by hand wins over what was understood.
import { watchCaret } from "../caretLook.ts";
import { t } from "../i18n.ts";
import { dayLabel, repeatLabel, REPEATS, today, type Fields } from "./api.ts";
import { loadParser, parseQuick, type Quick } from "./parse.ts";
import { petMark } from "./petMark.ts";
import "./todo-ai.css";
import "./quick.css";

export interface QuickLine {
  el: HTMLElement;
  input: HTMLInputElement;
  /** The to-do the line makes now. */
  read(): Fields;
  /** Empties the line and the pickers. */
  clear(): void;
  /** Return or 添加, with something to add. */
  onSubmit(cb: (f: Fields) => void): void;
  /** 整理成几条 was clicked, with the paragraph (plan/31). */
  onTidy(cb: (text: string) => void): void;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text = "",
) {
  const e = document.createElement(tag);
  if (className) e.className = className;
  if (text) e.textContent = text;
  return e;
}

/** "明天 15:00 · 每天", for the summary under the line. */
export function whenText(q: Pick<Quick, "day" | "time" | "repeat">) {
  return [
    [q.day ? dayLabel(q.day) : "", q.time ?? ""].filter(Boolean).join(" "),
    q.repeat ? repeatLabel(q.repeat) : "",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The day, time and repeat pickers: 今天, 明天, 不定日期 or a date. */
function pickers() {
  const wrap = el("div", "todo-quick-pickers");
  const when = el("select");
  when.setAttribute("aria-label", t("todo.date"));
  for (const [value, key] of [
    ["today", "todo.today"],
    ["tomorrow", "todo.tomorrow"],
    ["", "todo.noDay"],
    ["pick", "todo.pickDay"],
  ] as const) {
    const o = el("option", "", t(key));
    o.value = value;
    when.append(o);
  }
  const date = el("input");
  date.type = "date";
  date.hidden = true;
  date.setAttribute("aria-label", t("todo.date"));
  const time = el("input");
  time.type = "time";
  time.setAttribute("aria-label", t("todo.time"));
  time.title = t("todo.time");
  // A bell before it: the time is when to remind (plan/30).
  const remind = el("label", "todo-quick-remind");
  remind.append(time);
  const repeat = el("select");
  repeat.setAttribute("aria-label", t("todo.repeat"));
  for (const [value, key] of REPEATS) {
    const o = el("option", "", t(key));
    o.value = value;
    repeat.append(o);
  }
  const add = el("button", "todo-quick-add", t("todo.add"));
  add.type = "button";
  wrap.append(when, date, remind, repeat, add);
  when.addEventListener("change", () => {
    date.hidden = when.value !== "pick";
    if (!date.hidden) date.focus();
  });
  return {
    wrap,
    add,
    controls: [when, date, time, repeat] as const,
    set(day = today(), tm = "", r = "") {
      when.value =
        day === today()
          ? "today"
          : day === today(1)
            ? "tomorrow"
            : day
              ? "pick"
              : "";
      date.value = day;
      date.hidden = when.value !== "pick";
      time.value = tm;
      repeat.value = r;
    },
    read(): Fields {
      const w = when.value;
      return {
        day:
          w === "pick"
            ? date.value
            : w === "today"
              ? today()
              : w === "tomorrow"
                ? today(1)
                : "",
        time: time.value,
        repeat: repeat.value as Fields["repeat"],
      };
    },
  };
}

/** Said once, the first time 整理成几条 shows (plan/32). */
const TIDY_SEEN = "todo-tidy-hint-seen";
/** A paragraph rather than one to-do: long, or two sentences or more. The
 * quiet 整理成几条 shows only then (plan/31). */
export function isParagraph(text: string) {
  const s = text.trim();
  return s.length >= 40 || (s.match(/[。！？；;!?]/g)?.length ?? 0) >= 2;
}

export function quickLine(
  o: {
    controls?: boolean;
    addKey?: boolean;
    placeholder?: string;
    /** 伙伴大脑 can read a pasted paragraph into to-dos (plan/31). */
    tidy?: () => Promise<boolean>;
  } = {},
): QuickLine {
  const root = el("div", "todo-quick");
  const field = el("div", "todo-quick-field");
  const mirror = el("div", "todo-quick-mirror");
  mirror.setAttribute("aria-hidden", "true");
  const input = el("input", "todo-quick-input");
  input.maxLength = 200;
  input.autocomplete = "off";
  input.spellcheck = false;
  input.placeholder = o.placeholder ?? t("todo.quickPlaceholder");
  input.setAttribute("aria-label", t("todo.new"));
  watchCaret(input);
  field.append(mirror, input);
  const chip = el("div", "todo-quick-chip");
  chip.hidden = true;
  const when = el("span", "todo-quick-when");
  const drop = el("button", "todo-quick-drop");
  drop.type = "button";
  drop.setAttribute("aria-label", t("todo.dropWhen"));
  drop.title = t("todo.dropWhen");
  chip.append(when, drop);
  root.append(field, chip);
  const pick = o.controls ? pickers() : null;
  if (pick) root.append(pick.wrap);
  // No pickers: the 添加 key sits at the end of the line.
  const addKey = !pick && o.addKey ? el("button", "todo-quick-add") : null;
  if (addKey) {
    addKey.type = "button";
    addKey.setAttribute("aria-label", t("todo.add"));
    addKey.title = t("todo.add");
    field.append(addKey);
  }
  root.dataset.empty = "";
  // 整理成几条: in the corner of the field, only for a paragraph, only
  // with 伙伴大脑 on.
  const tidy = el("button", "todo-quick-tidy");
  tidy.type = "button";
  tidy.hidden = true;
  tidy.title = t("todo.aiTidyHint");
  tidy.append(el("span", "", t("todo.aiTidy")));
  // The first time it shows, one quiet line says what it does.
  const hint = el("small", "todo-quick-hint", t("todo.aiTidyHint"));
  hint.hidden = true;
  root.append(hint);
  // The face is looked up when the key first shows: by then the pet is in.
  let marked = false;
  let canTidy = false;
  if (o.tidy) {
    field.append(tidy);
    void o.tidy().then((on) => {
      canTidy = on;
      draw();
    });
  }
  let onTidy: (text: string) => void = () => {};
  tidy.onclick = () => onTidy(input.value.trim());

  /** The words the user said to keep as words. */
  let dropped = false;
  /** A picker was set by hand: it wins over the words. */
  let byHand = false;
  let q: Quick | null = null;
  let submit: (f: Fields) => void = () => {};
  for (const c of pick?.controls ?? [])
    c.addEventListener("change", () => (byHand = true));
  function draw() {
    const text = input.value;
    if (!text.trim()) dropped = false;
    if (text.trim()) delete root.dataset.empty;
    else root.dataset.empty = "";
    const parsed = parseQuick(text);
    q =
      !dropped && parsed.spans.length && parsed.title !== text.trim()
        ? parsed
        : null;
    // The line drawn again under the field, with what was understood
    // marked; the field's own text sits on top of it.
    mirror.replaceChildren();
    let at = 0;
    for (const [s, e] of q?.spans ?? []) {
      mirror.append(text.slice(at, s), el("mark", "", text.slice(s, e)));
      at = e;
    }
    mirror.append(text.slice(at));
    tidy.hidden = !(canTidy && isParagraph(text));
    root.toggleAttribute("data-tidy", !tidy.hidden);
    if (!tidy.hidden && !marked) {
      marked = true;
      tidy.prepend(petMark());
      try {
        hint.hidden = localStorage.getItem(TIDY_SEEN) === "1";
        localStorage.setItem(TIDY_SEEN, "1");
      } catch {
        /* no hint, no harm */
      }
    }
    if (tidy.hidden) hint.hidden = true;
    // A paragraph is for 伙伴大脑 to read: its dates are not taken here.
    if (!tidy.hidden) {
      q = null;
      mirror.replaceChildren(text);
    }
    chip.hidden = !q;
    when.textContent = q ? whenText(q) : "";
    chip.toggleAttribute("data-remind", !!q?.time);
    if (pick && !byHand) pick.set(q?.day, q?.time, q?.repeat);
  }
  function read(): Fields {
    const title = (q ? q.title : input.value).trim();
    if (pick) return { ...pick.read(), title };
    return q
      ? { title, day: q.day, time: q.time, repeat: q.repeat }
      : { title, day: today() };
  }
  // Added before chrono-node is in (a quick Return): read with it first.
  const send = async () => {
    await loadParser().catch(() => {});
    draw();
    const f = read();
    if (f.title) submit(f);
  };
  input.addEventListener("input", draw);
  input.addEventListener(
    "scroll",
    () => (mirror.scrollLeft = input.scrollLeft),
  );
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  if (pick) pick.add.onclick = () => void send();
  if (addKey) addKey.onclick = () => void send();
  drop.onclick = () => {
    dropped = true;
    draw();
    input.focus();
  };
  draw();
  // chrono-node comes the first time the line is used, not before: a
  // window where nothing is typed never loads it.
  const reader = () =>
    void loadParser().then(() => {
      if (input.value) draw();
    });
  input.addEventListener("focus", reader, { once: true });
  return {
    el: root,
    input,
    read,
    clear() {
      input.value = "";
      byHand = false;
      draw();
      pick?.set();
    },
    onSubmit(cb) {
      submit = cb;
    },
    onTidy(cb) {
      onTidy = cb;
    },
  };
}
