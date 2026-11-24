import type {
  Api,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  endpoint,
  providerFetch,
  withProviderEndpoint,
} from "./connectionFetch.ts";
import type { SearchConfig } from "./web.ts";
export { streamRequest as streamModel } from "./runtime.ts";
import { lists } from "../../shared/catalog.ts";
import { presets, type Service } from "../../shared/companion.ts";
export interface Connection {
  toolCheck?: {
    baseUrl: string;
    model: string;
    protocol: string;
    status: string;
  };
  search?: SearchConfig;
  fallbacks?: Connection[];
  protocol?: Api;
  service?: Service;
  model: string;
  baseUrl: string;
  apiKey: string;
  visionModel?: string;
  canSee?: boolean;
  contextWindow?: number;
  /** plan/15: the language the user reads, "zh" or "en". */
  locale?: "zh" | "en";
}
export function modelFor(c: Connection, vision = false): Model<Api> {
  const service = c.service ?? "custom",
    id = (vision && c.visionModel) || c.model;
  const known = Object.values(lists[service] ?? {}).find((m) => m.id === id);
  const baseUrl = (c.baseUrl || presets[service][1]).replace(/\/+$/, "");
  if (known) return { ...known, baseUrl };
  const api =
    c.protocol ||
    (service === "openai"
      ? "openai-responses"
      : service === "google"
        ? "google-generative-ai"
        : ["anthropic", "minimax", "minimax-cn"].includes(service)
          ? "anthropic-messages"
          : "openai-completions");
  return {
    id,
    name: id,
    api,
    provider: service,
    baseUrl,
    input: c.canSee ? ["text", "image"] : ["text"],
    reasoning: false,
    contextWindow: c.contextWindow || 32768,
    maxTokens: Math.min(c.contextWindow || 32768, 4096),
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  };
}
export async function rawStream(
  model: Model<Api>,
  ctx: TranscriptContext,
  options: SimpleStreamOptions,
) {
  return withProviderEndpoint(model.baseUrl, async () => {
    switch (model.api) {
      case "openai-responses":
        return (
          await import("@earendil-works/pi-ai/api/openai-responses")
        ).streamSimple(model as Model<"openai-responses">, ctx, options);
      case "anthropic-messages":
        return (
          await import("@earendil-works/pi-ai/api/anthropic-messages")
        ).streamSimple(model as Model<"anthropic-messages">, ctx, options);
      case "google-generative-ai":
        return (
          await import("@earendil-works/pi-ai/api/google-generative-ai")
        ).streamSimple(model as Model<"google-generative-ai">, ctx, options);
      default:
        return (
          await import("@earendil-works/pi-ai/api/openai-completions")
        ).streamSimple(model as Model<"openai-completions">, ctx, options);
    }
  });
}
export async function listModels(c: Connection) {
  const service = c.service ?? "custom",
    base = (c.baseUrl || presets[service][1]).replace(/\/+$/, "");
  const api = modelFor(c).api;
  const headers: Record<string, string> = {};
  if (c.apiKey && api === "google-generative-ai")
    headers["x-goog-api-key"] = c.apiKey;
  else if (api === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    if (c.apiKey) headers["x-api-key"] = c.apiKey;
  } else if (c.apiKey) headers.Authorization = "Bearer " + c.apiKey;
  const path = api === "anthropic-messages" ? "/v1/models" : "/models";
  try {
    endpoint(base);
    const response = await providerFetch(base)(base + path, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      return {
        models: [],
        source: "remote",
        error: response.statusText.startsWith("COMPANION_")
          ? fault(response.statusText)
          : statusFault(response.status),
      };
    const body = (await response.json()) as {
      data?: { id: string }[];
      models?: { name: string; supportedGenerationMethods?: string[] }[];
    };
    const names =
      body.data?.map((x) => x.id) ??
      body.models
        ?.filter(
          (x) =>
            !x.supportedGenerationMethods ||
            x.supportedGenerationMethods.includes("generateContent"),
        )
        .map((x) => x.name.replace(/^models\//, ""));
    if (!Array.isArray(names))
      return { models: [], source: "remote", error: "catalog" };
    return {
      models: [
        ...new Set(
          names.filter(
            (x) => typeof x === "string" && x.length > 0 && x.length <= 200,
          ),
        ),
      ].slice(0, 2000),
      source: "remote",
    };
  } catch (e) {
    return { models: [], source: "remote", error: fault(String(e)) };
  }
}
export function statusFault(status: number) {
  if (status === 401) return "auth";
  if (status === 403) return "forbidden";
  if (status === 404) return "notFound";
  if (status === 402) return "balance";
  if (status === 429) return "busy";
  if (status >= 500) return "server";
  return "model";
}
export function fault(message: string) {
  for (const code of ["redirect", "endpoint"])
    if (message.includes("COMPANION_" + code.toUpperCase())) return code;
  for (const code of [
    "unsupportedTools",
    "missingKey",
    "redirect",
    "insecure",
    "endpoint",
    "catalog",
    "forbidden",
    "notFound",
    "balance",
    "busy",
    "network",
    "auth",
    "budget",
    "server",
    "stopped",
    "timeout",
    "tls",
  ]) {
    if (message === code || message.includes("Error: " + code)) return code;
  }
  if (
    /does not support (?:tools?|function calling)|tools? (?:is |are )?not supported|unsupported.{0,20}(?:function calling|tool use)/i.test(
      message,
    )
  )
    return "unsupportedTools";
  const status = message.match(/\b(401|402|403|404|429|5\d\d)\b/);
  if (status) return statusFault(Number(status[1]));
  if (/No API key for provider/i.test(message)) return "missingKey";
  if (/api.key|authentication|unauthorized/i.test(message)) return "auth";
  if (/certificate|CERT_|SSL|TLS/i.test(message)) return "tls";
  if (/quota|rate.limit|overload/i.test(message)) return "busy";
  if (/timeout|timed out|TimeoutError/i.test(message)) return "timeout";
  if (/connection|network|fetch failed|ECONN|ENOTFOUND|offline/i.test(message))
    return "network";
  return "model";
}
