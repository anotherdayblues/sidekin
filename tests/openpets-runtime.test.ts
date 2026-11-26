import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { createServer } from "vite";
import { chromium } from "playwright";
import { bubbleBridge } from "../scripts/qa/window.ts";
import { gazeFrame, PetShape } from "../apps/desktop/src/animation.ts";
import {
  defaultOutfitId,
  resolveWornOutfitId,
  type WardrobeDefinition,
} from "../apps/desktop/src/openpets/vendor/wardrobe.ts";
import {
  resolvePetActivityAnimation,
  type PetActivity,
} from "../apps/desktop/src/openpets/vendor/activities.ts";
import {
  activityCooldownMs,
  nextActivityOpportunityMs,
  selectIdlePetActivity,
} from "../apps/desktop/src/openpets/vendor/pet-activity-policy.ts";
import {
  activityClipName,
  dragActionForFlip,
  enabledActivityIds,
  hasActiveOutfitSchedule,
  matchingActivitiesForOutfit,
  msUntilNextMinute,
  resolveGazeAnchor,
  resolveManualOutfitId,
} from "../apps/desktop/src/openpets/runtime.ts";

const hoodieWardrobe: WardrobeDefinition = {
  outfits: [
    { id: "pajamas", displayName: "Pajamas" },
    { id: "weekend", displayName: "Weekend" },
    { id: "holidays", displayName: "Holidays" },
  ],
  schedule: [
    { outfit: "holidays", when: { dates: { from: "12-15", to: "01-02" } } },
    { outfit: "pajamas", when: { time: { from: "22:00", to: "07:00" } } },
    { outfit: "weekend", when: { days: ["sat", "sun"] } },
  ],
};

const demoActivities: readonly PetActivity[] = [
  {
    id: "stretch",
    displayName: "Stretch",
    outfitId: "default",
    spritesheetPath: "activities/stretch.webp",
    frameCount: 8,
    fps: 4,
    outfitVariants: [
      {
        outfitId: "pajamas",
        spritesheetPath: "activities/stretch.pajamas.webp",
        frameCount: 8,
        fps: 4,
      },
    ],
  },
  {
    id: "wave-hello",
    displayName: "Wave Hello",
    outfitId: "default",
    spritesheetPath: "activities/wave-hello.webp",
    frameCount: 6,
    fps: 4,
    outfitVariants: [
      {
        outfitId: "weekend",
        spritesheetPath: "activities/wave-hello.weekend.webp",
        frameCount: 6,
        fps: 4,
      },
    ],
  },
];

test("wardrobe resolution respects always-wear, user schedule, creator schedule, and wrapping ranges", () => {
  // Normal weekday daytime -> default
  assert.equal(
    resolveWornOutfitId(hoodieWardrobe, undefined, new Date(2026, 3, 15, 14, 0)),
    defaultOutfitId,
  );
  // Midnight-wrapping pajamas rule (22:00..07:00)
  assert.equal(
    resolveWornOutfitId(hoodieWardrobe, undefined, new Date(2026, 3, 15, 22, 0)),
    "pajamas",
  );
  assert.equal(
    resolveWornOutfitId(hoodieWardrobe, undefined, new Date(2026, 3, 16, 6, 59)),
    "pajamas",
  );
  assert.equal(
    resolveWornOutfitId(hoodieWardrobe, undefined, new Date(2026, 3, 16, 7, 0)),
    defaultOutfitId,
  );
  // Year-wrapping holiday rule (12-15..01-02) takes precedence over pajamas
  assert.equal(
    resolveWornOutfitId(hoodieWardrobe, undefined, new Date(2026, 0, 1, 23, 0)),
    "holidays",
  );
  // Always-wear pin overrides schedule
  assert.equal(
    resolveWornOutfitId(
      hoodieWardrobe,
      { outfit: "weekend" },
      new Date(2026, 3, 15, 23, 0),
    ),
    "weekend",
  );
  // User-edited schedule overrides creator schedule
  assert.equal(
    resolveWornOutfitId(
      hoodieWardrobe,
      {
        schedule: [
          { outfit: "pajamas", when: { time: { from: "22:00", to: "07:00" } }, enabled: false },
        ],
      },
      new Date(2026, 3, 15, 23, 0),
    ),
    defaultOutfitId,
  );
  // Unknown outfit id in preference falls back cleanly
  assert.equal(
    resolveWornOutfitId(
      hoodieWardrobe,
      { outfit: "deleted-outfit" },
      new Date(2026, 3, 15, 14, 0),
    ),
    defaultOutfitId,
  );
});

