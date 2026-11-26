import { t } from "./i18n.ts";
import { petPointer } from "./petPointer.ts";
import { petMenus } from "./petMenu.ts";
import { petPreviews } from "./petPreview.ts";
import { loadMemory, saveMemory } from "./petMemory.ts";
import { companionIcons } from "./icons.ts";
import { petCompanionEvents } from "./petCompanionEvents.ts";
import { petSpeech } from "./petSpeech.ts";
import { getSettings, type CompanionSettings } from "./companion.ts";
import { statusAction } from "./animation.ts";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import liziSleep from "../../../examples/lizi-sleep/actions/sleep.png?url";
import sleepExample from "../../../examples/lizi-sleep/teaching.json";
import { SpritePlayer } from "./player.ts";
import {
  normalizeBehavior,
  RandomBehavior,
  resolvedPetState,
  GAZE_ACTIONS,
  HOVER_CYCLES,
  HOVER_DURATION_MULTIPLIER,
} from "./animation.ts";
import { DragMotion } from "./movement.ts";
import {
  ActivityTracker,
  EMPTY_LAYER,
  RuleClock,
  type Layer,
  type PetEvent,
  type Step,
} from "./teaching.ts";
import * as api from "./bridge.ts";
import { petFocus } from "./petFocus.ts";
import { mountDoze } from "./petDoze.ts";
import { petPhone } from "./petPhone.ts";
import { IDLE_FOCUS, type FocusState } from "./focus.ts";
import {
  activityClipName,
  defaultOutfitId,
  dragActionForFlip,
  enabledActivityIds,
  matchingActivitiesForOutfit,
  resolveManualOutfitId,
} from "./openpets/runtime.ts";
import {
  nextActivityOpportunityMs,
  selectIdlePetActivity,
} from "./openpets/vendor/pet-activity-policy.ts";
import { resolvePetActivityAnimation } from "./openpets/vendor/activities.ts";

const RULE_TICK_MS = 15_000;

