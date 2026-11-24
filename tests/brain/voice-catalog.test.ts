import test from "node:test";
import assert from "node:assert/strict";
import { voiceCatalog } from "../../apps/brain/src/speech/catalog.ts";
const base = { baseUrl: "", apiKey: "", resourceId: "", model: "" };
test("presets match the model and do not need credentials", async () => {
  const draft = { ...base, provider: "aliyun" as const };
  const result = await voiceCatalog(draft);
  assert.ok(
    result.voices.some((v) => v.name === "龙安洋" && v.id === "longanyang"),
  );
  assert.equal(
    (await voiceCatalog({ ...draft, model: "unknown" })).voices.length,
    0,
  );
  assert.ok(
    (await voiceCatalog({ ...base, provider: "volcengine" })).voices.some(
      (v) => v.name === "Vivi 2.0",
    ),
  );
});
test("ElevenLabs follows pages and MiniMax lists account voices", async () => {
  let pages = 0;
  const result = await voiceCatalog(
    { ...base, provider: "elevenlabs", apiKey: "test" },
    async (url, init) => {
      assert.equal(new Headers(init?.headers).get("xi-api-key"), "test");
      if (pages++)
        assert.equal(
          new URL(String(url)).searchParams.get("next_page_token"),
          "two",
        );
      return Response.json({
        voices: [{ voice_id: "id" + pages, name: "Name" + pages }],
        has_more: pages === 1,
        next_page_token: "two",
      });
    },
  );
  assert.deepEqual(
    result.voices.map((v) => v.name),
    ["Name1", "Name2"],
  );
  const mini = await voiceCatalog(
    { ...base, provider: "minimax", apiKey: "test" },
    async () =>
      Response.json({
        base_resp: { status_code: 0 },
        system_voice: [{ voice_id: "1", voice_name: "系统" }],
        voice_cloning: [{ voice_id: "2", description: ["我的声音"] }],
      }),
  );
  assert.deepEqual(
    mini.voices.map((v) => v.name),
    ["系统", "我的声音"],
  );
});
