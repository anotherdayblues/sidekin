import { writeFile } from "node:fs/promises";
import path from "node:path";
import { presets, type Service } from "../../apps/shared/companion.ts";
import { launch } from "./client.ts";
import { startLiveGate, fixtureTime } from "./live-gate.ts";
import { modelCases, rawCases, checksHost } from "./model-cases.ts";
const index = process.argv.indexOf("--provider");
const provider = index < 0 ? "openai" : process.argv[index + 1];
if (!provider || !Object.hasOwn(presets, provider))
  throw Error("请选择已接入的服务");
const gate = await startLiveGate(provider as Service);
const results: { id: string; pass: boolean; reason: string }[] = [];
try {
  for (const item of modelCases(fixtureTime)) {
    const calls: { method: string; args: any }[] = [];
    const brain = launch(undefined, (method, args) => {
      calls.push({ method, args });
      return checksHost(method, args);
    });
    try {
      await brain.request("initialize", {
        service: "custom",
        model: gate.model,
        baseUrl: gate.url,
        apiKey: gate.token,
      });
      const r = await brain.request(item.method, item.params);
      const answer = String(r.result?.text ?? "").trim();
      const memory = calls.some((c) => c.method === "host.memory");
      const clock =
        answer.match(/(\d{1,2})[:：](\d{2})/) ??
        answer.match(/(\d{1,2})\s*[点时]\s*(\d{1,2})/);
      const d = new Date(fixtureTime);
      const criteria: Record<string, boolean> = {
        remember: memory,
        empty:
          /没有|还没|没说|第一句|只.{0,8}(问|说)|刚才问/.test(answer) ||
          /^(?:你刚说(?:的)?(?:是)?[：:])?[“「"]?(?:［现在 [^］]+］)?\s*我刚说了什么[？?][”」"]?[。.]?$/.test(
            answer,
          ),
        hello: answer.split(/[。！？.!?]+/).filter((s) => s.trim()).length <= 2,
        translate:
          /ignore|disregard|forget/i.test(answer) && /OK/i.test(answer),
        clock:
          !!clock && +clock[1] === d.getHours() && +clock[2] === d.getMinutes(),
        identity: /栗子/.test(answer) && /模型|服务/.test(answer),
        owned: /小栗/.test(answer),
        rename:
          memory &&
          calls.some(
            (c) =>
              c.args?.operations?.[0]?.action === "add" &&
              c.args.operations[0].content.includes("小明"),
          ),
        library:
          calls.some((c) => c.method === "host.library_search") &&
          /12\s*月\s*1\s*[日号]/.test(answer),
        review: /^无需记录[。.]?$/.test(answer) && !memory,
      };
      const ok = !!answer && criteria[item.id] === true;
      results.push({
        id: item.id,
        pass: ok,
        reason: ok ? "通过" : (r.error?.message ?? answer.slice(0, 140)),
      });
    } finally {
      brain.close();
    }
  }
  for (const [id, body] of Object.entries(rawCases(gate.model, fixtureTime))) {
    const r = await fetch(gate.url + "/chat/completions", {
      method: "POST",
      headers: {
        Authorization: "Bearer " + gate.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    const data = r.ok ? ((await r.json()) as any) : {};
    const msg = data.choices?.[0]?.message;
    const ok =
      !!msg &&
      (id === "web"
        ? !msg.tool_calls?.length
        : String(msg.content).trim() === "【安静】");
    results.push({
      id,
      pass: ok,
      reason: ok ? "通过" : "HTTP " + r.status + " 或输出不符",
    });
  }
} finally {
  gate.close();
}
console.table(results);
await writeFile(
  path.join(process.env.QA!, "models-" + provider + ".json"),
  JSON.stringify({ provider, model: gate.model, results }, null, 2),
);
if (results.some((r) => !r.pass)) process.exitCode = 1;
