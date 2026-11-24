import { t } from "./i18n.ts";
import "./styles/usage-receipt.css";
// Fixed reference rate keeps this estimate available offline.
// https://api.frankfurter.dev/v1/2026-11-06?base=USD&symbols=CNY
const yuanPerDollar = 6.6713;
type Period = {
  tokens: number | null;
  cacheRead: number | null;
  costUsd: number | null;
  missingTokens: boolean;
  missingCache: boolean;
  missingCost: boolean;
};
export interface UsageSummary {
  today: Period;
  month: Period;
}

export function usageReceipt() {
  const receipt = document.createElement("article");
  receipt.className = "usage-receipt";
  receipt.innerHTML = `<header><div><h3>${t("usage.receipt")}</h3><time></time></div><canvas class="receipt-pet" width="96" height="104" role="img" hidden></canvas></header>`;
  return receipt;
}

export function usageTable(summary?: UsageSummary) {
  const table = document.createElement("table");
  table.innerHTML = `<thead><tr><th aria-label='${t("usage.label")}'></th><th><span>${t("usage.today")}</span></th><th>${t("usage.month")}</th></tr></thead>`;
  const body = table.createTBody();
  for (const [title, key, missing] of [
    [t("usage.tokens"), "tokens", "missingTokens"],
    [t("usage.cache"), "cacheRead", "missingCache"],
    [t("usage.cost"), "costUsd", "missingCost"],
  ] as const) {
    const row = body.insertRow();
    row.dataset.metric = key;
    const heading = document.createElement("th");
    heading.scope = "row";
    heading.textContent = title;
    row.append(heading);
    for (const period of ["today", "month"] as const) {
      const data = summary?.[period];
      const value = data ? data[key] : 0;
      const cell = row.insertCell();
      if (value === null) {
        cell.className = "receipt-status";
        cell.textContent =
          key === "costUsd" ? t("usage.noPrice") : t("usage.notReported");
        continue;
      }
      let label = value.toLocaleString("zh-CN");
      if (key === "costUsd") {
        const yuan = value * yuanPerDollar;
        label =
          yuan > 0 && yuan < 0.01
            ? t("usage.underCent")
            : "¥" + yuan.toFixed(2);
      }
      cell.textContent = label;
      if (data?.[missing]) {
        const note = document.createElement("small");
        note.textContent = t("usage.partial");
        cell.append(note);
      }
    }
  }
  return table;
}
