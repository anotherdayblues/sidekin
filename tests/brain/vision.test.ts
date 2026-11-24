import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeModel } from "./fake-model.ts";
import { launch } from "./client.ts";
import { fixtureImage } from "./live-gate.ts";
test("框选图片通过看图模型发送，文字模型要求去设置", async (t) => {
  const service = await fakeModel([{ chunks: ["测试图"] }]);
  t.after(service.close);
  const brain = launch();
  t.after(brain.close);
  const config = {
    apiKey: "test",
    service: "custom",
    baseUrl: service.baseUrl,
    model: "text",
    visionModel: "eyes",
    canSee: false,
  };
  await brain.request("initialize", config);
  assert.equal((await brain.request("visionInfo")).result.canSee, false);
  const prompt = { text: "这是什么？", image: await fixtureImage() };
  assert.equal((await brain.request("vision", prompt)).error.message, "vision");
  assert.equal(service.requests.length, 0);
  await brain.request("configure", { ...config, canSee: true });
  assert.equal((await brain.request("vision", prompt)).result.text, "测试图");
  const wire = service.requests[0].body;
  assert.equal(wire.model, "eyes");
  assert.equal(
    wire.messages.at(-1).content.find((v: any) => v.type === "image_url")
      .image_url.url,
    "data:image/png;base64," + prompt.image.data,
  );
});