test("wardrobe minute timer only arms for unpinned pets with active schedule rules", () => {
  assert.equal(hasActiveOutfitSchedule(undefined, undefined), false);
  assert.equal(hasActiveOutfitSchedule(hoodieWardrobe, undefined), true);
  assert.equal(
    hasActiveOutfitSchedule(hoodieWardrobe, { outfit: "pajamas" }),
    false,
  );
  assert.equal(
    hasActiveOutfitSchedule(hoodieWardrobe, {
      schedule: [
        { outfit: "pajamas", when: { time: { from: "22:00", to: "07:00" } }, enabled: false },
      ],
    }),
    false,
  );
  const wait = msUntilNextMinute(new Date(2026, 3, 15, 21, 59, 45, 250));
  assert.equal(wait, 14_800);
});

test("activity exact-outfit matching, preferences, cooldown, and no immediate repeat", () => {
  // Exact-outfit rule
  assert.equal(
    resolvePetActivityAnimation(demoActivities[0], "pajamas")?.spritesheetPath,
    "activities/stretch.pajamas.webp",
  );
  assert.equal(
    resolvePetActivityAnimation(demoActivities[1], "pajamas"),
    null,
  );
  const pajamaClips = matchingActivitiesForOutfit(demoActivities, "pajamas");
  assert.deepEqual(
    pajamaClips.map((c) => c.clipName),
    [activityClipName("stretch")],
  );
  assert.deepEqual(pajamaClips[0].durations, Array(8).fill(250));

  // Absent pref => all enabled; [] => all disabled; stale ids filtered
  assert.deepEqual(
    enabledActivityIds({ id: "hc", activities: demoActivities }, undefined),
    ["stretch", "wave-hello"],
  );
  assert.deepEqual(
    enabledActivityIds({ id: "hc", activities: demoActivities }, { hc: [] }),
    [],
  );
  assert.deepEqual(
    enabledActivityIds(
      { id: "hc", activities: demoActivities },
      { hc: ["stretch", "removed"] },
    ),
    ["stretch"],
  );

  // Cooldown & no immediate repeat
  assert.equal(nextActivityOpportunityMs(() => 0), 120_000);
  assert.equal(nextActivityOpportunityMs(() => 1), 240_000);
  const played = new Map<string, number>([["stretch", 1_000]]);
  // Immediately after stretch, only wave-hello is eligible
  assert.equal(
    selectIdlePetActivity(
      demoActivities,
      ["stretch", "wave-hello"],
      played,
      "stretch",
      10_000,
      () => 0,
    )?.id,
    "wave-hello",
  );
  // After cooldown passes, still avoids repeating lastActivityId when another is enabled
  assert.equal(
    selectIdlePetActivity(
      demoActivities,
      ["stretch", "wave-hello"],
      played,
      "stretch",
      1_000 + activityCooldownMs,
      () => 0,
    )?.id,
    "wave-hello",
  );
  // If only one activity is enabled, it can repeat once cooldown expires
  assert.equal(
    selectIdlePetActivity(
      demoActivities,
      ["stretch"],
      played,
      "stretch",
      1_000 + activityCooldownMs - 1,
      () => 0,
    ),
    null,
  );
  assert.equal(
    selectIdlePetActivity(
      demoActivities,
      ["stretch"],
      played,
      "stretch",
      1_000 + activityCooldownMs,
      () => 0,
    )?.id,
    "stretch",
  );
});

