import { t } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";

export function mountLoginStart(group: HTMLElement) {
  const label = document.createElement("label");
  label.className = "switch-row";
  label.innerHTML = `<span>${t("login.start")}</span><input class="slide-switch" type="checkbox" role="switch">`;
  const input = label.querySelector("input")!;
  const status = document.createElement("small");
  status.setAttribute("role", "status");
  group.append(label, status);
  let writing = false;
  let revision = 0;
  async function refresh() {
    if (!native || writing) return;
    const id = ++revision;
    try {
      const enabled = await invoke<boolean>("login_start_enabled");
      if (revision === id) {
        input.checked = enabled;
        input.disabled = false;
        status.textContent = "";
      }
    } catch {
      if (revision === id) {
        input.disabled = true;
        status.textContent = t("login.unreadable");
      }
    }
  }
  input.disabled = native;
  input.onchange = async (event) => {
    event.stopPropagation();
    if (!native) return;
    writing = true;
    ++revision;
    input.disabled = true;
    const wanted = input.checked;
    try {
      input.checked = await invoke<boolean>("set_login_start", {
        enabled: wanted,
      });
      status.textContent = input.checked === wanted ? "" : t("login.confirm");
    } catch {
      input.checked = !wanted;
      status.textContent = t("login.failed");
    } finally {
      writing = false;
      input.disabled = false;
    }
  };
  void refresh();
  window.addEventListener("focus", refresh);
}
