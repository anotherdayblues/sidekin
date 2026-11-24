import assert from "node:assert/strict";
import { test } from "node:test";
import { fakeModel } from "./fake-model.ts";
import { launch } from "./client.ts";
import {
  petActionTool,
  type PetActionPick,
} from "../../apps/brain/src/petAction.ts";

const choices = [
  { name: "jumping", label: "跳跃" },
  { name: "dance", label: "跳舞" },
  { name: "sleep", label: "睡觉", sleep: true },
];

test("做动作：挑中的动作跟着回答返回，气泡显示“做动作”，列表进了工具说明", async (t) => {
  const server = await fakeModel([
    { tool: "pet_action", args: { action: "dance", reason: "feeling" } },
    { chunks: ["太好了！"] },
    { chunks: ["好的"] },
  ]);
  t.after(server.close);
  const brain = launch();
  t.after(brain.close);
  await brain.request("initialize", {
    apiKey: "fixture-secret",
    model: "fixture",
    baseUrl: server.baseUrl,
  });
  const reply = await brain.request("chat", {
    text: "我考上了！",
    petActions: choices,
  });
  assert.equal(reply.result.text, "太好了！");
  assert.deepEqual(reply.result.petAction, {
    action: "dance",
    reason: "feeling",
  });
  const steps = reply.events.filter((e: any) => e.method === "chat.steps");
  assert.equal(steps.at(-1).params.steps[0].label, "做动作");
  const tool = server.requests[0].body.tools.find(
    (x: any) => x.function.name === "pet_action",
  );
  assert.deepEqual(tool.function.parameters.properties.action.enum, [
    "jumping",
    "dance",
    "sleep",
  ]);
  assert.match(tool.function.description, /dance：跳舞/);

  // Without a list there is no tool and no action.
  const plain = await brain.request("chat", { text: "你好" });
  assert.equal(plain.result.petAction, undefined);
  assert.ok(
    !server.requests[2].body.tools?.some(
      (x: any) => x.function.name === "pet_action",
    ),
  );
});

test("做动作：只能选列表里的；自己表达不能睡；一次回答只做一个；定时任务只能是用户要求", async () => {
  const picks: PetActionPick[] = [];
  const tool = petActionTool(choices, false, (p) => picks.push(p));
  await assert.rejects(
    tool.execute("a", { action: "fly", reason: "asked" }),
    /没有这个动作/,
  );
  await assert.rejects(
    tool.execute("b", { action: "sleep", reason: "feeling" }),
    /睡/,
  );
  await tool.execute("c", { action: "sleep", reason: "asked" });
  await assert.rejects(
    tool.execute("d", { action: "jumping", reason: "asked" }),
    /已经做过/,
  );
  assert.deepEqual(picks, [{ action: "sleep", reason: "asked" }]);

  const scheduled = petActionTool(choices, true, () => {});
  assert.deepEqual((scheduled.parameters as any).properties.reason.enum, [
    "asked",
  ]);
  await assert.rejects(
    scheduled.execute("e", { action: "dance", reason: "feeling" }),
    /reason/,
  );
});
