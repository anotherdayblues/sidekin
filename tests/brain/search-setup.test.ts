import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { launch } from "./client.ts";

test("search connection checks use a fixed query and keep errors free of keys", async (t) => {
  let status = 200;
  const requests: { query: string | null; authorized: boolean }[] = [];
  const server = createServer((req, res) => {
    requests.push({
      query: new URL(req.url!, "http://localhost").searchParams.get("q"),
      authorized: req.headers.authorization === "Bearer fixture-search-key",
    });
    res.writeHead(status, { "content-type": "application/json" });
    res.end(
      status === 200 ? '{"results":[]}' : '{"error":"fixture-search-key"}',
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const b = launch();
  t.after(b.close);
  await b.request("initialize", {
    service: "custom",
    model: "unused",
    baseUrl: "",
    apiKey: "",
    hostClock: true,
    meterUsage: true,
    search: {
      provider: "searxng",
      baseUrl: "http://127.0.0.1:" + (server.address() as any).port,
      apiKey: "fixture-search-key",
    },
  });
  const good = await b.request("search_test", {
    query: "private-text-must-not-be-used",
  });
  assert.equal(good.result?.ok, true);
  assert.deepEqual(requests, [{ query: "随伴连接测试", authorized: true }]);
  status = 401;
  const denied = await b.request("search_test");
  assert.equal(denied.error?.message, "auth");
  assert.ok(!JSON.stringify(denied).includes("fixture-search-key"));
});
