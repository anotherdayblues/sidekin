import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { launch } from "./client.ts";
import { fakeModel } from "./fake-model.ts";
import { endpoint } from "../../apps/brain/src/connectionFetch.ts";

test("all model protocols and discovery reject redirects before forwarding credentials", async (t) => {
  let hits = 0;
  const other = createServer((req, res) => {
    hits++;
    req.resume();
    res.writeHead(401, { "content-type": "application/json" });
    res.end('{"error":{"message":"fixture"}}');
  });
  other.listen(0, "127.0.0.1");
  await once(other, "listening");
  const proxy = createServer((req, res) => {
    req.resume();
    res.writeHead(307, {
      location: "http://127.0.0.1:" + (other.address() as any).port + req.url,
    });
    res.end();
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(() => {
    proxy.closeAllConnections();
    proxy.close();
    other.closeAllConnections();
    other.close();
  });
  const b = launch();
  t.after(b.close);
  let first = true;
  for (const service of ["custom", "openai", "anthropic", "google"]) {
    const cfg = {
      service,
      model: "fixture-private",
      baseUrl: "http://127.0.0.1:" + (proxy.address() as any).port + "/v1",
      apiKey: "fixture-secret",
    };
    await b.request(first ? "initialize" : "configure", cfg);
    first = false;
    const r = await b.request("test");
    assert.equal(r.error?.message, "redirect", service);
    const list = await b.request("models");
    assert.equal(list.result?.error, "redirect", service);
    assert.equal(hits, 0);
  }
});
test("failed discovery is explicit; manual model names work; testing never uses a backup", async (t) => {
  const calls: any[] = [];
  let getStatus = 401,
    postStatus = 200;
  const service = createServer(async (req, res) => {
    let raw = "";
    for await (const part of req) raw += part;
    if (req.method === "GET") {
      res.writeHead(getStatus, { "content-type": "application/json" });
      res.end(
        getStatus === 200
          ? '{"data":[]}'
          : '{"error":{"message":"fixture-secret must never be echoed"}}',
      );
      return;
    }
    const body = JSON.parse(raw);
    calls.push(body.model);
    if (postStatus !== 200) {
      res.writeHead(postStatus, { "content-type": "application/json" });
      res.end('{"error":{"message":"fixture-secret"}}');
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(
      'data: {"id":"fixture","choices":[{"index":0,"delta":{"role":"assistant","content":"好"},"finish_reason":null}]}\n\ndata: {"id":"fixture","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n',
    );
  });
  service.listen(0, "127.0.0.1");
  await once(service, "listening");
  t.after(() => {
    service.closeAllConnections();
    service.close();
  });
  const backup = await fakeModel([{ chunks: ["backup"] }]);
  t.after(backup.close);
  const b = launch();
  t.after(b.close);
  await b.request("initialize", {
    service: "deepseek",
    apiKey: "fixture-secret",
    baseUrl: "http://127.0.0.1:" + (service.address() as any).port + "/v1",
    model: "manual-alias",
    fallbacks: [
      {
        model: "fixture",
        apiKey: "fixture",
        baseUrl: backup.baseUrl,
        service: "custom",
      },
    ],
  });
  const list = await b.request("models");
  assert.equal(list.result.error, "auth");
  assert.deepEqual(list.result.models, []);
  assert.ok(!JSON.stringify(list).includes("fixture-secret"));
  getStatus = 200;
  assert.deepEqual((await b.request("models")).result.models, []);
  assert.equal((await b.request("test")).result.model, "manual-alias");
  postStatus = 503;
  assert.equal((await b.request("test")).error.message, "server");
  assert.equal(backup.requests.length, 0);
  assert.deepEqual(calls, ["manual-alias", "manual-alias"]);
});
test("provider URL policy rejects remote HTTP and credentials in the URL", () => {
  for (const value of [
    "http://example.com",
    "https://user:password@example.com",
    "https://example.com?key=fixture",
    "https://example.com#secret",
  ])
    assert.throws(() => endpoint(value));
  for (const value of [
    "https://example.com/v1",
    "http://localhost:1234/v1",
    "http://127.0.0.1:1",
    "http://[::1]:1",
  ])
    assert.ok(endpoint(value));
});

test("simultaneous native Google and compatible requests keep their own endpoint", async (t) => {
  const origins: string[] = [];
  const server = async (label: string) => {
    const s = createServer((req, res) => {
      req.resume();
      origins.push(label);
      setTimeout(() => {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(
          '{"error":{"code":403,"message":"fixture refused","status":"PERMISSION_DENIED"}}',
        );
      }, 15);
    });
    s.listen(0, "127.0.0.1");
    await once(s, "listening");
    t.after(() => {
      s.closeAllConnections();
      s.close();
    });
    return "http://127.0.0.1:" + (s.address() as any).port + "/v1";
  };
  const { rawStream, modelFor } =
    await import("../../apps/brain/src/models.ts");
  const { normalizeContext } = await import("@earendil-works/pi-ai");
  const ctx = normalizeContext({
    messages: [{ role: "user", content: "固定测试", timestamp: 0 }],
  });
  const [google, custom] = await Promise.all([
    server("google"),
    server("custom"),
  ]);
  await Promise.all(
    [
      ["google", google],
      ["custom", custom],
    ].map(async ([service, baseUrl]) => {
      const model = modelFor({
        service: service as any,
        model: "fixture",
        baseUrl,
        apiKey: "fixture",
      });
      const stream = await rawStream(model, ctx, {
        apiKey: "fixture",
        maxRetries: 0,
      });
      const message = await stream.result();
      assert.ok(!message.errorMessage?.includes("COMPANION_ENDPOINT"));
    }),
  );
  assert.deepEqual(origins.sort(), ["custom", "google"]);
});
