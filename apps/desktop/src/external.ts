import { t } from "./i18n.ts";
import { mountToolCards } from "./toolCards.ts";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
type Server = { name: string; url: string; args: string[] };
type Grant = { server: Server; tool: string };
export function externalPanel(form: HTMLElement) {
  const section = document.createElement("section");
  section.className = "companion-external";
  form.append(section);
  section.innerHTML = `<div class="companion-buttons"><button type="button" data-find-tool>${t("tools.find")}</button></div><div data-catalog class="tool-list"></div><details class="set-more"><summary>${t("tools.advanced")}</summary><div class="set-more-body"><div data-services></div><label>${t("tools.name")}<input data-name></label><label>${t("tools.url")}<input data-url></label><label>${t("tools.args")}<textarea data-args></textarea></label><button type="button" data-add>${t("tools.add")}</button><h4>${t("tools.alwaysAllow")}</h4><div data-grants></div></div></details><output data-feedback></output>`;
  const get = <T extends HTMLElement>(q: string) =>
    section.querySelector<T>(q)!;
  const cards = mountToolCards(get("[data-catalog]"));
  const feedback = get("output");
  const edit = async (cmd: string, args: Record<string, unknown>) => {
    try {
      await invoke(cmd, args);
      feedback.textContent = t("settings.saved");
      await refresh();
    } catch (e) {
      feedback.textContent = String(e);
    }
  };
  get("[data-add]").onclick = () =>
    void edit("set_mcp", {
      remove: false,
      server: {
        name: get<HTMLInputElement>("[data-name]").value.trim(),
        url: get<HTMLInputElement>("[data-url]").value.trim(),
        args: get<HTMLTextAreaElement>("[data-args]")
          .value.split("\n")
          .filter(Boolean),
      },
    });
  const line = (
    where: HTMLElement,
    text: string,
    label: string,
    action: () => void,
  ) => {
    const row = document.createElement("div"),
      span = document.createElement("span"),
      b = document.createElement("button");
    row.className = "companion-entry";
    span.textContent = text;
    row.append(span);
    b.type = "button";
    b.className = "key small";
    b.textContent = label;
    b.onclick = action;
    row.append(b);
    where.append(row);
  };
  async function refresh() {
    await cards.refresh();
    const c = native
      ? await invoke<{
          servers: Server[];
          grants: Grant[];
          enabled?: Server[];
        }>("external_config")
      : { servers: [], grants: [], enabled: [] };
    const services = get("[data-services]"),
      grants = get("[data-grants]");
    services.replaceChildren();
    grants.replaceChildren();
    c.servers.forEach((s) => {
      const enabled = c.enabled?.some((v) => v.name === s.name);
      line(
        services,
        s.name,
        enabled ? t("tools.disable") : t("tools.enable"),
        () => void edit("enable_mcp", { server: s, enabled: !enabled }),
      );
      line(
        services,
        s.name + " · " + s.url,
        t("common.remove"),
        () => void edit("set_mcp", { server: s, remove: true }),
      );
    });
    c.grants.forEach((g) =>
      line(
        grants,
        g.server.name + " / " + (g.tool === "web_read" ? g.server.url : g.tool),
        t("tools.revoke"),
        () => void edit("revoke_tool", { grant: g }),
      ),
    );
    if (!c.grants.length) grants.textContent = t("tools.noGrants");
  }
  return refresh;
}
