import { ANIMATIONS } from "./animation.ts";
import { t, dateLocale } from "./i18n.ts";
import * as api from "./bridge.ts";
import { Motion } from "./spring.ts";
import {
  actionLabel,
  describeRule,
  type Rule,
  type Layer,
  type Step,
} from "./teaching.ts";
import { el } from "./studioDom.ts";

export function ruleRow(
  rule: Rule,
  layer: Layer,
  onTry: () => void,
  mark = "",
) {
  const row = el("div", "rule"),
    text = el("div", "rule-text"),
    b = el("button", "play-key");
  b.setAttribute("aria-label", t("studio.tryOnce"));
  b.title = t("studio.tryOnce");
  text.append(
    el("strong", "", rule.label),
    el("span", "", describeRule(rule, layer)),
  );
  if (mark) row.append(el("span", "rule-mark silk", mark));
  row.append(text, b);
  b.onclick = onTry;
  return row;
}

interface DraftReaderOptions {
  selected: () => api.Pet | undefined;
  draftsFor: (pet: api.Pet) => api.Draft[];
  layerFor: (pet: api.Pet | undefined) => Layer;
  onSelectionChanged: (pet: api.Pet | undefined) => void;
  paintThumbnail: (canvas: HTMLCanvasElement) => void;
  hasClip: (name: string) => boolean;
  play: (name: string, onDesktop?: boolean) => void;
  playSteps: (steps: Step[], prefix?: string) => void;
  attempt: (run: () => Promise<unknown>) => Promise<void>;
  lcd: (text: string) => void;
}

