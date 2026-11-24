import assert from "node:assert/strict";
import { test } from "node:test";
import { connectMcp, disconnectMcp } from "../../apps/brain/src/mcp.ts";

test("清单授权前零请求，启用后仅可查，停用后旧连接也不能继续", async (t) => {
  const server = {
    name: "catalog:fixture",
    url: "https://fixture.invalid/mcp",
    args: [],
  };
  const key = "fixture-secret-value";
  let calls = 0;
  t.mock.method(
    globalThis,
    "fetch",
    async (input: unknown, init: RequestInit = {}) => {
      calls++;
      assert.equal(String(input), server.url);
      assert.equal(init.redirect, "error");
      assert.equal(
        new Headers(init.headers).get("Authorization"),
        "Bearer " + key,
      );
      if (init.method !== "POST") return new Response(null, { status: 405 });
      const r = JSON.parse(String(init.body));
      if (r.id === undefined) return new Response(null, { status: 202 });
      const result =
        r.method === "initialize"
          ? {
              protocolVersion: r.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "fixture", version: "1" },
            }
          : r.method === "tools/list"
            ? {
                tools: ["lookup", "other"].map((name) => ({
                  name,
                  inputSchema: { type: "object", properties: {} },
                })),
              }
            : { content: [{ type: "text", text: "查到 " + key }] };
      return Response.json({ jsonrpc: "2.0", id: r.id, result });
    },
  );
  const refused = await connectMcp([server], undefined, async () => {
    throw Error("未启用");
  });
  assert.equal(calls, 0);
  await refused.close();
  const connected = await connectMcp([server], undefined, async () => ({
    url: server.url,
    tools: ["lookup"],
    name: "查询",
    key,
  }));
  try {
    assert.equal(connected.tools.length, 1);
    const result = await connected.tools[0].execute("a", {});
    assert.ok(!JSON.stringify(result).includes(key));
    assert.ok(!JSON.stringify([...connected.grants]).includes(key));
    await disconnectMcp(server.name);
    await assert.rejects(connected.tools[0].execute("b", {}), /停用/);
  } finally {
    await connected.close();
  }
});

test("只有原厂地址能够沿用聊天密钥", async () => {
  const { hasDirectSearch } =
    await import("../../apps/shared/searchServices.ts");
  assert.ok(hasDirectSearch("moonshotai", "https://api.moonshot.ai/v1/"));
  assert.ok(!hasDirectSearch("moonshotai", "https://api.moonshot.cn/v1"));
  assert.ok(!hasDirectSearch("custom", "https://api.moonshot.ai/v1"));
});
