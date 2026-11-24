import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { presets, type Service } from "../../apps/shared/companion.ts";
import { modelFor } from "../../apps/brain/src/models.ts";
import { launch } from "./client.ts";
test("全部服务经过实际 SDK 发送到预期路径，401 返回可显示的错误", async (t) => {
  const requests: { url: string; body: any; headers: any }[] = [];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const c of req) body += c;
    requests.push({
      url: req.url!,
      body: body && JSON.parse(body),
      headers: req.headers,
    });
    if (req.method === "GET") {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "available" }] }));
      return;
    }
    res.writeHead(401, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: "401 Unauthorized" } }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const brain = launch();
  t.after(brain.close);
  await brain.request("initialize", { apiKey: "" });
  for (const [service, [, url]] of Object.entries(presets)) {
    const path = new URL(url || "http://localhost/v1").pathname.replace(
      /\/$/,
      "",
    );
    const baseUrl =
      "http://127.0.0.1:" + (server.address() as AddressInfo).port + path;
    const cfg = {
      service,
      baseUrl,
      apiKey: service === "ollama" || service === "lmstudio" ? "" : "test-only",
      model: "manual",
      canSee: true,
      contextWindow: 8192,
    };
    assert.ok((await brain.request("configure", cfg)).result.ready);
    assert.deepEqual((await brain.request("models")).result.models, [
      "available",
    ]);
    const r = await brain.request("test");
    assert.equal(r.error?.message, "auth", service);
    const last = requests.at(-1)!;
    if (service === "google") {
      assert.match(last.url, /models\/manual:streamGenerateContent/);
      assert.ok(last.body.contents);
    } else if (service === "anthropic" || service.startsWith("minimax")) {
      assert.ok(last.url.startsWith(path + "/v1/messages"));
      assert.ok(last.body.messages);
    } else if (service === "openai") {
      assert.equal(last.url, path + "/responses");
      assert.ok(last.body.input);
    } else {
      assert.equal(last.url, path + "/chat/completions");
      assert.ok(last.body.messages);
    }
  }
  const model = modelFor({
    service: "openai",
    apiKey: "",
    baseUrl: "",
    model: "gpt-5.4-mini",
  });
  assert.ok(model.input.includes("image"));
  assert.ok(model.contextWindow > 32768);
});
