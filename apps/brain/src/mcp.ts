import { t } from "./locale.ts";
import { createHash, randomUUID } from "node:crypto";
import {
  McpClient,
  StdioTransport,
  StreamableHttpTransport,
} from "@earendil-works/pi-mcp";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { hostCall } from "./host.ts";
export interface McpServer {
  name: string;
  url: string;
  args: string[];
}
export interface Grant {
  server: McpServer;
  tool: string;
}
const live = new Map<McpClient, string>();
export async function disconnectMcp(name: string) {
  await Promise.allSettled(
    [...live]
      .filter(([, n]) => n === name)
      .map(([client]) => {
        live.delete(client);
        return client.close();
      }),
  );
}
type Access = { url?: string; name?: string; tools?: string[]; key?: string };
export async function connectMcp(
  servers: McpServer[],
  signal?: AbortSignal,
  access?: (s: McpServer) => Promise<Access>,
) {
  const clients: McpClient[] = [];
  const grants = new Map<string, Grant>();
  const tools: AgentTool[] = [];
  const close = () =>
    Promise.allSettled(
      clients.map((c) => {
        live.delete(c);
        return c.close();
      }),
    );
  const unavailable: string[] = [];
  await Promise.all(
    servers.map(async (server) => {
      try {
        const client = new McpClient({
          name: "Pet Studio",
          version: "1",
          requestTimeoutMs: 5000,
        });
        clients.push(client);
        live.set(client, server.name);
        const config = await access?.(server);
        const curated = server.name.startsWith("catalog:");
        if (
          curated &&
          (!config?.tools ||
            config.url !== server.url ||
            !server.url.startsWith("https://"))
        )
          throw Error("清单未授权");
        if (!live.has(client) || signal?.aborted) throw Error("工具已停用");
        const transport = /^https?:\/\//i.test(server.url)
          ? new StreamableHttpTransport({
              url: server.url,
              ...(curated
                ? {
                    headers: config?.key
                      ? { Authorization: "Bearer " + config.key }
                      : {},
                    fetch: (input: string | URL, init?: RequestInit) => {
                      if (String(input) !== server.url)
                        throw Error("未授权的工具地址");
                      return fetch(input, { ...init, redirect: "error" });
                    },
                  }
                : {}),
            })
          : new StdioTransport({
              command: server.url,
              args: server.args,
              inheritEnv: false,
              env: { PATH: process.env.PATH ?? "" },
              stderr: "pipe",
            });
        await client.connect(transport);
        for (const t of await client.listTools({ signal, timeoutMs: 5000 })) {
          if (
            curated &&
            (!config?.tools?.includes(t.name) ||
              (config.key && JSON.stringify(t).includes(config.key)))
          )
            continue;
          const suffix = createHash("sha256")
            .update(JSON.stringify([server.name, t.name]))
            .digest("hex")
            .slice(0, 12);
          const name =
            "mcp_" +
            t.name.replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 43) +
            "_" +
            suffix;
          grants.set(name, { server, tool: t.name });
          tools.push({
            name,
            label: config?.name ?? t.title ?? t.name,
            description: t.description ?? t.name,
            parameters: {
              ...t.inputSchema,
              type: "object",
              properties: t.inputSchema.properties ?? {},
            },
            execute: async (_id, args, signal) => {
              if (!live.has(client)) throw Error("工具已停用");
              const r = await client
                .callTool(t.name, args as Record<string, unknown>, {
                  signal,
                  timeoutMs: 30000,
                })
                .catch((e) => {
                  if (curated) throw Error("查询服务暂时不可用");
                  throw e;
                });
              const text =
                r.content
                  ?.map((c) =>
                    c.type === "text" ? c.text : "[非文字工具结果]",
                  )
                  .join("\n") ?? JSON.stringify(r.structuredContent ?? {});
              const safeText = config?.key
                ? text.replaceAll(config.key, "[已隐藏]")
                : text;
              return {
                content: [{ type: "text", text: limitResult(safeText) }],
                details: {},
                isError: r.isError === true,
              };
            },
          });
        }
      } catch {
        unavailable.push(server.name);
      }
    }),
  );
  return {
    tools: tools.sort((a, b) => a.name.localeCompare(b.name)),
    unavailable,
    grants,
    close,
  };
}
export function limitResult(text: string) {
  const chars = Array.from(text);
  return chars.length <= 8000
    ? text
    : chars.slice(0, 3999).join("") + "……" + chars.slice(-3999).join("");
}
export async function authorize(
  token: string,
  grant: Grant,
  args: unknown,
  signal?: AbortSignal,
) {
  if (signal?.aborted) return false;
  const cancel = () => {
    void hostCall("host.cancelApproval", { token }).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  try {
    return await hostCall<boolean>(
      "host.authorize",
      {
        token,
        grant,
        ticket: randomUUID(),
        summary:
          grant.server.name === "网页读取" && grant.tool === "web_read"
            ? grant.server.url
            : JSON.stringify(args).slice(0, 400),
      },
      122000,
    );
  } catch {
    return false;
  } finally {
    signal?.removeEventListener("abort", cancel);
  }
}

export function directory(tools: AgentTool[]) {
  const pending = new Map<string, AgentTool>();
  if (tools.length <= 10) return { initial: tools, pending };
  const rows = tools.map(
    (t) => t.name + " · " + t.description.split(/[。.!?\n]/u)[0].slice(0, 120),
  );
  const search: AgentTool = {
    name: "tool_search",
    label: t("step.toolSearch"),
    description: "按名字或关键词查找工具并载入完整说明。\n" + rows.join("\n"),
    parameters: {
      type: "object",
      properties: { query: { type: "string" } },
      required: ["query"],
    },
    execute: async (_id, args) => {
      const query = String((args as { query: string }).query)
        .trim()
        .toLowerCase();
      const matches = query
        ? tools
            .filter((t) =>
              (t.name + " " + t.label + " " + t.description)
                .toLowerCase()
                .includes(query),
            )
            .slice(0, 5)
        : [];
      matches.forEach((t) => pending.set(t.name, t));
      return {
        content: [
          {
            type: "text",
            text: limitResult(
              JSON.stringify(
                matches.map(({ name, description, parameters }) => ({
                  name,
                  description,
                  parameters,
                })),
              ),
            ),
          },
        ],
        details: {},
      };
    },
  };
  return { initial: [search], pending };
}
