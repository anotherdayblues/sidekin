import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";

export function showQuestion(
  parent: HTMLElement,
  token: string,
  params: Record<string, unknown>,
) {
  const id = String(params.id);
  const card = document.createElement("fieldset");
  card.dataset.questionId = id;
  const legend = document.createElement("legend");
  legend.textContent = String(params.question);
  card.append(legend);
  const custom = document.createElement("input");
  custom.placeholder = t("chat.ownAnswer");
  custom.maxLength = 2000;
  const status = document.createElement("small");
  async function submit(value: string) {
    if (!value.trim() || card.disabled) return;
    card.disabled = true;
    try {
      if (!(await invoke("answer_question", { token, id, answer: value })))
        throw Error(t("chat.questionOver"));
      card.remove();
    } catch (e) {
      card.disabled = false;
      status.textContent = String(e);
    }
  }
  function button(label: string, read: () => string) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = label;
    b.onclick = () => void submit(read());
    card.append(b);
  }
  for (const option of params.options as string[]) button(option, () => option);
  card.append(custom);
  button(t("chat.submit"), () => custom.value);
  card.append(status);
  custom.onkeydown = (e) => {
    if (e.key === "Enter" && !e.isComposing) {
      e.preventDefault();
      void submit(custom.value);
    }
  };
  parent.append(card);
}