export function mountDraftReader(
  app: HTMLElement,
  options: DraftReaderOptions,
) {
  const {
    selected,
    draftsFor,
    layerFor,
    onSelectionChanged,
    paintThumbnail,
    hasClip,
    play,
    playSteps,
    attempt,
    lcd,
  } = options;
  const $ = (selector: string) => app.querySelector<HTMLElement>(selector)!;
  const seenDrafts = new Set<string>();
  const cardMotions = new Map<string, Motion>();

  function renderSlot(p: api.Pet | undefined) {
    const cards = $("#cards");
    const drafts = p ? draftsFor(p) : [];
    $("#draft-heading").hidden = !drafts.length;
    $("#slot").hidden = !drafts.length;
    $("#slot").classList.toggle("loaded", drafts.length > 0);
    if (!drafts.length) cards.style.height = "0px";
    // Keep existing card elements so their springs are not restarted.
    const keep = new Set(drafts.map((d) => d.id));
    for (const node of [...cards.children] as HTMLElement[])
      if (!keep.has(node.dataset.id!)) node.remove();
    drafts.forEach((d) => {
      let card = cards.querySelector<HTMLElement>(`[data-id="${d.id}"]`);
      if (!card) {
        card = buildCard(d, p!);
        cards.append(card);
        const fresh = !seenDrafts.has(d.id);
        seenDrafts.add(d.id);
        const m = new Motion(
          fresh ? -1.05 : 0,
          (v) => {
            card!.style.transform = `translateY(${v * 100}%)`;
            // Everything below is pushed by the paper itself, so it moves
            // exactly as far as the card has come out of the reader.
            if (card!.isConnected && !card!.hidden)
              cards.style.height = `${Math.max(0, Math.min(1, 1 + v)) * card!.offsetHeight}px`;
          },
          // A card reader pushes the card out against light friction.
          // Paper does not bounce: critically damped.
          { stiffness: 140, damping: 24 },
        );
        cardMotions.set(d.id, m);
        if (fresh) {
          // A newly arrived card is the one shown.
          shownDraft = d.id;
          setTimeout(() => m.to(0), 120);
          blink();
          // The pet notices something arrived.
          setTimeout(() => play("review", false), 200);
        }
      }
    });
    // Several drafts: one is shown at a time; ‹ › on the reader flips.
    if (!drafts.some((d) => d.id === shownDraft))
      shownDraft = drafts[0]?.id ?? null;
    const index = drafts.findIndex((d) => d.id === shownDraft);
    for (const d of drafts) {
      const card = cards.querySelector<HTMLElement>(`[data-id="${d.id}"]`)!;
      card.hidden = d.id !== shownDraft;
      card.querySelector(".card-overlap")?.remove();
      const overlap = overlapNote(d, drafts);
      if (overlap)
        card
          .querySelector(".card-buttons")!
          .before(el("p", "card-note card-overlap", overlap));
      if (!card.hidden) {
        const m = cardMotions.get(d.id)!;
        cards.style.height = `${Math.max(0, Math.min(1, 1 + m.value)) * card.offsetHeight}px`;
      }
    }
    $("#reader-screen").textContent =
      drafts.length > 1
        ? t("studio.draftOf", { i: index + 1, n: drafts.length })
        : drafts.length
          ? t("studio.draftOne")
          : "";
    for (const id of ["#draft-prev", "#draft-next"])
      $(id).hidden = drafts.length < 2;
    for (const c of cards.querySelectorAll<HTMLCanvasElement>(
      "canvas[data-clip]",
    ))
      paintThumbnail(c);
  }
  let shownDraft: string | null = null;
  function flipDraft(step: number) {
    const p = selected();
    const drafts = p ? draftsFor(p) : [];
    if (drafts.length < 2) return;
    const i = drafts.findIndex((d) => d.id === shownDraft);
    shownDraft = drafts[(i + step + drafts.length) % drafts.length].id;
    renderSlot(p);
    onSelectionChanged(p);
  }
  $("#draft-prev").onclick = () => flipDraft(-1);
  $("#draft-next").onclick = () => flipDraft(1);
  /** When two drafts change the same action or rule, the later accept wins. */
  function overlapNote(d: api.Draft, drafts: api.Draft[]) {
    const touched = (x: api.Draft) =>
      new Map<string, string>([
        ...[...x.addedActions, ...x.removedActions].map(
          (n) =>
            [
              `a:${n}`,
              x.preview.actions[n]?.label ??
                actionLabel(n, layerFor(selected())),
            ] as [string, string],
        ),
        ...[...x.addedRules, ...x.removedRules].map(
          (id) =>
            [
              `r:${id}`,
              x.preview.rules.find((r) => r.id === id)?.label ??
                layerFor(selected()).rules.find((r) => r.id === id)?.label ??
                id,
            ] as [string, string],
        ),
      ]);
    const mine = touched(d);
    const shared = new Set<string>();
    for (const other of drafts)
      if (other.id !== d.id)
        for (const [key, label] of touched(other))
          if (mine.has(key)) shared.add(label);
    return shared.size
      ? t("studio.draftOverlap", {
          names: [...shared].join(t("studio.nameJoiner")),
        })
      : "";
  }
  function blink() {
    const led = $("#slit-led");
    led.classList.remove("blink");
    void led.offsetWidth;
    led.classList.add("blink");
  }
  function buildCard(d: api.Draft, p: api.Pet) {
    const card = el("article", "card");
    card.dataset.id = d.id;
    const stamp = new Date(d.receivedAt * 1000).toLocaleString(dateLocale, {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
    card.append(
      el("div", "silk", t("studio.draftAt", { stamp })),
      el("h3", "", d.summary),
    );
    const current = layerFor(p);
    const replacements = d.addedActions.filter(
      (n) => n in ANIMATIONS || n in current.actions,
    );
    if (d.addedActions.length) {
      const strip = el("div", "card-actions");
      for (const name of d.addedActions) {
        const b = el("button", "mini-tile"),
          c = el("canvas");
        c.width = 64;
        c.height = 69;
        b.append(c, el("span", "", d.preview.actions[name].label));
        b.onclick = () => play(`draft:${d.id}:${name}`, false);
        c.dataset.clip = `draft:${d.id}:${name}`;
        c.dataset.frames = String(d.preview.actions[name].durations.length);
        if (replacements.includes(name)) {
          const before = el("button", "mini-tile");
          before.textContent = t("studio.currentAction");
          before.onclick = () => play(name, false);
          b.title = t("studio.newActionPreview");
          strip.append(before);
          card.append(
            el(
              "p",
              "card-note",
              t("studio.replacementNote", {
                label: d.preview.actions[name].label,
              }),
            ),
          );
        }
        strip.append(b);
      }
      card.append(strip);
    }
    for (const id of d.addedRules) {
      const rule = d.preview.rules.find((r) => r.id === id)!;
      card.append(
        ruleRow(
          rule,
          d.preview,
          () => {
            playSteps(rule.do, `draft:${d.id}:`);
            attempt(() =>
              api.previewOnDesktop({
                petId: p.id,
                draftId: d.id,
                steps: rule.do,
              }),
            );
          },
          current.rules.some((r) => r.id === id)
            ? t("studio.replaces")
            : t("studio.new"),
        ),
      );
    }
    const removed = [
      ...d.removedActions.map((n) => actionLabel(n, current)),
      ...d.removedRules.map(
        (id) => current.rules.find((r) => r.id === id)?.label ?? id,
      ),
    ];
    if (removed.length)
      card.append(
        el(
          "p",
          "card-note",
          t("studio.willRemove", {
            list: removed.join(t("reminders.dayJoiner")),
          }),
        ),
      );
    const actions = el("div", "card-buttons"),
      accept = el(
        "button",
        "key primary",
        t(replacements.length ? "studio.acceptReplacement" : "studio.accept"),
      ),
      discard = el("button", "key", t("archive.later"));
    accept.onclick = () => acceptDraft(d, card);
    discard.onclick = () =>
      attempt(async () => {
        const m = cardMotions.get(d.id);
        m?.to(1.4, 3);
        await new Promise((r) => setTimeout(r, 260));
        await api.discardDraft(d.id);
        lcd(t("archive.kept"));
      });
    actions.append(accept, discard);
    card.append(actions);
    return card;
  }
  let landed = new Set<string>();
  async function acceptDraft(d: api.Draft, card: HTMLElement) {
    landed = new Set(d.addedRules);
    setTimeout(() => (landed = new Set()), 2000);
    await attempt(async () => {
      // The reader draws the card back in at a steady pull.
      cardMotions.get(d.id)?.to(-1.1, -2);
      card.classList.add("swallowed");
      await new Promise((r) => setTimeout(r, 420));
      await api.acceptDraft(d.id);
      blink();
      lcd(t(d.addedActions.length ? "archive.saved" : "archive.changed"));
      // The pet performs what it just learned, as soon as the accepted
      // actions have arrived from the library: the first new habit in full.
      const rule = d.preview.rules.find((r) => d.addedRules.includes(r.id));
      const steps =
        rule?.do ?? d.addedActions.slice(0, 1).map((a) => ({ play: a }));
      const needed = steps.flatMap((x) => (x.play ? [x.play] : []));
      for (let i = 0; i < 40 && !needed.every(hasClip); i++)
        await new Promise((r) => setTimeout(r, 50));
      if (steps.length) playSteps(steps);
    });
  }

  return {
    render: renderSlot,
    accept: acceptDraft,
    get shownId() {
      return shownDraft;
    },
    isLanding: (ruleId: string) => landed.has(ruleId),
    markSeen(drafts: api.Draft[]) {
      seenDrafts.clear();
      for (const draft of drafts) seenDrafts.add(draft.id);
    },
  };
}