test("horizontal flip mirrors V2 gaze, drag actions, PetShape silhouette, and gazeAnchor", () => {
  // Gaze sectors mirror left/right while keeping up/down invariant
  assert.deepEqual(gazeFrame(0, -1, true), { row: 9, frame: 0 });
  assert.deepEqual(gazeFrame(0, 1, true), { row: 10, frame: 0 });
  assert.deepEqual(gazeFrame(1, 0, false), { row: 9, frame: 4 });
  assert.deepEqual(gazeFrame(1, 0, true), { row: 10, frame: 4 });
  assert.deepEqual(gazeFrame(-1, 0, true), { row: 9, frame: 4 });

  // Drag direction swap
  assert.equal(dragActionForFlip("running-left", false), "running-left");
  assert.equal(dragActionForFlip("running-left", true), "running-right");
  assert.equal(dragActionForFlip("running-right", true), "running-left");
  assert.equal(dragActionForFlip("idle", true), "idle");

  // gazeAnchor respects flip and defaults to center
  assert.deepEqual(resolveGazeAnchor({ width: 200, height: 220 }, undefined, true), {
    x: 100,
    y: 110,
  });
  assert.deepEqual(
    resolveGazeAnchor({ width: 200, height: 220 }, { x: 0.3, y: 0.4 }, false),
    { x: 60, y: 88 },
  );
  assert.deepEqual(
    resolveGazeAnchor({ width: 200, height: 220 }, { x: 0.3, y: 0.4 }, true),
    { x: 140, y: 88 },
  );

  // PetShape.mirrored flips reach/hold masks across X
  const alpha = new Uint8Array(10 * 10);
  alpha[5 * 10 + 1] = 255;
  const shape = PetShape.from(alpha, 10, 0, 0, 10, 10)!;
  const mirrored = shape.mirrored();
  assert.equal(shape.hit(0.15, 0.55), true);
  assert.equal(mirrored.hit(0.85, 0.55), true);
  assert.equal(mirrored.hit(0.05, 0.55), false);
});

