// What the brain says while a bubble request runs: characters, rewrites,
// tools, a backup model, the daily limit, saved memories and questions.
// Events for any other request are ignored.
import { t } from "./i18n.ts";
import { showQuestion } from "./chatQuestion.ts";
import { bubbleSteps } from "./toolSteps.ts";
import type { MemoryReceipt } from "./bubbleReceipt.ts";

export function bubbleEvents(
  root: HTMLElement,
  o: {
    card: HTMLElement;
    note: HTMLElement;
    reply: { push(delta: string): void; rewind(text: string): void };
    /** The request this bubble waits for, or "". */
    token: () => string;
    /** The approval on screen, if any; `closed` puts it away. */
    approvalId: () => string | undefined;
    approvalClosed: () => void;
    state: (s: string) => void;
    showRemembered: (receipt: MemoryReceipt | null) => void;
  },
) {
  const pick = (q: string) => root.querySelector<HTMLElement>(q)!;
  return ({ method, params }: { method: string; params: any }) => {
    if (method === "approval.closed" && o.approvalId() === params?.id)
      o.approvalClosed();
    const token = o.token();
    if (params?.token !== token || !token) return;
    if (method === "chat.question") showQuestion(o.card, token, params);
    if (method === "chat.questionClosed")
      o.card
        .querySelector(
          '[data-question-id="' + CSS.escape(String(params.id)) + '"]',
        )
        ?.remove();
    if (method === "model.fallback") {
      const b = pick("[data-backup]");
      b.hidden = false;
      b.textContent = t("bubble.backup");
      b.title = String(params.model);
    }
    if (method === "usage.limit") {
      const b = pick("[data-budget]");
      b.hidden = false;
      b.textContent = t("bubble.budget");
    }
    if (method === "chat.steps")
      pick("[data-web-source]").replaceChildren(bubbleSteps(params.steps));
    if (method === "chat.rewind") o.reply.rewind(String(params.text));
    if (method === "chat.delta") {
      o.state("streaming");
      o.reply.push(String(params.delta));
    }
    if (method === "chat.remembered") o.showRemembered(params.receipt ?? null);
    if (method === "chat.toolStart") {
      o.state("tool");
      if (params.name === "web_read") o.note.textContent = t("bubble.reading");
    }
    if (method === "chat.toolsUnavailable") {
      o.state("tool");
      o.note.textContent = t("bubble.unreachable", {
        services: params.services.join(t("reminders.dayJoiner")),
      });
    }
  };
}
