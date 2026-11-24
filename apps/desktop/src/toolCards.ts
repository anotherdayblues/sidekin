import { t, named } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import catalog from "../../../skills/find-pet-tool/catalog.json";
import { native } from "./bridge.ts";
import "./styles/web-tools.css";
// The built-in catalogue is written in Chinese for the agent that reads it;
// the card shows its words in the user's language.
const shown = (
  item: { id: string } & Record<string, unknown>,
  field: "name" | "use" | "data",
) => named(`toolCatalog.${item.id}.${field}`, String(item[field]));
interface Snapshot {
  pending: { id: string; reason: string; ticket: string }[];
  tools: { id: string; enabled: boolean }[];
}
export function mountToolCards(root: HTMLElement) {
  const pending = document.createElement("div"),
    active = document.createElement("div"),
    feedback = document.createElement("output");
  root.append(pending, active, feedback);
  let last: Snapshot = { pending: [], tools: [] };
  function draw(state: Snapshot) {
    last = state;
    pending.replaceChildren();
    active.replaceChildren();
    for (const row of [...state.pending, ...state.tools]) {
      const item = catalog.find((x) => x.id === row.id);
      if (!item) continue;
      const draft = "ticket" in row;
      const account =
        item.auth === "bearer"
          ? t("toolCard.needsKey")
          : t("toolCard.noAccount");
      // A proposal looks like a teaching draft: a card waiting for an answer.
      // A tool already added is one row of the shared settings list.
      const card = document.createElement(draft ? "article" : "div");
      const title = document.createElement(draft ? "h3" : "span");
      if (draft) {
        card.className = "card tool-card";
        const silk = document.createElement("div");
        silk.className = "silk";
        silk.textContent = t("toolCard.new");
        title.textContent = shown(item, "name");
        const facts = document.createElement("dl");
        facts.className = "tool-facts";
        for (const [k, v] of [
          [t("toolCard.use"), shown(item, "use")],
          [t("toolCard.data"), shown(item, "data")],
          [t("toolCard.account"), account],
        ]) {
          const dt = document.createElement("dt"),
            dd = document.createElement("dd");
          dt.textContent = k;
          dd.textContent = v;
          facts.append(dt, dd);
        }
        card.append(silk, title, facts);
        if (row.reason) {
          const why = document.createElement("p");
          why.className = "card-note";
          why.textContent = t("toolCard.why", { reason: row.reason });
          card.append(why);
        }
      } else {
        card.className = "companion-entry tool-row";
        card.dataset.enabled = String(row.enabled);
        title.className = "tool-name";
        const name = document.createElement("b"),
          use = document.createElement("small");
        name.textContent = shown(item, "name");
        use.textContent = row.enabled
          ? shown(item, "use")
          : t("toolCard.disabled");
        title.append(name, use);
        card.append(title);
      }
      const secret = document.createElement("input");
      if (draft && item.auth === "bearer") {
        secret.type = "password";
        secret.autocomplete = "new-password";
        secret.placeholder = t("toolCard.pasteKey");
        secret.setAttribute("aria-label", t("toolCard.enterKey"));
        const field = document.createElement("label");
        field.className = "tool-key";
        field.append(t("toolCard.tavilyKey"), secret);
        card.append(field);
      }
      const actions = draft
        ? [
            [t("tools.enable"), "accept"],
            [t("toolCard.discard"), "discard"],
          ]
        : [
            [
              row.enabled ? t("tools.disable") : t("tools.enable"),
              row.enabled ? "disable" : "enable",
            ],
            [t("toolCard.delete"), "delete"],
          ];
      const keys = document.createElement("div");
      keys.className = draft ? "card-buttons" : "tool-keys";
      card.append(keys);
      for (const [label, action] of actions) {
        const b = document.createElement("button");
        b.type = "button";
        b.className =
          draft && action === "accept"
            ? "key primary"
            : draft
              ? "key"
              : "key small";
        b.textContent = label;
        keys.append(b);
        b.onclick = async () => {
          const buttons = card.querySelectorAll("button");
          buttons.forEach((v) => (v.disabled = true));
          try {
            if (native) {
              if (draft)
                await invoke("decide_tool_card", {
                  ticket: row.ticket,
                  enable: action === "accept",
                  key: action === "accept" ? secret.value || null : null,
                });
              else await invoke("manage_catalog_tool", { id: row.id, action });
              await refresh();
            } else {
              const tools = last.tools.filter((x) => x.id !== row.id);
              if (!["delete", "discard"].includes(action))
                tools.push({ id: row.id, enabled: action !== "disable" });
              draw({
                pending: last.pending.filter(
                  (x) => !draft || x.ticket !== row.ticket,
                ),
                tools,
              });
            }
            secret.value = "";
            feedback.textContent = t("toolCard.done");
          } catch (e) {
            feedback.textContent = String(e);
          } finally {
            buttons.forEach((v) => (v.disabled = false));
          }
        };
      }
      (draft ? pending : active).append(card);
    }
  }
  async function refresh() {
    draw(native ? await invoke<Snapshot>("tool_cards") : last);
  }
  return { refresh, preview: draw };
}
