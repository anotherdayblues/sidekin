// The 专注 page's records (plan/29), as the reports of Pomofocus, Super
// Productivity and TickTick keep them: three numbers, a bar for each day,
// today's sessions, and what the week's time went on. A session ended early
// is listed by its minutes, never as failed; one on no to-do is 只计时.
// Starting one is the pet's: this page only looks back.
import "./styles/focus-record.css";
import { dateLocale, t, tn } from "./i18n.ts";
import { onTodos, todos } from "./todo/api.ts";
import type { FocusDay, FocusState } from "./focus.ts";

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
const hm = (ms: number) =>
  new Date(ms).toLocaleTimeString(dateLocale, {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
const DAY = 86_400_000;
/** The to-dos shown under 这一周花在哪, the rest left out. */
const TOP = 6;

/** "75 分钟", "1 小时 15 分钟". */
export function duration(minutes: number) {
  const h = Math.floor(minutes / 60),
    m = minutes % 60;
  return h ? t("focus.hours", { h, m }) : t("focus.minutes", { m });
}
/** A big number and its unit: minutes under an hour and a half, else hours
 * to one place ("5.4"). */
function amount(minutes: number): [string, string] {
  if (minutes < 90) return [String(minutes), t("focus.unitMinutes")];
  const h = Math.round(minutes / 6) / 10;
  return [String(h), t("focus.unitHours")];
}

export function mountFocusRecord(slots: {
  tiles: HTMLElement;
  chart: HTMLElement;
  range: HTMLElement;
  today: HTMLElement;
  spent: HTMLElement;
}) {
  // ---------- the three numbers ----------
  const tile = (label: string) => {
    const box = el("section", "focus-tile");
    const value = el("b", "focus-tile-value");
    const note = el("em", "focus-tile-note");
    box.append(el("span", "focus-tile-label", label), value, note);
    slots.tiles.append(box);
    return (big: string, unit: string, small: string) => {
      value.replaceChildren(big, el("small", "", unit));
      note.textContent = small;
    };
  };
  const today = tile(t("focus.tileToday"));
  const week = tile(t("focus.tileWeek"));
  const streak = tile(t("focus.tileStreak"));

  // ---------- each day ----------
  let range: "week" | "month" = "week";
  for (const b of slots.range.querySelectorAll<HTMLButtonElement>(
    "[data-range]",
  ))
    b.onclick = () => {
      range = b.dataset.range as typeof range;
      if (state) draw(state);
    };
  function bars(days: FocusDay[]) {
    const top = Math.max(30, ...days.map((d) => d.minutes));
    const month = days.length > 7;
    slots.chart.dataset.range = month ? "month" : "week";
    slots.chart.replaceChildren(
      ...days.map((d, i) => {
        const date = new Date(d.day + "T12:00:00");
        const li = el("li");
        li.title = `${date.toLocaleDateString(dateLocale, { month: "short", day: "numeric", weekday: "short" })} · ${duration(d.minutes)}`;
        if (i === days.length - 1) li.dataset.today = "";
        // The bar's height is data, the one value CSS cannot know.
        const bar = el("i");
        bar.style.setProperty("--h", String(d.minutes / top));
        if (!d.minutes) bar.dataset.zero = "";
        // A week names its days; a month every fifth, and today.
        const name = month
          ? i % 5 === 4 || i === days.length - 1
            ? String(date.getDate())
            : ""
          : date.toLocaleDateString(dateLocale, { weekday: "narrow" });
        li.append(
          el("em", "", !month && d.minutes ? String(d.minutes) : ""),
          bar,
          el("span", "", name),
        );
        return li;
      }),
    );
    for (const b of slots.range.querySelectorAll<HTMLElement>("[data-range]"))
      b.setAttribute("aria-pressed", String(b.dataset.range === range));
  }

  // ---------- today, and the week by to-do ----------
  const list = el("ol", "focus-today");
  const none = el("div", "focus-empty");
  none.append(
    el("b", "", t("focus.todayEmpty")),
    el("span", "", t("focus.howToStart", { item: t("focus.start") })),
  );
  slots.today.replaceChildren(list, none);
  const spentList = el("ul", "focus-spent");
  const spentNone = el("p", "focus-empty-line", t("focus.spentEmpty"));
  slots.spent.replaceChildren(spentList, spentNone);

  let titlesKey = "";
  let titles = new Map<number, string>();
  async function loadTitles(from: number, key: string) {
    if (key === titlesKey) return;
    titlesKey = key;
    titles = new Map(
      (await todos.spent(from).catch(() => [])).map((x) => [x.at, x.title]),
    );
  }
  async function drawLists(s: FocusState) {
    const sessions = s.sessions ?? [];
    const weekly = s.weekSessions ?? sessions;
    const from = new Date().setHours(0, 0, 0, 0) - 6 * DAY;
    await loadTitles(from, weekly.map((x) => x.at).join(","));
    list.replaceChildren(
      ...[...sessions].reverse().map((x) => {
        const li = el("li", "focus-today-row");
        li.dataset.done = String(x.done);
        const title = titles.get(x.at);
        if (!title) li.dataset.none = "";
        li.append(
          el(
            "span",
            "focus-today-time",
            `${hm(x.at)}–${hm(x.at + x.minutes * 60_000)}`,
          ),
          el("span", "focus-today-title", title ?? t("focus.justTimer")),
          el("span", "focus-today-min", t("focus.minutes", { m: x.minutes })),
        );
        return li;
      }),
    );
    none.hidden = sessions.length > 0;
    // What the week went on, the most first; 只计时 last of all.
    const by = new Map<string, number>();
    for (const x of weekly) {
      const k = titles.get(x.at) ?? "";
      by.set(k, (by.get(k) ?? 0) + x.minutes);
    }
    const rows = [...by]
      .filter(([, m]) => m > 0)
      .sort((a, b) => Number(a[0] === "") - Number(b[0] === "") || b[1] - a[1])
      .slice(0, TOP);
    const most = Math.max(1, ...rows.map(([, m]) => m));
    spentList.replaceChildren(
      ...rows.map(([title, m]) => {
        const li = el("li", "focus-spent-row");
        if (!title) li.dataset.none = "";
        const bar = el("i");
        const fill = el("u");
        // The bar's length is data.
        fill.style.setProperty("--w", String(m / most));
        bar.append(fill);
        li.append(
          el("span", "focus-spent-title", title || t("focus.justTimer")),
          el("span", "focus-spent-min", duration(m)),
          bar,
        );
        return li;
      }),
    );
    spentNone.hidden = rows.length > 0;
  }

  let state: FocusState | null = null;
  function draw(s: FocusState) {
    state = s;
    const yesterday = s.week.at(-2)?.minutes ?? 0;
    const diff = s.todayMinutes - yesterday;
    today(
      ...amount(s.todayMinutes),
      s.todayMinutes || s.today
        ? [
            tn("focus.times", s.today),
            diff > 0
              ? t("focus.vsMore", { m: diff })
              : diff < 0
                ? t("focus.vsLess", { m: -diff })
                : t("focus.vsSame"),
          ].join(" · ")
        : t("focus.notYet"),
    );
    week(
      ...amount(s.weekMinutes),
      [
        tn("focus.times", s.weekCount),
        t("focus.avgDay", { m: Math.round(s.weekMinutes / 7) }),
      ].join(" · "),
    );
    streak(
      String(s.streak),
      tn("focus.unitDays", s.streak),
      t("focus.longest", { days: tn("focus.days", s.longest ?? s.streak) }),
    );
    bars(range === "month" && s.month?.length ? s.month : s.week);
    void drawLists(s);
  }
  void onTodos(() => {
    titlesKey = "";
    if (state) void drawLists(state);
  });
  return { draw };
}
