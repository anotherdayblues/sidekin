import { ANIMATIONS } from "./animation.ts";
import { t } from "./i18n.ts";
import { actionLabel, describeRule, type Rule } from "./teaching.ts";
import { el } from "./studioDom.ts";
import * as api from "./bridge.ts";
import type { StudioContext } from "./studioContext.ts";

export function mountStudioPopovers(c: StudioContext) {
  const { $, custom, attempt, lcd } = c;
  // ---------- popovers ----------
  function closePop() {
    const pop = $("#pop");
    pop.hidden = true;
    delete pop.dataset.kind;
    for (const a of c.app.querySelectorAll<HTMLElement>(
      '.pop-anchor[aria-expanded="true"]',
    )) {
      a.setAttribute("aria-expanded", "false");
    }
  }
  /** One question before anything that changes what the pet has learned. */
  function confirmPop(
    anchor: HTMLElement,
    title: string,
    lead: string[],
    yesText: string,
    onYes: () => Promise<unknown>,
    danger = false,
  ) {
    const yes = el("button", danger ? "key danger-key" : "key", yesText),
      no = el("button", "key", t("common.cancel"));
    no.onclick = closePop;
    yes.onclick = () => {
      closePop();
      attempt(onYes);
    };
    const buttons = el("div", "pop-buttons");
    buttons.append(yes, no);
    openPop(anchor, [
      el("strong", "pop-title", title),
      ...lead.map((line) => el("p", "pop-lead", line)),
      buttons,
    ]);
    yes.focus();
  }
  /** Deleting is permanent, so it always goes through this question. */
  function confirmRemove(p: api.Pet, anchor: HTMLElement) {
    confirmPop(
      anchor,
      t("studio.removeAsk", { name: p.displayName }),
      [t("studio.removeWarn")],
      t("studio.removeConfirm", { name: p.displayName }),
      async () => {
        await api.removePet(p.id);
        lcd(t("studio.removed", { name: p.displayName }));
      },
      true,
    );
  }
  const quote = (labels: string[]) => labels.map((l) => `「${l}」`).join("、");
  /**
   * Taking one learned thing away saves a new version, so it can always be
   * brought back from the change log. The question says exactly that.
   */
  function confirmForget(
    p: api.Pet,
    anchor: HTMLElement,
    what: { action: string } | { rule: Rule },
  ) {
    const { layer, history } = custom(p);
    const keep = t("studio.keepNote");
    if ("action" in what) {
      const label = actionLabel(what.action, layer);
      if (what.action in ANIMATIONS) {
        confirmPop(
          anchor,
          t("studio.restoreAction", { label }),
          [t("studio.restoreActionNote"), keep],
          t("studio.restoreActionButton"),
          async () => {
            await api.forgetCustom(p.id, [what.action], []);
            lcd(t("studio.actionRestored", { label }));
          },
        );
        return;
      }
      const rules = layer.rules.filter((r) =>
        r.do.some((s) => s.play === what.action),
      );
      confirmPop(
        anchor,
        t("studio.dropActionAsk", { label }),
        [
          rules.length
            ? t("studio.dropActionRules", {
                rules: quote(rules.map((r) => r.label)),
              })
            : t("studio.dropActionNote"),
          keep,
        ],
        t("studio.drop"),
        async () => {
          await api.forgetCustom(p.id, [what.action], []);
          lcd(t("studio.dropped", { label }));
        },
        true,
      );
    } else {
      confirmPop(
        anchor,
        t("studio.dropRuleAsk", { label: what.rule.label }),
        [
          t("studio.dropRuleNote", { rule: describeRule(what.rule, layer) }),
          keep,
        ],
        t("studio.drop"),
        async () => {
          await api.forgetCustom(p.id, [], [what.rule.id]);
          lcd(t("studio.dropped", { label: what.rule.label }));
        },
        true,
      );
    }
  }
  function openPop(
    anchor: HTMLElement,
    content: HTMLElement[],
    opts?: { kind?: string },
  ) {
    const pop = $("#pop");
    // A menu item can open the next panel in this same popover.
    const r = anchor.getBoundingClientRect();
    if (opts?.kind) pop.dataset.kind = opts.kind;
    else delete pop.dataset.kind;
    pop.replaceChildren(...content);
    pop.hidden = false;
    const w = pop.offsetWidth;
    pop.style.left = `${Math.min(innerWidth - w - 12, Math.max(12, r.left))}px`;
    pop.style.top = `${r.bottom + 8}px`;
    if (r.bottom + pop.offsetHeight + 16 > innerHeight)
      pop.style.top = `${Math.max(12, r.top - pop.offsetHeight - 8)}px`;
  }
  document.addEventListener("pointerdown", (e) => {
    const t = e.target as Node;
    if (
      !$("#pop").contains(t) &&
      !(t as HTMLElement).closest?.("#add,#teach,.pop-anchor")
    )
      closePop();
  });

  return { closePop, openPop, confirmPop, confirmRemove, confirmForget };
}