export async function mountPet(root: HTMLElement) {
  root.innerHTML = `<canvas aria-label="${t("pet.label")}"></canvas><span class="pet-glasses" aria-hidden="true" hidden></span>`;
  const glasses = root.querySelector<HTMLElement>(".pet-glasses")!;
  glasses.textContent = companionIcons.glasses;
  const canvas = root.querySelector("canvas")!,
    player = new SpritePlayer(canvas),
    random = new RandomBehavior(),
    drag = new DragMotion();
  mountDoze(root);
  let snapshot = await api.state(),
    currentPet: api.Pet | undefined,
    loaded = "",
    effectiveOutfitId = defaultOutfitId,
    flipped = false,
    updateSeq = 0,
    visible = false,
    hovered = false,
    behavior = normalizeBehavior();
  let extensionAction: string | null = null;
  // Taught behavior: the active custom layer, its rules, and a running
  // sequence of steps (from a rule, an interaction, or a studio preview).
  let layer: Layer = EMPTY_LAYER,
    customKey = "",
    rulesPet = "",
    rules = new RuleClock([]),
    sequence: { steps: Step[]; index: number; source: string } | null = null,
    stepTimer: ReturnType<typeof setTimeout> | undefined,
    lastPetTouch = Date.now(),
    lastInput = Date.now();
  const activity = new ActivityTracker();
  let randomTimer: ReturnType<typeof setTimeout> | undefined;
  let activityTimer: ReturnType<typeof setTimeout> | undefined;
  let activityPetId = "";
  const activityLastPlayed = new Map<string, number>();
  let lastActivityId: string | null = null;
  const reduced = matchMedia("(prefers-reduced-motion: reduce)");
  let initial = await getSettings();
  let enabled = initial.enabled,
    vision = initial.vision,
    translation = initial.translation;
  let brainAction: string | null = null,
    streaming = false;
  // During a tomato the pet works at its desk (petFocus.ts).
  let focusBase: string | null = null,
    focusNow = (): FocusState => IDLE_FOCUS,
    phoneNow = () => false;
  // Where the bubble or chat panel wants the pet to look, in screen points:
  // the text caret while typing, the bubble itself while it answers.
  let bubbleAt: { x: number; y: number } | null = null,
    gazeUntil = 0;
  let gazeSource: string | undefined;
  await listen<{ x: number; y: number; typing: boolean; source?: string }>(
    "bubble-look",
    (e) => {
      bubbleAt = { x: e.payload.x, y: e.payload.y };
      gazeSource = e.payload.source;
      gazeUntil = Date.now() + 1500;
    },
  );
  await listen<string>("bubble-look-clear", ({ payload }) => {
    if (payload === gazeSource) {
      bubbleAt = null;
      gazeUntil = 0;
    }
  });
  const createMenu = petMenus(() => ({
    focus: focusNow(),
    phone: phoneNow(),
    enabled,
    clickOpensChat:
      behavior.clickAction === "open-studio" && !rules.find("click"),
    translation,
    snapshot,
  }));
  let contextMenu = await createMenu();
  await listen<CompanionSettings>("companion-settings", async (e) => {
    if (
      enabled === e.payload.enabled &&
      vision === e.payload.vision &&
      translation === e.payload.translation
    )
      return;
    vision = e.payload.vision;
    translation = e.payload.translation;
    enabled = e.payload.enabled;
    brainAction = null;
    streaming = false;
    const old = contextMenu;
    contextMenu = await createMenu();
    await old.close();
    sync();
  });
  const isPaused = () => snapshot.settings.paused || reduced.matches;
  function dragAction() {
    const rule = rules.find("drag");
    if (drag.action && rule) return rule.do[0].play!;
    return dragActionForFlip(drag.action, flipped);
  }
  let pendingIdle: { steps: Step[]; touchedAt: number } | null = null;
  const clickOnly = () => sequence?.source === "pet-idle" && player.sustaining;
  const sleepClip = () =>
    player.has("sleep") ? "sleep" : player.has("@sleep") ? "@sleep" : null;
  function sync() {
    if (clickOnly()) return;
    const base = focusBase === "sleep" ? sleepClip() : focusBase;
    if (player.sustaining) {
      const focusSleep = base === "sleep" || base === "@sleep";
      if (
        brainAction ||
        (!extensionAction && !drag.active && !sequence && !focusSleep)
      )
        player.endSustained();
      return;
    }
    const dragging = dragAction();
    const greeting =
      glasses.hidden && !brainAction && !focusBase && hovered && !rules.find("hover");
    const next = resolvedPetState(
      dragging,
      greeting,
      !glasses.hidden && brainAction !== "jumping"
        ? "idle"
        : (brainAction ?? extensionAction ?? base ?? "idle"),
    );
    player.setState(
      next,
      (drag.active && !!rules.find("drag")) || next === base,
      greeting && !dragging ? HOVER_CYCLES : undefined,
      greeting && !dragging ? HOVER_DURATION_MULTIPLIER : 1,
    );
    if (!GAZE_ACTIONS.includes(next)) player.setGaze(null);
    canvas.setAttribute(
      "aria-label",
      `${t("pet.label")} · ${drag.active ? t("pet.dragging") : ""}${next}`,
    );
  }
  function busy() {
    return (
      !visible ||
      isPaused() ||
      drag.active ||
      hovered ||
      !glasses.hidden ||
      !!brainAction ||
      !!extensionAction ||
      !!sequence ||
      !!focusBase
    );
  }
  function activityBusy() {
    return (
      busy() ||
      document.hidden ||
      player.sustaining ||
      streaming ||
      (bubbleAt !== null && Date.now() < gazeUntil)
    );
  }
  function runSequence(steps: Step[], source: string) {
    cancelSequence(source);
    clearTimeout(randomTimer);
    clearTimeout(activityTimer);
    activityTimer = undefined;
    sequence = { steps, index: 0, source };
    nextStep();
  }
  /** Stops the sequence; a finished preview restores accepted actions. */
  function cancelSequence(next = "") {
    clearTimeout(stepTimer);
    const wasPreview = sequence?.source === "preview";
    sequence = null;
    pendingIdle = null;
    if (wasPreview && next !== "preview") reloadCustom();
  }
  function nextStep() {
    if (!sequence) return;
    if (pendingIdle) {
      const pending = pendingIdle;
      cancelSequence();
      extensionAction = null;
      player.play("idle");
      // Show the shared standing pose before entering the next activity.
      stepTimer = setTimeout(() => {
        if (pending.touchedAt === lastPetTouch && visible && !isPaused())
          runSequence(pending.steps, "pet-idle");
        else schedule();
      }, 120);
      return;
    }
    const step = sequence.steps[sequence.index++];
    if (!step) {
      cancelSequence();
      extensionAction = null;
      player.play("idle");
      sync();
      random.reset();
      schedule();
      scheduleActivity();
      return;
    }
    if (step.wait) {
      extensionAction = null;
      player.play("idle");
      sync();
      stepTimer = setTimeout(nextStep, step.wait);
      return;
    }
    extensionAction = step.play!;
    player.playSteps(step.play!, step.repeat ?? 1);
    sync();
  }
  /** Runs the rule for an interaction; true when one replaced the default. */
  function interaction(event: PetEvent) {
    if (!rules.find(event)) return false;
    const rule = rules.event(event);
    saveMemory(rulesPet, rules.memory);
    if (rule) runSequence(rule.do, event);
    return true;
  }
  async function loadCustom(pet: api.Pet, outfitId = effectiveOutfitId) {
    const custom = snapshot.custom[pet.id];
    layer = custom?.layer ?? EMPTY_LAYER;
    const hasCustomSleep = !!layer.actions.sleep?.loopFrames;
    const wornOutfit =
      outfitId !== defaultOutfitId
        ? pet.wardrobe?.outfits.find((o) => o.id === outfitId)
        : undefined;
    const builtInSleep = Boolean(
      wornOutfit?.sleepStrip || pet.sleepStrip || pet.id === "lizi",
    );
    const scheduled = [...layer.rules];
    const napMinutes = behavior.napMinutes ?? 10;
    const atNapTime = scheduled.filter(
      (r) =>
        r.enabled !== false &&
        r.when.type === "pet-idle" &&
        r.when.minutes === napMinutes,
    );
    const mixInSleep =
      atNapTime.some(
        (r) => r.when.type === "pet-idle" && r.when.includeDefaultSleep,
      ) && !atNapTime.some((r) => r.do.some((s) => s.play === "sleep"));
    if ((hasCustomSleep || builtInSleep) && (!atNapTime.length || mixInSleep)) {
      scheduled.push({
        id: "@default-nap",
        label: t("pet.autoSleep"),
        when: { type: "pet-idle", minutes: napMinutes },
        do: [{ play: hasCustomSleep ? "sleep" : "@sleep" }],
      });
    }
    if (pet.id !== rulesPet) {
      rulesPet = pet.id;
      rules = new RuleClock(scheduled, loadMemory(pet.id));
    } else rules.rules = scheduled;
    const key = `${pet.id}:${pet.fingerprint}:${pet.revision ?? ""}:${pet.sleepStrip ?? ""}:${outfitId}:${wornOutfit?.sleepStrip ?? ""}:${custom?.history.current ?? 0}`;
    if (key === customKey) return;
    customKey = key;
    const entries = await Promise.all(
      Object.entries(layer.actions).map(
        async ([name, a]) =>
          [
            name,
            {
              ...a,
              url: await api.actionImage(pet.id, name),
            },
          ] as const,
      ),
    );
    const clips = Object.fromEntries(entries);
    if (!hasCustomSleep && builtInSleep)
      clips["@sleep"] = {
        label: t("pet.sleep"),
        image: "",
        durations: sleepExample.actions.sleep.durations,
        loopFrames: [5, 12],
        url:
          wornOutfit?.sleepStrip || pet.sleepStrip
            ? await api.sleepSprite(pet.id, outfitId)
            : liziSleep,
      };
    const matchedActivities = matchingActivitiesForOutfit(
      pet.activities,
      outfitId,
    );
    player.removeClipsExcept([
      ...Object.keys(clips),
      ...matchedActivities.map((m) => m.clipName),
    ]);
    await player.addClips(clips);
    if (matchedActivities.length > 0) {
      await Promise.allSettled(
        matchedActivities.map(async (matched) => {
          try {
            const url = await api.petAsset(
              pet.id,
              matched.animation.spritesheetPath,
            );
            if (currentPet?.id !== pet.id || effectiveOutfitId !== outfitId)
              return;
            await player.addClips({
              [matched.clipName]: {
                durations: matched.durations,
                url,
              },
            });
          } catch (err) {
            console.warn(
              `activity "${matched.activity.id}" failed to load`,
              err,
            );
          }
        }),
      );
    }
  }
  function reloadCustom() {
    const pet = snapshot.pets.find((p) => p.id === snapshot.settings.activeId);
    customKey = "";
    if (pet) loadCustom(pet, effectiveOutfitId).catch(console.error);
  }
  function scheduleActivity() {
    clearTimeout(activityTimer);
    activityTimer = undefined;
    const pet = currentPet;
    if (!pet?.activities?.length || activityBusy()) return;
    const enabledIds = enabledActivityIds(
      pet,
      snapshot.settings.petActivityPreferences,
    );
    if (enabledIds.length === 0) return;
    const hasPlayable = matchingActivitiesForOutfit(
      pet.activities,
      effectiveOutfitId,
    ).some(
      (m) => enabledIds.includes(m.activity.id) && player.has(m.clipName),
    );
    if (!hasPlayable) return;
    activityTimer = setTimeout(() => {
      activityTimer = undefined;
      runIdleActivity();
    }, nextActivityOpportunityMs(Math.random));
  }
  function runIdleActivity() {
    const pet = currentPet;
    if (!pet?.activities?.length || activityBusy()) return;
    const enabledIds = enabledActivityIds(
      pet,
      snapshot.settings.petActivityPreferences,
    );
    const eligible = matchingActivitiesForOutfit(
      pet.activities,
      effectiveOutfitId,
    )
      .filter((m) => player.has(m.clipName))
      .map((m) => m.activity);
    const picked = selectIdlePetActivity(
      eligible,
      enabledIds,
      activityLastPlayed,
      lastActivityId,
      Date.now(),
      Math.random,
    );
    if (!picked) {
      scheduleActivity();
      return;
    }
    const clipName = activityClipName(picked.id);
    activityLastPlayed.set(picked.id, Date.now());
    lastActivityId = picked.id;
    clearTimeout(randomTimer);
    extensionAction = clipName;
    player.play(clipName);
    sync();
  }
  async function tick() {
    const seconds = await api.idleSeconds().catch(() => null),
      now = Date.now(),
      use = activity.update(
        now,
        seconds === null ? now - lastInput : seconds * 1000,
      );
    if (
      player.sustaining &&
      sequence?.source === "idle" &&
      use.idleMs < RULE_TICK_MS * 2
    )
      player.endSustained();
    if (busy()) return;
    const rule = rules.due(now, use);
    saveMemory(rulesPet, rules.memory);
    if (rule) runSequence(rule.do, rule.when.type);
  }
  setInterval(() => {
    // While a tomato runs the pet works beside you: no naps or idle rules
    // until it is paused or over (then they come as before).
    if (!visible || isPaused() || drag.active || focusBase) return;
    if (
      sequence?.source !== "pet-idle" &&
      (sequence || !glasses.hidden || brainAction)
    )
      return;
    const rule = rules.petIdle(Date.now(), lastPetTouch);
    if (rule && player.has(rule.do[0]?.play ?? "idle")) {
      saveMemory(rulesPet, rules.memory);
      if (sequence?.source === "pet-idle") {
        pendingIdle = { steps: rule.do, touchedAt: lastPetTouch };
        if (!player.endSustained() && !extensionAction) {
          clearTimeout(stepTimer);
          nextStep();
        }
      } else runSequence(rule.do, "pet-idle");
    }
  }, 1000);
  setInterval(() => tick().catch(console.warn), RULE_TICK_MS);
  function schedule() {
    clearTimeout(randomTimer);
    if (busy()) return;
    const next = random.next(
      performance.now(),
      behavior,
      false,
      rules.randomWeights(),
    );
    if (next?.startsWith("rule:")) {
      const rule = rules.byId(next.slice(5));
      if (rule) runSequence(rule.do, "random");
      return;
    }
    if (next) {
      clearTimeout(activityTimer);
      activityTimer = undefined;
      extensionAction = next;
      player.play(next);
      sync();
      return;
    }
    if (random.deadline !== null)
      randomTimer = setTimeout(
        schedule,
        Math.max(30, random.deadline - performance.now()),
      );
  }
  player.onComplete = () => {
    if (sequence) {
      nextStep();
      return;
    }
    const hadExtension = extensionAction !== null;
    extensionAction = null;
    if (hadExtension || focusBase) sync();
    random.reset();
    schedule();
    scheduleActivity();
  };
  function hover(value: boolean) {
    if (value === hovered) return;
    hovered = value;
    // The 番茄钟 clock opens while the pointer rests on the pet (petFocus.ts).
    root.dispatchEvent(new CustomEvent("pet-hover", { detail: value }));
    if (player.sustaining) {
      if (!value && sequence?.source === "hover") player.endSustained();
      return;
    }
    if (sequence?.source !== "hover") {
      cancelSequence();
      extensionAction = null;
    }
    if (value) interaction("hover");
    random.reset();
    sync();
    schedule();
    scheduleActivity();
  }
  async function update(s: api.Snapshot) {
    const seq = ++updateSeq;
    snapshot = s;
    const pet = s.pets.find((p) => p.id === s.settings.activeId);
    currentPet = pet;
    if ((pet?.id ?? "") !== activityPetId) {
      activityPetId = pet?.id ?? "";
      activityLastPlayed.clear();
      lastActivityId = null;
    }
    behavior = normalizeBehavior(
      s.settings.behaviors[pet?.id ?? ""] ?? pet?.behavior,
    );
    const nextFlipped = Boolean(
      pet && s.settings.petHorizontalFlip?.[pet.id],
    );
    flipped = nextFlipped;
    player.setFlipped(flipped);
    const appeared = !!pet && s.settings.visible && !visible;
    visible = !!pet && s.settings.visible;
    clearTimeout(randomTimer);
    clearTimeout(activityTimer);
    activityTimer = undefined;
    pointer.stop();
    const wardrobePref = pet
      ? s.settings.petWardrobePreferences?.[pet.id]
      : undefined;
    const targetOutfitId = pet
      ? resolveManualOutfitId(pet.wardrobe, wardrobePref)
      : defaultOutfitId;
    const petKey = pet ? `${pet.id}:${pet.fingerprint}` : "";
    const prevPetKey = loaded.split(":").slice(0, 2).join(":");
    const key = pet ? `${petKey}:${pet.revision ?? ""}:${targetOutfitId}` : "";
    if (appeared || petKey !== prevPetKey) lastPetTouch = Date.now();
    if (!pet) {
      loaded = "";
      effectiveOutfitId = defaultOutfitId;
    } else if (key !== loaded) {
      loaded = key;
      cancelSequence();
      extensionAction = null;
      customKey = "";
      let resolvedOutfit = targetOutfitId;
      let loadedOutfit = false;
      if (targetOutfitId !== defaultOutfitId) {
        try {
          const outfitUrl = await api.sprite(pet.id, targetOutfitId);
          if (seq !== updateSeq) return;
          await player.load(outfitUrl);
          if (seq !== updateSeq) return;
          loadedOutfit = true;
        } catch (err) {
          console.warn(
            `outfit "${targetOutfitId}" failed to load, falling back to base`,
            err,
          );
          resolvedOutfit = defaultOutfitId;
        }
      }
      if (!loadedOutfit) {
        const baseUrl = await api.sprite(pet.id);
        if (seq !== updateSeq) return;
        await player.load(baseUrl);
        if (seq !== updateSeq) return;
      }
      effectiveOutfitId = resolvedOutfit;
    }
    if (pet) {
      await loadCustom(pet, effectiveOutfitId);
      if (seq !== updateSeq) return;
    }
    player.setReducedMotion(isPaused());
    player.setActive(visible && !document.hidden);
    sync();
    random.reset();
    schedule();
    scheduleActivity();
    if (appeared && !sequence) interaction("appear");
    if (visible && !document.hidden) pointer.poll();
  }
  const pointer = petPointer({
    canvas,
    player,
    drag,
    visible: () => visible && !document.hidden,
    paused: isPaused,
    clickOnly,
    hovered: () => hovered,
    sync,
    gaze: () => ({ bubbleAt, gazeUntil }),
    gazeAnchor: () => currentPet?.gazeAnchor,
    touch: () => {
      lastPetTouch = Date.now();
    },
    input: () => {
      lastInput = Date.now();
    },
    hover,
    begin: () => {
      cancelSequence();
      extensionAction = null;
      clearTimeout(randomTimer);
      clearTimeout(activityTimer);
      activityTimer = undefined;
      sync();
    },
    release: (clicked, moved, wake) => {
      sync();
      random.reset();
      schedule();
      scheduleActivity();
      if (clicked && moved) interaction("drop");
      if (
        clicked &&
        !moved &&
        (!wake || focusBase === "sleep") &&
        !interaction("click")
      ) {
        if (enabled && behavior.clickAction === "open-studio")
          void invoke("open_chat", { fromPet: true });
        else {
          // Before a model is set up, a click is just a little wave; a
          // double-click opens the settings page instead, and the third
          // click says so once (tips.rs).
          if (!enabled && api.native) void invoke("tips_pet_click");
          extensionAction =
            behavior.clickAction === "open-studio"
              ? "waving"
              : behavior.clickAction;
          player.play(extensionAction);
          sync();
        }
      }
    },
    double: () => {
      if (interaction("double-click")) return;
      if (!enabled) {
        // The settings page at 伙伴大脑, where the model is set up.
        api.showStudio();
        void emit("companion-open", false);
        return;
      }
      if (behavior.doubleClickAction) {
        extensionAction = behavior.doubleClickAction;
        player.play(extensionAction);
        sync();
      }
    },
    menu: async () => {
      const old = contextMenu;
      contextMenu = await createMenu();
      await old.close();
      return contextMenu;
    },
  });
  reduced.addEventListener("change", () => {
    player.setReducedMotion(isPaused());
    random.reset();
    schedule();
    scheduleActivity();
  });
  document.addEventListener("visibilitychange", () => {
    const canRun = visible && !document.hidden;
    player.setActive(canRun);
    if (!canRun) {
      clearTimeout(activityTimer);
      activityTimer = undefined;
      clearTimeout(randomTimer);
      pointer.stop();
      return;
    }
    random.reset();
    schedule();
    scheduleActivity();
    pointer.poll();
  });
  await petPreviews(
    player,
    () => ({ snapshot, rulesPet }),
    clickOnly,
    runSequence,
  );
  await listen<{ petId: string; activityId: string }>(
    "preview-activity",
    async ({ payload }) => {
      if (clickOnly() || !currentPet || currentPet.id !== payload.petId) return;
      const act = currentPet.activities?.find(
        (a) => a.id === payload.activityId,
      );
      if (!act) return;
      const anim = resolvePetActivityAnimation(act, effectiveOutfitId);
      if (!anim) return;
      const clipName = activityClipName(act.id);
      if (!player.has(clipName)) {
        try {
          const url = await api.petAsset(currentPet.id, anim.spritesheetPath);
          if (
            currentPet?.id !== payload.petId ||
            !resolvePetActivityAnimation(act, effectiveOutfitId)
          )
            return;
          const matched = matchingActivitiesForOutfit([act], effectiveOutfitId)[0];
          if (!matched) return;
          await player.addClips({
            [clipName]: { durations: matched.durations, url },
          });
        } catch (err) {
          console.warn(`activity preview "${act.id}" failed`, err);
          return;
        }
      }
      cancelSequence();
      clearTimeout(randomTimer);
      clearTimeout(activityTimer);
      activityTimer = undefined;
      extensionAction = clipName;
      player.play(clipName);
      sync();
    },
  );
  await listen<string>("play-action", (e) => {
    if (clickOnly()) return;
    cancelSequence();
    clearTimeout(activityTimer);
    activityTimer = undefined;
    extensionAction = e.payload;
    player.play(e.payload);
    sync();
  });
  function motion(kind: string) {
    if (!enabled || (kind === "streaming" && streaming)) return;
    streaming = kind === "streaming";
    brainAction = kind === "idle" ? null : statusAction({ kind });
    if (brainAction || streaming) {
      clearTimeout(activityTimer);
      activityTimer = undefined;
    } else {
      scheduleActivity();
    }
    sync();
    // Cursor polling owns the gaze direction, including while an answer streams.
  }
  /** Plays an action the brain picked, unless the user is handling the pet
   * or it is paused or hidden. Nothing is saved for later. */
  function act(name: string, sleep: boolean) {
    if (!visible || isPaused() || drag.active || hovered || clickOnly()) return;
    const clip = sleep && !player.has(name) ? "@sleep" : name;
    if (!player.has(clip)) return;
    // Sleep holds until a click, a drag or the next message, as a step of
    // its own so the "untouched for a while" rules leave it alone.
    if (sleep) return runSequence([{ play: clip }], "asked");
    cancelSequence();
    clearTimeout(activityTimer);
    activityTimer = undefined;
    extensionAction = clip;
    player.play(clip);
    sync();
  }
  await petCompanionEvents(
    canvas,
    glasses,
    sync,
    motion,
    () => brainAction,
    act,
  );
  await petSpeech(canvas);
  /** Runs the taught rule for `event` if there is one, else plays `action`:
   * the one-off reactions of 番茄钟 and 手机传文件. */
  function react(event: PetEvent | null, action: string | null) {
    if (clickOnly() || (event && interaction(event)) || !action) return;
    cancelSequence();
    clearTimeout(activityTimer);
    activityTimer = undefined;
    extensionAction = action;
    player.play(action);
    sync();
  }
  // 待办 (plan/27): a to-do done, and the pet waves.
  if (api.native) void listen("todo-done", () => react(null, "waving"));
  const focus = await petFocus(root, {
    shape: () => player.shape,
    image: () => player.image,
    setBase(action) {
      // Starting or stopping (pausing, ending) a tomato counts as time with
      // the pet: a nap comes 10 untouched minutes after, not at once.
      if (action !== focusBase) lastPetTouch = Date.now();
      focusBase = action;
      // A tomato starting wakes a napping pet (or stops another idle rule):
      // a sustained nap plays its waking frames, then the working pose.
      if (action && sequence?.source === "pet-idle" && !player.endSustained()) {
        cancelSequence();
        extensionAction = null;
      }
      if (!action) {
        schedule();
        scheduleActivity();
      } else {
        clearTimeout(activityTimer);
        activityTimer = undefined;
      }
      sync();
    },
    react,
  });
  focusNow = () => focus.state();
  const phone = await petPhone(canvas, (action) => react(null, action));
  phoneNow = phone.on;
  await api.changes((s) => {
    update(s).catch(console.error);
  });
  await update(snapshot);
}
