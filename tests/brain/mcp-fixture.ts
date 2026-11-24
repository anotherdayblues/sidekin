import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
export async function mcpFixture(count = 1) {
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }
    let raw = "";
    for await (const c of req) raw += c;
    const r = JSON.parse(raw);
    if (r.id === undefined) {
      res.writeHead(202);
      res.end();
      return;
    }
    const tools = Array.from({ length: count }, (_, i) => ({
      name: i ? "test_" + i : "badge",
      description: "读测试名牌",
      inputSchema: { type: "object", properties: {} },
    }));
    const result =
      r.method === "initialize"
        ? {
            protocolVersion: r.params.protocolVersion,
            capabilities: { tools: {} },
            serverInfo: { name: "fixture", version: "1" },
          }
        : r.method === "tools/list"
          ? { tools }
          : r.method === "tools/call"
            ? (calls.push(r.params.name),
              { content: [{ type: "text", text: "LZ-QA" }] })
            : {};
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ jsonrpc: "2.0", id: r.id, result }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return {
    config: {
      name: "fixture",
      url: "http://127.0.0.1:" + (server.address() as AddressInfo).port,
      args: [],
    },
    calls,
    close() {
      server.closeAllConnections();
      server.close();
    },
  };
}