test("unified pet runtime: minute-boundary outfit swap, ref-counted sheet release, fallback, flip, exact-outfit activities, and hidden pause", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { port: 0, host: "127.0.0.1" },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    const baseAtlas =
      "data:image/webp;base64," +
      readFileSync("examples/lizi/spritesheet.webp").toString("base64");
    const strip =
      "data:image/png;base64," +
      readFileSync("examples/lizi-sleep/actions/sleep.png").toString("base64");
    // Distinct valid URL for the pajamas outfit (add whitespace-safe data URL param so take/letGo treats it as a separate sheet).
    const pajamasAtlas =
      "data:image/webp;charset=pajamas;base64," +
      readFileSync("examples/lizi/spritesheet.webp").toString("base64");

    const spriteCalls: Array<{ id: string; outfit?: string }> = [];
    const assetCalls: Array<{ petId: string; path: string }> = [];
    let failBrokenOutfit = true;

    const pet = {
      id: "hoodie-cat-demo",
      displayName: "Hoodie Cat",
      description: "Demo",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.webp",
      fingerprint: "fp1",
      revision: "1",
      gazeAnchor: { x: 0.35, y: 0.42 },
      wardrobe: {
        outfits: [
          { id: "pajamas", displayName: "Pajamas", spritesheetPath: "outfits/pajamas.webp" },
          { id: "broken", displayName: "Broken", spritesheetPath: "outfits/broken.webp" },
        ],
        schedule: [
          { outfit: "pajamas", when: { time: { from: "22:00", to: "07:00" } } },
        ],
      },
      activities: demoActivities,
    };
    let currentState: Record<string, unknown> = {
      pets: [pet],
      custom: {},
      drafts: [],
      settings: {
        activeId: "hoodie-cat-demo",
        visible: true,
        paused: false,
        size: 160,
        position: null,
        behaviors: {},
      },
    };

    const event = await bubbleBridge(page, async (cmd, args) => {
      if (cmd === "get_state") return currentState;
      if (cmd === "read_sprite") {
        spriteCalls.push({ id: args.id, outfit: args.outfit });
        if (args.outfit === "pajamas") return pajamasAtlas;
        if (args.outfit === "broken" && failBrokenOutfit) {
          throw new Error("missing outfit image");
        }
        return baseAtlas;
      }
      if (cmd === "read_pet_asset") {
        assetCalls.push({ petId: args.petId, path: args.path });
        return strip;
      }
      if (cmd === "companion_settings") return { enabled: true };
      if (cmd === "focus_state") {
        return {
          phase: "idle",
          endsAt: 0,
          length: 0,
          pausedLeft: null,
          round: 0,
          longBreak: false,
          settings: { focusMinutes: 25, breakMinutes: 5, ambient: "", volume: 0 },
          week: [],
          now: 0,
        };
      }
      if (cmd.includes("menu")) return [1, "menu"];
      if (cmd === "list_reminders") return [];
      if (cmd === "system_idle_seconds") return 0;
      return null;
    });

    // Start 10 seconds before 22:00 local time
    const startTime = new Date(2026, 3, 15, 21, 59, 50, 0).getTime();
    await page.clock.install({ time: startTime });
    await page.goto(server.resolvedUrls!.local[0] + "?fixture");

    await page.evaluate(async () => {
      const { SpritePlayer, heldSheets } = await import("/src/player.ts");
      (window as any).heldSheets = heldSheets;
      (window as any).shapeEvents = 0;
      const root = document.querySelector("#app")!;
      root.addEventListener("pet-shape", () => {
        (window as any).shapeEvents++;
      });
      const origLoad = SpritePlayer.prototype.load;
      SpritePlayer.prototype.load = function (url) {
        (window as any).fixturePlayer = this;
        return origLoad.call(this, url);
      };
      await (await import("/src/pet.ts")).mountPet(root as HTMLElement);
    });

    // At 21:59:50: wearing default atlas + both default-matched activities loaded
    assert.equal(spriteCalls.at(-1)?.outfit, undefined);
    assert.equal(
      await page.evaluate(() => ({
        hasStretch: (window as any).fixturePlayer.has("activity:stretch"),
        hasWave: (window as any).fixturePlayer.has("activity:wave-hello"),
      })).then((r) => r.hasStretch && r.hasWave),
      true,
    );

    const shapesBefore = await page.evaluate(() => (window as any).shapeEvents);

    // Crossing 22:00:00 does NOT auto-swap (pure manual outfit switching)
    await page.clock.fastForward(11_000);
    assert.equal(spriteCalls.at(-1)?.outfit, undefined);

    // User manually selects pajamas -> switches outfit & exact-outfit activities immediately!
    currentState = {
      ...currentState,
      settings: {
        ...(currentState.settings as Record<string, unknown>),
        petWardrobePreferences: { "hoodie-cat-demo": { outfit: "pajamas" } },
      },
    };
    await event("library-changed", currentState);
    await page.waitForFunction(
      () =>
        (window as any).fixturePlayer.has("activity:stretch") &&
        !(window as any).fixturePlayer.has("activity:wave-hello"),
    );
    assert.equal(spriteCalls.at(-1)?.outfit, "pajamas");
    assert.ok(
      assetCalls.some((c) => c.path === "activities/stretch.pajamas.webp"),
      "loads pajama variant for stretch",
    );
    assert.ok(
      (await page.evaluate(() => (window as any).shapeEvents)) > shapesBefore,
      "recomputes PetShape (and triggers petTint) on outfit swap",
    );
    // Ref-counted sheets: old base atlas + old activity strips dropped!
    // Held sheets = 1 pajamas atlas + 1 shared strip data URL = 2 (no leak of old base atlas!).
    const sheetsAfterSwap = await page.evaluate(() => (window as any).heldSheets());
    assert.equal(sheetsAfterSwap, 2, "old base atlas was unloaded via letGo()");

    // Exact-outfit preview check while in pajamas:
    // wave-hello has NO pajamas variant -> skipped cleanly!
    await event("preview-activity", {
      petId: "hoodie-cat-demo",
      activityId: "wave-hello",
    });
    assert.equal(
      await page.evaluate(() => (window as any).fixturePlayer.requestedAction),
      "idle",
    );
    // stretch HAS pajamas variant -> plays on demand, then settles back to idle!
    await event("preview-activity", {
      petId: "hoodie-cat-demo",
      activityId: "stretch",
    });
    assert.equal(
      await page.evaluate(() => (window as any).fixturePlayer.requestedAction),
      "activity:stretch",
    );
    await page.clock.runFor(2_500);
    assert.equal(
      await page.evaluate(() => (window as any).fixturePlayer.requestedAction),
      "idle",
      "activity settles back to idle after completing",
    );

    // Idle activity scheduler triggers automatically when idle (within 120s..240s)
    await page.clock.fastForward(245_000);
    assert.equal(
      await page.evaluate(() => (window as any).fixturePlayer.requestedAction),
      "activity:stretch",
      "idle policy triggers exact-outfit activity automatically",
    );
    await page.clock.runFor(2_500);
    assert.equal(
      await page.evaluate(() => (window as any).fixturePlayer.requestedAction),
      "idle",
    );

    // Flip horizontally via state update -> player.flipped becomes true, DOM overlays stay unmirrored
    currentState = {
      ...currentState,
      settings: {
        ...(currentState.settings as Record<string, unknown>),
        petHorizontalFlip: { "hoodie-cat-demo": true },
      },
    };
    await event("library-changed", currentState);
    await page.waitForFunction(() => (window as any).fixturePlayer.flipped === true);
    const flipCheck = await page.evaluate(() => {
      const p = (window as any).fixturePlayer;
      p.setGaze({ x: 100, y: 0 }); // right -> mirrored sector (row 10, frame 4)
      const pose = p.pose();
      const glasses = document.querySelector<HTMLElement>(".pet-glasses")!;
      return {
        flipped: p.flipped,
        pose,
        glassesTransform: getComputedStyle(glasses).transform,
      };
    });
    assert.equal(flipCheck.flipped, true);
    assert.deepEqual(flipCheck.pose, { row: 10, frame: 4 });
    assert.equal(flipCheck.glassesTransform, "none");

    // Broken outfit gracefully falls back to base atlas without breaking pet
    currentState = {
      ...currentState,
      settings: {
        ...(currentState.settings as Record<string, unknown>),
        petWardrobePreferences: { "hoodie-cat-demo": { outfit: "broken" } },
      },
    };
    await event("library-changed", currentState);
    await page.waitForFunction(() =>
      (window as any).fixturePlayer.has("activity:wave-hello"),
    );
    assert.equal(spriteCalls.at(-1)?.outfit, undefined, "fell back to base atlas");

    // Occlusion / document.hidden safeguard pauses and resumes seamlessly
    const visibilityResult = await page.evaluate(() => {
      const p = (window as any).fixturePlayer;
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      const whenHidden = p.active;
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => false,
      });
      document.dispatchEvent(new Event("visibilitychange"));
      const whenVisible = p.active;
      return { whenHidden, whenVisible };
    });
    assert.equal(visibilityResult.whenHidden, false);
    assert.equal(visibilityResult.whenVisible, true);
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("per-outfit sleepStrip loads on outfit switch and refreshes when patched in place", async () => {
  const server = await createServer({
    root: "apps/desktop",
    configLoader: "runner",
    server: { port: 0, host: "127.0.0.1" },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    const baseAtlas =
      "data:image/webp;base64," +
      readFileSync("examples/lizi/spritesheet.webp").toString("base64");
    const pajamasAtlas =
      "data:image/webp;charset=pajamas;base64," +
      readFileSync("examples/lizi/spritesheet.webp").toString("base64");
    const baseSleep =
      "data:image/png;charset=base;base64," +
      readFileSync("examples/lizi-sleep/actions/sleep.png").toString("base64");
    const pajamasSleep =
      "data:image/png;charset=pajamas;base64," +
      readFileSync("examples/lizi-sleep/actions/sleep.png").toString("base64");

    const sleepCalls: Array<{ id: string; sleep?: boolean; outfit?: string }> =
      [];

    let pet = {
      id: "lizi",
      displayName: "Lizi",
      description: "Sleep test",
      spriteVersionNumber: 2,
      spritesheetPath: "spritesheet.webp",
      sleepStrip: "sleep.png",
      fingerprint: "fp-lizi",
      revision: "1",
      wardrobe: {
        outfits: [
          {
            id: "moon-pajamas",
            displayName: "Moon Pajamas",
            spritesheetPath: "outfits/moon-pajamas.webp",
          } as { id: string; displayName: string; spritesheetPath: string; sleepStrip?: string },
        ],
        schedule: [],
      },
    };
    let currentState: Record<string, unknown> = {
      pets: [pet],
      custom: {},
      drafts: [],
      settings: {
        activeId: "lizi",
        visible: true,
        paused: false,
        size: 160,
        position: null,
        behaviors: {},
      },
    };

    const event = await bubbleBridge(page, async (cmd, args) => {
      if (cmd === "get_state") return currentState;
      if (cmd === "read_sprite") {
        if (args.sleep) {
          sleepCalls.push({
            id: args.id,
            sleep: args.sleep,
            outfit: args.outfit,
          });
          return args.outfit === "moon-pajamas" &&
            pet.wardrobe.outfits[0].sleepStrip
            ? pajamasSleep
            : baseSleep;
        }
        return args.outfit === "moon-pajamas" ? pajamasAtlas : baseAtlas;
      }
      if (cmd === "companion_settings") return { enabled: true };
      if (cmd === "focus_state") {
        return {
          phase: "idle",
          endsAt: 0,
          length: 0,
          pausedLeft: null,
          round: 0,
          longBreak: false,
          settings: {
            focusMinutes: 25,
            breakMinutes: 5,
            ambient: "",
            volume: 0,
          },
          week: [],
          now: 0,
        };
      }
      if (cmd.includes("menu")) return [1, "menu"];
      if (cmd === "list_reminders") return [];
      if (cmd === "system_idle_seconds") return 0;
      return null;
    });

    await page.goto(server.resolvedUrls!.local[0] + "?fixture");
    await page.evaluate(async () => {
      const { SpritePlayer } = await import("/src/player.ts");
      const origLoad = SpritePlayer.prototype.load;
      SpritePlayer.prototype.load = function (url) {
        (window as any).fixturePlayer = this;
        return origLoad.call(this, url);
      };
      await (await import("/src/pet.ts")).mountPet(
        document.querySelector("#app") as HTMLElement,
      );
    });

    // Initially on default outfit: calls read_sprite without outfit arg
    assert.deepEqual(sleepCalls, [{ id: "lizi", sleep: true, outfit: undefined }]);

    // Switch to moon-pajamas (no outfit sleepStrip yet -> still requests with outfit, Rust falls back to base)
    currentState = {
      ...currentState,
      settings: {
        ...(currentState.settings as Record<string, unknown>),
        petWardrobePreferences: { lizi: { outfit: "moon-pajamas" } },
      },
    };
    await event("library-changed", currentState);
    await page.waitForFunction(
      () =>
        (window as any).fixturePlayer.url?.includes("charset=pajamas") &&
        (window as any).fixturePlayer.has("@sleep"),
    );
    assert.equal(sleepCalls.length, 2);
    assert.deepEqual(sleepCalls[1], {
      id: "lizi",
      sleep: true,
      outfit: "moon-pajamas",
    });

    // Patch sleepStrip onto the currently worn moon-pajamas WITHOUT changing fingerprint or outfitId
    pet = {
      ...pet,
      wardrobe: {
        ...pet.wardrobe,
        outfits: [
          {
            ...pet.wardrobe.outfits[0],
            sleepStrip: "outfits/moon-pajamas-sleep.png",
          },
        ],
      },
    };
    currentState = { ...currentState, pets: [pet] };
    await event("library-changed", currentState);
    await page.waitForFunction(() => {
      const clip = (window as any).fixturePlayer.clips?.get("@sleep");
      return clip?.url?.includes("charset=pajamas");
    });
    assert.equal(sleepCalls.length, 3, "reloaded @sleep when outfit sleepStrip was patched in place");
    assert.deepEqual(sleepCalls[2], {
      id: "lizi",
      sleep: true,
      outfit: "moon-pajamas",
    });
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("resolveManualOutfitId stays purely manual and ignores creator schedules", () => {
  assert.equal(resolveManualOutfitId(hoodieWardrobe, undefined), defaultOutfitId);
  assert.equal(
    resolveManualOutfitId(hoodieWardrobe, { outfit: "pajamas" }),
    "pajamas",
  );
  assert.equal(
    resolveManualOutfitId(hoodieWardrobe, { outfit: "deleted-outfit" }),
    defaultOutfitId,
  );
  assert.equal(resolveManualOutfitId(undefined, { outfit: "pajamas" }), defaultOutfitId);
});

test("redesigned right-pane wardrobe preserves stage height, never covers pet, supports delete, and keeps + pure", async () => {
  const root = new URL("../apps/desktop", import.meta.url).pathname;
  const server = await createServer({
    root,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });
  await server.listen();
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    browser = await chromium.launch({ channel: "chrome" });
    const page = await browser.newPage({ viewport: { width: 1080, height: 840 } });
    await page.addInitScript(() => {
      localStorage.setItem("suiby-lang", "zh");
    });
    await page.goto(server.resolvedUrls!.local[0]);
    await page.waitForSelector(".studio");

    // Seed two pets: lizi (with 1 outfit) and otter (no outfits yet), native skin day mode
    await page.evaluate(async () => {
      const api = await import("/src/bridge.ts");
      api.setBrowserState({
        pets: [
          {
            id: "lizi",
            displayName: "栗子",
            description: "一只温暖的原创橘白小猫",
            spriteVersionNumber: 2,
            spritesheetPath: "spritesheet.webp",
            fingerprint: "lizi-fp",
            revision: "1",
            wardrobe: {
              outfits: [
                {
                  id: "moon-pajamas",
                  displayName: "月牙睡衣",
                  spritesheetPath: "outfits/moon-pajamas.webp",
                },
              ],
              schedule: [
                {
                  outfit: "moon-pajamas",
                  when: { time: { from: "22:00", to: "07:00" } },
                },
              ],
            },
          },
          {
            id: "otter",
            displayName: "小台长",
            description: "喜欢捣鼓旧电视的小水獭",
            spriteVersionNumber: 2,
            spritesheetPath: "spritesheet.webp",
            fingerprint: "otter-fp",
            revision: "1",
          },
        ],
        settings: {
          activeId: "lizi",
          visible: true,
          paused: false,
          size: 160,
          position: null,
          behaviors: {},
          skin: "native",
          theme: "day",
        },
        drafts: [],
        custom: {},
      });
    });

    await page.waitForSelector('html[data-skin="native"]');
    await page.waitForSelector("#wardrobe-key:not([hidden])");
    await page.waitForSelector(".tape-tile");

    // 1. Measure baseline stage height & zero deck scroll BEFORE opening wardrobe
    const before = await page.evaluate(() => {
      const win = document.querySelector("#window")!.getBoundingClientRect();
      const deck = document.querySelector(".deck")!;
      return {
        winH: Math.round(win.height),
        deckScroll: deck.scrollHeight - deck.clientHeight,
        triggerText: document.querySelector("#wardrobe-key-label")?.textContent ?? "",
      };
    });
    assert.equal(before.deckScroll, 0, "deck has zero vertical scroll");
    assert.equal(before.triggerText, "衣柜 · 原装", "manual-only defaults to 原装 despite schedule");

    // 2. Open right-pane wardrobe: stage height untouched and 0px overlap with #window
    await page.click("#wardrobe-key");
    await page.waitForSelector("#wardrobe-pane:not([hidden])");
    const afterOpen = await page.evaluate(() => {
      const win = document.querySelector("#window")!.getBoundingClientRect();
      const pane = document.querySelector("#wardrobe-pane")!.getBoundingClientRect();
      const deck = document.querySelector(".deck")!;
      const overlapX = Math.max(0, Math.min(win.right, pane.right) - Math.max(win.left, pane.left));
      const overlapY = Math.max(0, Math.min(win.bottom, pane.bottom) - Math.max(win.top, pane.top));
      return {
        winH: Math.round(win.height),
        deckScroll: deck.scrollHeight - deck.clientHeight,
        overlapArea: overlapX * overlapY,
        cardCount: document.querySelectorAll("#wardrobe-pane .outfit-card").length,
        hasScheduleUi: !!document.querySelector(".wardrobe-schedule-card, .schedule-row"),
      };
    });
    assert.equal(afterOpen.winH, before.winH, "opening wardrobe never shrinks #window");
    assert.equal(afterOpen.deckScroll, 0, "deck still has zero scroll");
    assert.equal(afterOpen.overlapArea, 0, "wardrobe pane never covers pet stage");
    assert.equal(afterOpen.cardCount, 2, "shows 原装 + 月牙睡衣");
    assert.equal(afterOpen.hasScheduleUi, false, "no schedule UI clutter");

    // 3. Click 月牙睡衣 to wear it live
    await page.click('#wardrobe-pane .outfit-card[aria-label="月牙睡衣"]');
    await page.waitForFunction(
      () => document.querySelector("#wardrobe-key-label")?.textContent === "衣柜 · 月牙睡衣",
    );

    // 4. Arm inline delete and delete 月牙睡衣 -> seamlessly falls back to 原装 + calm empty state
    await page.click('#wardrobe-pane .outfit-del');
    await page.waitForSelector(".wardrobe-confirm");
    await page.click(".wardrobe-confirm-delete");
    await page.waitForSelector(".wardrobe-empty");
    const afterDelete = await page.evaluate(() => ({
      triggerText: document.querySelector("#wardrobe-key-label")?.textContent ?? "",
      emptyAttr: document.querySelector("#wardrobe-key")?.getAttribute("data-empty"),
    }));
    assert.equal(afterDelete.triggerText, "衣柜");
    assert.equal(afterDelete.emptyAttr, "true");

    // 5. Close via back button -> Home Cards return
    await page.click(".wardrobe-back");
    await page.waitForSelector("#wardrobe-pane", { state: "hidden" });

    // 6. Verify bottom-left + menu has ZERO dress-pet items
    await page.click("#add");
    await page.waitForSelector("#pop:not([hidden])");
    const addItems = await page.evaluate(() =>
      [...document.querySelectorAll("#pop .pop-item")].map((el) => el.textContent ?? ""),
    );
    assert.equal(
      addItems.some((txt) => txt.includes("新衣服")),
      false,
      "+ menu must stay pure pet-addition only",
    );
  } finally {
    await browser?.close();
    await server.close();
  }
});

test("website Pet.sleep() and wake() treat 1-based loopFrames [5, 12] identically to desktop SpritePlayer", async () => {
  const server = await createServer({
    root: "apps/website",
    configLoader: "runner",
    server: { port: 0, host: "127.0.0.1" },
    logLevel: "error",
  });
  await server.listen();
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage();
    await page.addInitScript({ content: "globalThis.__name=(f)=>f" });
    await page.clock.install();
    await page.goto(server.resolvedUrls!.local[0]);
    const trace = await page.evaluate(async () => {
      const { Pet } = await import("/src/pet.ts");
      const pet = new Pet(192, {
        sheet: "/pets/lizi-sheet.webp",
        sleep: {
          url: "/pets/lizi-pajamas-sleep.webp",
          durations: Array(16).fill(100),
          loop: [5, 12],
        },
      });
      document.body.append(pet.el);
      const seenSleep: number[] = [];
      const seenWake: number[] = [];
      let phase: "sleep" | "wake" = "sleep";
      const origFrame = (pet as any).frame.bind(pet);
      (pet as any).frame = (
        url: string,
        sheetW: number,
        col: number,
        row: number,
      ) => {
        if (url.includes("sleep")) {
          if (phase === "sleep") seenSleep.push(col);
          else seenWake.push(col);
        }
        return origFrame(url, sheetW, col, row);
      };
      (window as any).__webPet = {
        pet,
        seenSleep,
        seenWake,
        setWake: () => (phase = "wake"),
      };
      pet.sleep();
      return true;
    });
    assert.equal(trace, true);
    // 14 frames: settle 0..3 -> hold 4..11 -> wrap 4, 5
    await page.clock.runFor(1300);
    await page.evaluate(() => {
      (window as any).__webPet.setWake();
      (window as any).__webPet.pet.wake();
    });
    await page.clock.runFor(400);
    const result = await page.evaluate(() => ({
      seenSleep: (window as any).__webPet.seenSleep,
      seenWake: (window as any).__webPet.seenWake,
      doing: (window as any).__webPet.pet.doing,
    }));
    assert.deepEqual(
      result.seenSleep,
      [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 4, 5],
      "1-based loopFrames [5, 12] must loop 0-based f04..f11 and never include f12",
    );
    assert.deepEqual(
      result.seenWake,
      [12, 13, 14, 15],
      "wake() must start at 0-based f12 (1-based #13) through f15",
    );
    assert.equal(result.doing, "idle");
  } finally {
    await browser.close();
    await server.close();
  }
});
