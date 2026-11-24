import { t } from "./locale.ts";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { lookup } from "node:dns/promises";
import { get as http } from "node:http";
import { get as https } from "node:https";
import ipaddr from "ipaddr.js";
import { hostCall } from "./host.ts";
import { authorize, limitResult } from "./mcp.ts";
import { text as promptText } from "./texts.ts";

export const searchEndpoints = {
  deepseek: "https://api.deepseek.com/v1/tools/search",
  "moonshotai-cn": "https://api.moonshot.cn/v1/tools/search",
  moonshotai: "https://api.moonshot.ai/v1/tools/search",
  bocha: "https://api.bocha.cn/v1/web-search",
  glm: "https://open.bigmodel.cn/api/paas/v4/web_search",
  tavily: "https://api.tavily.com/search",
  brave: "https://api.search.brave.com/res/v1/web/search",
};
export interface SearchConfig {
  provider: keyof typeof searchEndpoints | "searxng";
  baseUrl: string;
  apiKey: string;
}
export function webUrl(value: string) {
  const u = new URL(value);
  if (
    !["https:", "http:"].includes(u.protocol) ||
    u.username ||
    u.password ||
    u.href.length > 2048
  )
    throw Error("需要完整的 HTTP 或 HTTPS 网页地址");
  u.hash = "";
  return u.href;
}
type Hit = { url: string; title: string; summary: string };
async function fetchSearch(
  config: SearchConfig,
  query: string,
  signal?: AbortSignal,
  request = fetch,
): Promise<Hit[]> {
  if (!query.trim() || query.length > 500)
    throw Error("搜索词应为 1 至 500 字");
  const { provider, apiKey } = config;
  const url = new URL(
    provider === "searxng"
      ? config.baseUrl.replace(/\/+$/, "") + "/search"
      : searchEndpoints[provider],
  );
  const headers: Record<string, string> = { Accept: "application/json" };
  const body =
    provider === "deepseek"
      ? { query: Array.from(query).slice(0, 128).join(""), count: 5 }
      : provider.startsWith("moonshotai")
        ? { text_query: query, limit: 5 }
        : provider === "bocha"
          ? { query, count: 5, summary: true }
          : provider === "glm"
            ? { search_engine: "search_std", search_query: query, count: 5 }
            : provider === "tavily"
              ? { query, max_results: 5 }
              : undefined;
  if (body) headers["Content-Type"] = "application/json";
  else {
    url.searchParams.set("q", query);
    if (provider === "searxng") url.searchParams.set("format", "json");
    else url.searchParams.set("count", "5");
  }
  if (apiKey) {
    if (provider === "brave") headers["X-Subscription-Token"] = apiKey;
    else headers.Authorization = "Bearer " + apiKey;
  }
  const timeout = AbortSignal.timeout(15000);
  const r = await request(url, {
    method: body ? "POST" : "GET",
    headers,
    body: body ? JSON.stringify(body) : undefined,
    redirect: "error",
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!r.ok || !r.body) throw Error("搜索服务暂时不可用，请检查设置");
  const reader = r.body.getReader(),
    parts: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 2_000_000) throw Error("搜索结果过大");
      parts.push(value);
    }
  } finally {
    await reader.cancel();
  }
  const data = JSON.parse(Buffer.concat(parts).toString());
  const items = provider.startsWith("moonshotai")
    ? data.search_results
    : provider === "bocha"
      ? data.data?.webPages?.value
      : provider === "glm"
        ? data.search_result
        : provider === "brave"
          ? data.web?.results
          : data.results;
  if (!Array.isArray(items)) throw Error("搜索服务返回的格式无法识别");
  return items.slice(0, 5).flatMap((item: any) => {
    try {
      return [
        {
          url: webUrl(item.url ?? item.link),
          title: String(item.title ?? item.name ?? "").slice(0, 300),
          summary: String(
            item.summary ??
              item.snippet ??
              item.description ??
              item.content ??
              "",
          ).slice(0, 1100),
        },
      ];
    } catch {
      return [];
    }
  });
}
export { fetchSearch };
export function publicIP(address: string) {
  if (!ipaddr.isValid(address)) return false;
  const ip = ipaddr.process(address);
  return (
    ip.range() === "unicast" &&
    (ip.kind() === "ipv4" || (ip.toByteArray()[0] & 0xe0) === 0x20)
  );
}
type PageData = { html: string; redirect?: string; plain?: boolean };
async function pageData(
  value: string,
  signal?: AbortSignal,
): Promise<PageData> {
  const u = new URL(value),
    host = u.hostname.replace(/^\[|\]$/g, "");
  const ips = await lookup(host, { all: true });
  if (!ips.length || ips.some((ip) => !publicIP(ip.address)))
    throw Error("只能读取公网网页");
  // Connect to the vetted IP, while retaining the original certificate name and Host.
  const stop = AbortSignal.timeout(15000);
  return new Promise((ok, no) => {
    const req = (u.protocol === "https:" ? https : http)(
      {
        hostname: ips[0].address,
        port: u.port || undefined,
        path: u.pathname + u.search,
        servername: host,
        headers: {
          Host: u.host,
          Accept: "text/html,text/plain",
          "Accept-Encoding": "identity",
        },
        agent: false,
        signal: signal ? AbortSignal.any([signal, stop]) : stop,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        if (
          [301, 302, 303, 307, 308].includes(status) &&
          res.headers.location
        ) {
          res.destroy();
          try {
            return ok({
              html: "",
              redirect: new URL(res.headers.location, u).href,
            });
          } catch {
            return no(Error("网页返回了无效的重定向地址"));
          }
        }
        const type = res.headers["content-type"] ?? "";
        if (
          status < 200 ||
          status >= 300 ||
          !/^text\/(?:html|plain)\b|^application\/xhtml\+xml\b/i.test(type)
        ) {
          res.destroy();
          return no(
            Error(
              [401, 403].includes(status)
                ? "对方拒绝访问"
                : "这个地址没有可读的网页正文",
            ),
          );
        }
        const parts: Buffer[] = [];
        let size = 0;
        res.on("error", () => no(Error("网页读取失败")));
        res.on("data", (part) => {
          size += part.length;
          if (size > 3_000_000) {
            res.destroy();
            no(Error("网页过大"));
          } else parts.push(part);
        });
        res.on("end", () =>
          ok({
            html: Buffer.concat(parts).toString("utf8"),
            plain: type.startsWith("text/plain"),
          }),
        );
      },
    );
    req.on("error", () =>
      no(Error(stop.aborted ? "网页读取超时" : "网页连接失败或已取消")),
    );
  });
}
export function webTools(
  config: SearchConfig | undefined,
  message: string,
  token: string,
  read = pageData,
  search = fetchSearch,
  approve = authorize,
  earlierUrls?: string[],
  source: (item: { title: string; url: string }) => void = () => {},
  failure: (reason: string) => void = () => {},
): AgentTool[] {
  const canSearch =
    config &&
    (config.provider === "searxng"
      ? !!config.baseUrl
      : Object.hasOwn(searchEndpoints, config.provider) && !!config.apiKey);
  const allowed = new Set<string>(canSearch ? earlierUrls : []);
  for (const match of message.matchAll(
    /https?:\/\/[^\s<>"'，。！？；、）】」]+/giu,
  )) {
    try {
      allowed.add(webUrl(match[0].replace(/[.,;!?)\]]+$/, "")));
    } catch {}
  }
  const params = (key: string) => ({
    type: "object" as const,
    properties: {
      [key]: {
        type: "string" as const,
        description: key === "query" ? "要搜的关键词。" : "要读的网页地址。",
      },
    },
    required: [key],
    additionalProperties: false,
  });
  const result = (
    value: string,
    details: { pages?: { title: string; url: string }[]; reason?: string } = {},
  ) => ({
    content: [{ type: "text" as const, text: limitResult(value) }],
    details,
  });
  let failed = "";
  let emptyQuery: string | undefined;
  const tools: AgentTool[] = [
    {
      name: "web_search",
      label: t("step.webSearch"),
      description: promptText("tool-web-search"),
      parameters: params("query"),
      execute: async (_id, args, signal) => {
        const query = String((args as any).query);
        if (
          emptyQuery !== undefined &&
          emptyQuery !== query &&
          failed === "这次没查到。"
        )
          failed = "";
        if (failed) return result(failed, { reason: failed });
        let hits: Hit[] = [];
        try {
          hits = await search(config!, query, signal);
          if (!hits.length) {
            failed = "这次没查到。";
            emptyQuery = query;
          } else if (emptyQuery !== undefined) {
            emptyQuery = undefined;
            failure("");
          }
        } catch (e) {
          if (signal?.aborted) throw e;
          failed =
            e instanceof Error && e.message === "quota"
              ? "今天的搜索次数用完了。"
              : "搜索服务暂时连不上。";
        }
        if (failed) {
          failure(failed);
          return result(failed, { reason: failed });
        }
        for (const h of hits) allowed.add(h.url);
        if (earlierUrls)
          await hostCall("host.webResults", {
            token,
            urls: hits.map((h) => h.url),
          });
        return result(JSON.stringify(hits), {
          pages: hits.map(({ title, url }) => ({ title, url })),
        });
      },
    },
    {
      name: "web_read",
      label: t("step.webRead"),
      description: promptText("tool-web-read"),
      parameters: params("url"),
      execute: async (_id, args, signal) => {
        let url = webUrl(String((args as any).url));
        for (let i = 0; i < 5; i++) {
          if (!allowed.has(url)) {
            if (
              !(await approve(
                token,
                {
                  server: { name: "网页读取", url, args: [] },
                  tool: "web_read",
                },
                { url },
                signal,
              ))
            )
              throw Error("用户没有同意读取这个地址");
            allowed.add(url);
          }
          const p = await read(url, signal);
          if (p.redirect) {
            url = webUrl(p.redirect);
            continue;
          }
          if (!p.html.trim()) throw Error("没有找到可读的网页正文");
          if (p.plain) {
            const page = { title: new URL(url).hostname, url };
            source(page);
            return result(p.html, { pages: [page] });
          }
          const [{ Readability }, { parseHTML }] = await Promise.all([
            import("@mozilla/readability"),
            import("linkedom"),
          ]);
          const { document } = parseHTML(p.html);
          const extracted = new Readability(
            document as unknown as Document,
          ).parse();
          if (!extracted?.textContent?.trim())
            throw Error("没有找到可读的网页正文");
          const page = {
            title: extracted.title?.slice(0, 300) || new URL(url).hostname,
            url,
          };
          source(page);
          return result(
            (extracted.title ?? "") + "\n" + extracted.textContent.trim(),
            { pages: [page] },
          );
        }
        throw Error("网页重定向过多");
      },
    },
  ];
  return canSearch ? tools : tools.slice(1);
}
