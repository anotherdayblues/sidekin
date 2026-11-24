import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { RuleClock } from "../apps/desktop/src/teaching.ts";
import { createServer } from "vite";
import { chromium } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";

test("a taught pet-idle rule runs once per period, independent of computer input", () => {
  const clock = new RuleClock([
    {
      id: "read",
      label: "读书",
      when: { type: "pet-idle", minutes: 10 },
      do: [{ play: "read" }],
    },
  ]);
  assert.equal(clock.petIdle(600000, 1), null);
  assert.equal(clock.petIdle(600001, 1)?.id, "read");
  assert.equal(clock.petIdle(900000, 1), null);
  assert.equal(clock.petIdle(1500001, 900001)?.id, "read");
});

test("a time slot draws once, with the next threshold still available", () => {
  const rule = (id: string, minutes: number) => ({
    id,
    label: id,
    when: { type: "pet-idle" as const, minutes },
    do: [{ play: id }],
  });
  const clock = new RuleClock(
    [rule("sleep", 10), rule("read", 5), rule("paint", 5)],
    {},
    0,
    () => 0.9,
  );
  assert.equal(clock.petIdle(300001, 1)?.id, "paint");
  assert.equal(clock.petIdle(301001, 1), null);
  assert.equal(clock.petIdle(600001, 1)?.id, "sleep");
});

test("new pet sleeps with its supplied art, ignores outside activity and drag, wakes on click", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { port: 0, host: "127.0.0.1" },
    logLevel: "error",
  });
  await server.listen();
  try {
    const browser = await chromium.launch({ channel: "chrome" });
    try {
      const p = await browser.newPage();
      const atlas =
        "data:image/webp;base64," +
        readFileSync("examples/lizi/spritesheet.webp").toString("base64");
      const strip =
        "data:image/png;base64," +
        readFileSync("examples/lizi-sleep/actions/sleep.png").toString(
          "base64",
        );
      const event = await bubbleBridge(p, async (cmd, args) => {
        if (cmd === "get_state")
          return {
            pets: [
              {
                id: "fixture",
                sleepStrip: "sleep.png",
                fingerprint: "fixture",
              },
            ],
            custom: {
              fixture: {
                history: { current: 1 },
                layer: {
                  actions: {
                    read: {
                      label: "读书",
                      image: "",
                      loopFrames: [5, 12],
                      durations: Array(16).fill(100),
                    },
                  },
                  rules: [
                    {
                      id: "read-five",
                      label: "读书",
                      when: { type: "pet-idle", minutes: 5 },
                      do: [{ play: "read" }],
                    },
                  ],
                },
              },
            },
            drafts: [],
            settings: { activeId: "fixture", visible: true, behaviors: {} },
          };
        if (cmd === "read_action_image") return strip;
        if (cmd === "read_sprite") return args.sleep ? strip : atlas;
        if (cmd === "companion_settings") return { enabled: true };
        if (cmd.includes("menu")) return [1, "menu"];
        if (cmd === "list_reminders") return [];
        if (cmd === "system_idle_seconds") return 0;
        return null;
      });
      await p.clock.install();
      await p.goto(server.resolvedUrls!.local[0] + "?fixture");
      await p.evaluate(async () => {
        const { SpritePlayer } = await import("/src/player.ts");
        const original = SpritePlayer.prototype.addClips;
        SpritePlayer.prototype.addClips = function (c) {
          window.fixturePlayer = this;
          return original.call(this, c);
        };
        await (
          await import("/src/pet.ts")
        ).mountPet(document.querySelector("#app"));
      });
      await p.clock.fastForward(301000);
      assert.equal(
        await p.evaluate(() => window.fixturePlayer.requestedAction),
        "read",
      );
      await p.clock.runFor(1800);
      await p.clock.fastForward(299000);
      await p.clock.runFor(3500);
      assert.equal(
        await p.evaluate(() => window.fixturePlayer.requestedAction),
        "@sleep",
      );
      await event("companion-motion", { kind: "thinking" });
      await p.keyboard.type("typing elsewhere");
      const hitPoint = () =>
        p.evaluate(() => {
          const canvas = document.querySelector("canvas"),
            r = canvas.getBoundingClientRect();
          for (let y = 0.83; y < 0.96; y += 0.025)
            for (let x = 0.4; x < 0.65; x += 0.025)
              if (window.fixturePlayer.hit(x, y))
                return { x: r.left + r.width * x, y: r.top + r.height * y };
          throw Error("缺少可点击的睡姿");
        });
      const point = await hitPoint();
      await p.mouse.move(point.x, point.y);
      await p.mouse.down();
      await p.mouse.move(point.x + 20, point.y);
      await p.mouse.up();
      await p.clock.runFor(3500);
      assert.equal(
        await p.evaluate(() => window.fixturePlayer.sustaining),
        true,
      );
      const asleep = await hitPoint();
      await p.mouse.click(asleep.x, asleep.y);
      await p.clock.runFor(3500);
      assert.equal(
        await p.evaluate(() => window.fixturePlayer.sustaining),
        false,
      );
    } finally {
      await browser.close();
    }
  } finally {
    await server.close();
  }
});
