import { test } from "node:test";
import assert from "node:assert/strict";
import { mcpFixture } from "./mcp-fixture.ts";
import { connectMcp } from "../../apps/brain/src/mcp.ts";
import { fakeModel } from "./fake-model.ts";
import { launch } from "./client.ts";
test("Pi beforeToolCall gates a real MCP call; denied calls never reach the service", async (t) => {
  const m = await mcpFixture();
  t.after(m.close);
  const catalog = await connectMcp([m.config]);
  const name = catalog.tools[0].name;
  await catalog.close();
  for (const allowed of [true, false]) {
    const model = await fakeModel([{ tool: name }, { chunks: ["完成"] }]);
    t.after(model.close);
    let checked = 0;
    const brain = launch(undefined, (method, p) => {
      assert.equal(method, "host.authorize");
      assert.equal(p.grant.tool, "badge");
      checked++;
      return allowed;
    });
    t.after(brain.close);
    await brain.request("initialize", {
      service: "custom",
      baseUrl: model.baseUrl,
      model: "fixture",
      apiKey: "test",
    });
    const before = m.calls.length;
    await brain.request("chat", {
      text: "读名牌",
      token: "turn",
      mcpServers: [m.config],
    });
    assert.equal(checked, 1);
    assert.equal(m.calls.length - before, allowed ? 1 : 0);
  }
});
