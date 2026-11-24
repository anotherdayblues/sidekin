// Only the four pinned service endpoints may reuse a model credential for search.
import { presets, type Service } from "./companion.ts";
const direct = ["glm", "deepseek", "moonshotai", "moonshotai-cn"] as const;
export function hasDirectSearch(service: Service | undefined, baseUrl: string) {
  return direct.some(
    (id) => id === service && presets[id][1] === baseUrl.replace(/\/+$/, ""),
  );
}
/** The settings note as a key of apps/shared/locales. */
export function searchDescription(service: Service, baseUrl: string) {
  if (hasDirectSearch(service, baseUrl)) return "online.searchBuiltIn";
  return service === "ollama" || service === "lmstudio"
    ? "online.searchLocal"
    : "online.searchNone";
}
