import { t, tn } from "./i18n.ts";
// The bubble's tool approval: which tool asks for what, the answer buttons,
// and moving between them with the keyboard.
export interface ApprovalRequest {
  id: string;
  token: string;
  service: string;
  tool: string;
  args: string;
}

/** The answer buttons; `choose` gets the label that was clicked. */
export function approvalChoices(
  choices: HTMLElement,
  request: ApprovalRequest | undefined,
  choose: (choice: "once" | "deny" | "always") => void,
) {
  const labels: ["once" | "deny" | "always", string][] = [
    ["once", t("approval.allow")],
    ["deny", t("approval.deny")],
  ];
  if (request?.service === "网页读取")
    labels.push(["always", t("approval.always")]);
  for (const [choice, label] of labels) {
    const b = document.createElement("button");
    b.textContent = label;
    b.disabled = !request;
    b.setAttribute("aria-pressed", String(choice === "once"));
    b.onfocus = () => {
      for (const option of choices.querySelectorAll("button"))
        option.setAttribute("aria-pressed", String(option === b));
    };
    b.onclick = () => choose(choice);
    choices.append(b);
  }
}

/** Says plainly which tool wants to do what, then the key arguments, and
 * counts down while `open` says the request is still the current one. */
export function showRequest(
  note: HTMLElement,
  request: ApprovalRequest,
  open: () => boolean,
) {
  const what = document.createElement("b"),
    args = document.createElement("code"),
    left = document.createElement("small");
  what.textContent = `${request.service === "网页读取" ? t("approval.webReader") : request.service} · ${request.tool}`;
  args.textContent = request.args;
  left.className = "bubble-countdown";
  note.replaceChildren(what, args, left);
  let seconds = 120;
  const tick = () => {
    left.textContent = tn("approval.autoDeny", seconds);
    if (seconds-- > 0 && open()) setTimeout(tick, 1000);
  };
  tick();
}

/** Arrow keys move between the answers and Enter picks the first one; true
 * when the key was used. */
export function approvalKey(e: KeyboardEvent, root: HTMLElement) {
  const buttons = Array.from(
    root.querySelectorAll<HTMLButtonElement>("[data-choices] button"),
  );
  const arrows = ["ArrowLeft", "ArrowRight"];
  if (arrows.includes(e.key) && buttons.length) {
    e.preventDefault();
    const pos = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = ["ArrowUp", "ArrowLeft"].includes(e.key) ? -1 : 1;
    buttons[
      (Math.max(pos, 0) + step + buttons.length) % buttons.length
    ].focus();
    return true;
  }
  if (
    e.key === "Enter" &&
    !buttons.includes(document.activeElement as HTMLButtonElement)
  ) {
    e.preventDefault();
    buttons[0]?.click();
    return true;
  }
  return false;
}
