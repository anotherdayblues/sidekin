import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import "./styles/user-profile.css";

export interface UserProfile {
  text: string;
  used: number;
  limit: number;
  migration?: { undone: boolean; canUndo: boolean; entries: string[] } | null;
}

export function profileEditor(
  parent: HTMLElement,
  petId: string,
  data: UserProfile,
  refresh: () => Promise<void>,
) {
  const editor = document.createElement("section");
  editor.className = "profile-editor";
  editor.innerHTML = `<h3><label for="user-profile-text">${t("profile.mine")}</label><small>${t("profile.mineNote")}</small></h3>
    <textarea id="user-profile-text" spellcheck="false" placeholder="${t("profile.placeholder")}"></textarea>
    <div class="profile-actions"><button type="button" data-profile-save>${t("common.save")}</button><small data-profile-count></small></div>
    <output data-profile-status role="status"></output>`;
  parent.append(editor);
  const input = editor.querySelector("textarea")!;
  const button = editor.querySelector<HTMLButtonElement>(
    "[data-profile-save]",
  )!;
  const count = editor.querySelector("[data-profile-count]")!;
  const status = (text: string) => {
    let output = parent.querySelector("[data-profile-status]");
    if (!output) {
      output = document.createElement("output");
      output.setAttribute("data-profile-status", "");
      output.setAttribute("role", "status");
      parent.append(output);
    }
    output.textContent = text;
  };
  const counter = () => {
    count.textContent = t("memory.meter", {
      used: [...input.value].length,
      limit: data.limit,
    });
  };
  input.value = data.text;
  counter();
  input.oninput = () => {
    // Count Unicode characters like Rust, so one emoji does not consume two places.
    input.value = [...input.value].slice(0, data.limit).join("");
    editor.dataset.editing = "true";
    status("");
    counter();
  };
  async function save(params: object, message: string) {
    const controls = [...editor.querySelectorAll("button")].map(
      (b) => [b, b.disabled] as const,
    );
    editor.dataset.editing = "true";
    input.disabled = true;
    editor.querySelectorAll("button").forEach((b) => (b.disabled = true));
    status(t("settings.saving"));
    try {
      await invoke("memory_edit", { petId, ...params });
      await refresh();
      status(message);
    } catch (e) {
      status(String(e));
      input.disabled = false;
      controls.forEach(([b, disabled]) => (b.disabled = disabled));
    }
  }
  button.onclick = () =>
    void save({ profile: input.value }, t("profile.saved"));
  const receipt = data.migration;
  if (receipt) {
    const migration = document.createElement("div");
    migration.className = "profile-migration";
    const note = document.createElement("p");
    note.className = "memo-note";
    note.textContent = receipt.undone
      ? t("profile.undone")
      : t("profile.merged");
    const action = document.createElement("button");
    action.type = "button";
    action.className = "link";
    action.textContent = receipt.undone ? t("profile.redo") : t("profile.undo");
    action.disabled = !receipt.undone && !receipt.canUndo;
    if (action.disabled) note.textContent = t("profile.edited");
    action.onclick = () =>
      void save(
        { profileAction: receipt.undone ? "migrate" : "undo" },
        receipt.undone ? t("profile.redone") : t("profile.undoneShort"),
      );
    const backup = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = t("profile.backup");
    const list = document.createElement("ul");
    for (const text of receipt.entries) {
      const row = document.createElement("li");
      row.textContent = text;
      list.append(row);
    }
    backup.append(summary, list);
    migration.append(note, action, backup);
    editor.append(migration);
  }
}
