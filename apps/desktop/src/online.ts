import { t } from "./i18n.ts";
import { usageReceipt, usageTable, type UsageSummary } from "./usageTable.ts";
import {
  hasDirectSearch,
  searchDescription,
} from "../../shared/searchServices.ts";
import { invoke } from "@tauri-apps/api/core";
import { native } from "./bridge.ts";
import {
  presets,
  type CompanionSettings,
  type Service,
} from "../../shared/companion.ts";

const keyPages: Record<string, [string, string]> = {
  bocha: [t("online.keyBocha"), "https://open.bochaai.com/"],
  glm: [t("online.keyGlm"), "https://bigmodel.cn/usercenter/proj-mgmt/apikeys"],
  tavily: [t("online.keyTavily"), "https://www.tavily.com/"],
  brave: [t("online.keyBrave"), "https://brave.com/search/api/"],
  searxng: [t("online.keySearxng"), "https://docs.searxng.org/"],
};
export function onlineSettings(form: HTMLFormElement) {
  const section = document.createElement("section");
  section.className = "companion-online";
  section.dataset.part = "search";
  section.innerHTML = `<p class="set-note" data-search-guide></p><label>${t("settings.searchService")}<select data-search><option value="follow">${t("online.followModel")}</option><option value="">${t("common.off")}</option><option value="bocha">${t("online.bocha")}</option><option value="glm">${t("online.glm")}</option><option value="tavily">Tavily</option><option value="brave">Brave</option><option value="searxng">SearXNG</option></select></label><label data-url-label>${t("online.searxngUrl")}<input data-search-url type="url"></label><div class="search-key-actions"><label data-key-label for="search-service-key">${t("online.searchKey")}</label><input id="search-service-key" data-search-key type="password" autocomplete="off" placeholder="${t("online.keyHidden")}"><button type="button" data-save-online>${t("online.testSave")}</button></div><output data-online-status aria-live="polite"></output><p class="set-note" data-key-help hidden></p><label>${t("online.searchLimit")}<input data-search-limit type="number" required min="0" max="10000" step="1"></label>`;
  // 备用模型 and the daily limit live apart from search (a folded group in
  // 设置), with their own save button and status, saved by the same request.
  const backups = document.createElement("section");
  backups.className = "companion-online";
  backups.dataset.part = "backups";
  backups.innerHTML = `<div data-backups></div><button type="button" data-add>${t("online.addBackup")}</button><label>${t("online.dailyLimit")}<input data-limit type="number" min="0" max="1000000000" step="1"></label><div class="search-key-actions"><button type="button" data-save-online>${t("online.testSave")}</button></div><output data-online-status aria-live="polite"></output>`;
  const usage = usageReceipt();
  const usageBody = document.createElement("div");
  usage.append(usageBody);
  usage.dataset.usage = "";
  usage.setAttribute("aria-live", "polite");
  form.append(section, backups, usage);
  let busy = false;
  const parts = [section, backups];
  const pick = <T extends HTMLElement>(q: string) =>
    (section.querySelector<T>(q) ?? backups.querySelector<T>(q))!;
  const search = pick<HTMLSelectElement>("[data-search]"),
    url = pick<HTMLInputElement>("[data-search-url]"),
    key = pick<HTMLInputElement>("[data-search-key]"),
    limit = pick<HTMLInputElement>("[data-limit]"),
    rows = pick("[data-backups]"),
    add = pick<HTMLButtonElement>("[data-add]");
  function update() {
    pick("[data-url-label]").hidden = search.value !== "searxng";
    url.required = search.value === "searxng";
    url.disabled = busy || !url.required;
    pick("[data-key-label]").hidden = ["", "follow", "searxng"].includes(
      search.value,
    );
    key.hidden = pick("[data-key-label]").hidden;
    // Only the chosen service's link: where to get its key, or its docs.
    const help = pick("[data-key-help]"),
      where = keyPages[search.value];
    help.hidden = !where;
    if (where) {
      const a = document.createElement("a");
      a.href = where[1];
      a.textContent = where[0] + " ↗";
      a.target = "_blank";
      a.rel = "noopener";
      if (native)
        a.onclick = (e) => {
          e.preventDefault();
          void invoke("open_bubble_link", { url: where[1] });
        };
      help.replaceChildren(
        search.value === "searxng" ? t("online.noInstance") : t("online.noKey"),
        a,
      );
    }
    add.disabled = busy || rows.children.length >= 2;
  }
  let searchReference = "";
  search.onchange = () => {
    searchReference = "";
    key.value = "";
    url.value = "";
    update();
  };
  url.onchange = () => {
    searchReference = "";
    key.value = "";
  };
  type Backup = CompanionSettings["fallbacks"][number];
  function row(b: Backup) {
    const block = document.createElement("fieldset");
    block.innerHTML = `<label>${t("model.service")}<select></select></label><label>${t("model.baseUrl")}<input type="url" required></label><label>${t("model.name")}<input data-model required></label><label>Key<input type="password" autocomplete="off" placeholder="${t("online.backupKeyHint")}"></label><div class="switch-row"><span>${t("model.canSee")}</span><input type="checkbox" role="switch" aria-label="${t("model.canSee")}" class="slide-switch"></div><button type="button">${t("online.removeBackup")}</button>`;
    block.dataset.credentialRef = b.credentialRef ?? "";
    const select = block.querySelector("select")!;
    for (const [id, [title]] of Object.entries(presets))
      select.add(new Option(title, id));
    const [base, model, secret, vision] = block.querySelectorAll("input");
    select.value = b.service;
    base.value = b.baseUrl;
    model.value = b.model;
    vision.checked = b.canSee;
    select.onchange = () => {
      block.dataset.credentialRef = "";
      base.value = presets[select.value as Service][1];
      secret.value = "";
      model.value = "";
    };
    base.onchange = () => {
      block.dataset.credentialRef = "";
      secret.value = "";
    };
    block.querySelector("button")!.onclick = () => {
      block.remove();
      update();
    };
    rows.append(block);
    update();
  }
  for (const part of parts)
    part.querySelector<HTMLElement>("[data-save-online]")!.onclick = () =>
      form.dispatchEvent(new Event("save-online"));
  add.onclick = () => {
    if (rows.children.length < 2)
      row({
        service: "openai",
        baseUrl: presets.openai[1],
        model: "",
        canSee: false,
      });
  };
  async function refresh() {
    usage.querySelector("time")!.textContent = new Date()
      .toLocaleDateString("sv-SE")
      .replaceAll("-", " / ");
    const view = usageBody;
    try {
      const totals = native
        ? await invoke<UsageSummary>("companion_usage")
        : undefined;
      view.replaceChildren(usageTable(totals));
    } catch {
      view.textContent = t("usage.unreadable");
    }
  }
  return {
    setBusy(value: boolean) {
      busy = value;
      for (const part of parts)
        for (const input of part.querySelectorAll<
          HTMLInputElement | HTMLSelectElement | HTMLButtonElement
        >("input,select,button"))
          input.disabled = value;
      update();
    },
    refresh,
    fill(s: CompanionSettings) {
      searchReference = s.search?.credentialRef ?? "";
      const supported = hasDirectSearch(s.service, s.baseUrl);
      search.querySelector<HTMLOptionElement>('[value="follow"]')!.disabled =
        !supported;
      pick<HTMLInputElement>("[data-search-limit]").value = String(
        s.searchDailyLimit ?? 20,
      );
      const guide = pick("[data-search-guide]");
      guide.textContent = t(searchDescription(s.service, s.baseUrl));
      search.value =
        s.search?.provider ??
        (s.followSearch !== false && supported ? "follow" : "");
      url.value = s.search?.baseUrl ?? "";
      key.value = "";
      limit.value = String(s.dailyLimit ?? 0);
      rows.replaceChildren();
      s.fallbacks?.forEach(row);
      update();
    },
    read() {
      return {
        searchDailyLimit: pick<HTMLInputElement>("[data-search-limit]")
          .valueAsNumber,
        followSearch: search.value === "follow",
        search:
          search.value && search.value !== "follow"
            ? {
                credentialRef: searchReference,
                provider: search.value,
                baseUrl: search.value === "searxng" ? url.value.trim() : "",
              }
            : null,
        dailyLimit: limit.valueAsNumber || 0,
        fallbacks: [...rows.querySelectorAll("fieldset")].map((block) => {
          const [base, model, , vision] = block.querySelectorAll("input");
          return {
            service: block.querySelector("select")!.value as Service,
            model: model.value.trim(),
            baseUrl: base.value.trim(),
            canSee: vision.checked,
            credentialRef: block.dataset.credentialRef,
          };
        }),
      };
    },
    secrets() {
      return {
        searchKey: key.value || null,
        fallbackKeys: [
          ...rows.querySelectorAll<HTMLInputElement>('[type="password"]'),
        ].map((input) => input.value || null),
      };
    },
    clear() {
      key.value = "";
      rows
        .querySelectorAll<HTMLInputElement>('[type="password"]')
        .forEach((e) => {
          e.value = "";
        });
    },
  };
}
