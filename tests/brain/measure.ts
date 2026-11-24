// macOS: run after building both binaries. Output the raw observations in run order.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { resolve } from "node:path";
import { launch } from "./client.ts";
import { fakeModel } from "./fake-model.ts";

const targets = ["sea", "bun"] as const;
const rounds = 7;
const server = await fakeModel(
  Array.from({ length: rounds * targets.length }, () => ({ chunks: ["pong"] })),
);
const rss = (pid: number) =>
  (Number(
    execFileSync("ps", ["-o", "rss=", "-p", String(pid)], {
      encoding: "utf8",
    }).trim(),
  ) *
    1024) /
  1e6;
const samples: Record<
  string,
  { readyMs: number; idleMB: number; afterChatMB: number }[]
> = { sea: [], bun: [] };
try {
  for (let round = 0; round < rounds; round++) {
    for (const runtime of round % 2 ? [...targets].reverse() : targets) {
      const exe = resolve(
        "runs/brain-stage0/packages",
        runtime + ".app/Contents/MacOS/companion-brain",
      );
      const start = performance.now();
      const brain = launch(exe);
      try {
        const init = await brain.request("initialize", {
          model: "fixture",
          baseUrl: server.baseUrl,
          apiKey: "fixture",
        });
        const readyMs = performance.now() - start;
        assert.ok(init.result.ready);
        await sleep(1500);
        const idleMB = rss(brain.pid);
        assert.equal(
          (await brain.request("chat", { text: "ping" })).result.text,
          "pong",
        );
        await sleep(1500);
        samples[runtime].push({ readyMs, idleMB, afterChatMB: rss(brain.pid) });
      } finally {
        brain.close();
      }
    }
  }
} finally {
  server.close();
}
console.log(JSON.stringify(samples, null, 2));
