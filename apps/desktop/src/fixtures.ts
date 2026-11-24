// Browser-preview states for screenshots and design review. Never used in
// the desktop app, where the real library is read through Tauri.
import type { Snapshot, Draft } from "./bridge.ts";

const lizi = {
  id: "lizi",
  displayName: "栗子",
  description: "一只温暖的原创橘白小猫，安静陪伴，也会好奇地四处走走。",
  spriteVersionNumber: 2,
  spritesheetPath: "spritesheet.webp",
  fingerprint: "demo",
  revision: "1",
};
const tuanzi = {
  ...lizi,
  id: "tuanzi",
  displayName: "团子",
  description: "示例数据：第二只伙伴，用来看列表。",
  fingerprint: "demo-2",
};
const settings: Snapshot["settings"] = {
  activeId: "lizi",
  visible: true,
  paused: false,
  size: 160,
  position: null,
  behaviors: {},
  theme: "day",
};
const learned: Snapshot["custom"] = {
  lizi: {
    history: {
      current: 2,
      versions: [
        { version: 1, summary: "整点伸个懒腰", acceptedAt: 1793700000 },
        {
          version: 2,
          summary: "晚上 11 点抱着枕头出来打哈欠",
          acceptedAt: 1793800000,
        },
      ],
    },
    layer: {
      actions: {
        "pillow-walk": {
          label: "抱枕头出来",
          image: "",
          durations: [140, 140, 140, 140, 140, 140, 140, 220],
        },
        stretch: {
          label: "伸懒腰",
          image: "",
          durations: [160, 160, 200, 400, 160, 220],
        },
      },
      rules: [
        {
          id: "night-pillow",
          label: "晚上抱枕头出来",
          when: { type: "clock", at: "23:00" },
          do: [{ play: "pillow-walk" }, { play: "waving", repeat: 2 }],
          chance: 0.6,
        },
        {
          id: "morning",
          label: "早上打招呼",
          when: { type: "clock", at: "08:30", days: [1, 2, 3, 4, 5] },
          do: [{ play: "waving" }],
        },
        {
          id: "hourly-stretch",
          label: "整点伸懒腰",
          when: { type: "clock", at: "*:00" },
          do: [{ play: "stretch" }],
        },
        {
          id: "rest",
          label: "工作一小时提醒休息",
          when: { type: "active", minutes: 60 },
          do: [{ play: "stretch" }, { play: "waving" }],
          cooldownMinutes: 30,
        },
        {
          id: "drag-wiggle",
          label: "被拎起来挣扎",
          when: { type: "event", event: "drag" },
          do: [{ play: "jumping" }],
        },
      ],
    },
  },
};
/** What each fixture version holds, so going back can be previewed. */
export const VERSION_LAYERS: Record<
  string,
  Snapshot["custom"][string]["layer"]
> = {
  "lizi:1": {
    actions: { stretch: learned.lizi.layer.actions.stretch },
    rules: learned.lizi.layer.rules.filter((r) => r.id === "hourly-stretch"),
  },
  "lizi:2": learned.lizi.layer,
};
export const DRAFT: Draft = {
  id: "1793819129-28d9b8c4",
  petId: "lizi",
  summary: "单击它就认真挥挥手，下午三点喝口水",
  receivedAt: 1793819129,
  addedActions: ["hello-wave", "sip"],
  addedRules: ["click-wave", "tea-time"],
  removedActions: [],
  removedRules: [],
  preview: {
    actions: {
      ...learned.lizi.layer.actions,
      "hello-wave": {
        label: "认真挥手",
        image: "",
        durations: [140, 140, 140, 140, 140, 220],
      },
      sip: { label: "喝口水", image: "", durations: [160, 160, 300, 160, 220] },
    },
    rules: [
      ...learned.lizi.layer.rules,
      {
        id: "click-wave",
        label: "单击就挥手",
        when: { type: "event", event: "click" },
        do: [{ play: "hello-wave", repeat: 2 }, { play: "jumping" }],
      },
      {
        id: "tea-time",
        label: "下午三点喝口水",
        when: { type: "clock", at: "15:00" },
        do: [{ play: "sip" }],
      },
    ],
  },
};
/** A second draft that also changes the click habit (for overlap notes). */
export const DRAFT_2: Draft = {
  id: "1793819999-5f3a9c10",
  petId: "lizi",
  summary: "单击它改成跳一下，晚上 10 点伸个懒腰",
  receivedAt: 1793819999,
  addedActions: [],
  addedRules: ["click-wave", "ten-yawn"],
  removedActions: [],
  removedRules: [],
  preview: {
    actions: learned.lizi.layer.actions,
    rules: [
      ...learned.lizi.layer.rules,
      {
        id: "click-wave",
        label: "单击就跳一下",
        when: { type: "event", event: "click" },
        do: [{ play: "jumping" }],
      },
      {
        id: "ten-yawn",
        label: "晚上十点伸懒腰",
        when: { type: "clock", at: "22:00" },
        do: [{ play: "stretch" }],
      },
    ],
  },
};
export const FIXTURES: Record<string, Snapshot> = {
  empty: {
    pets: [],
    settings: { ...settings, activeId: null, visible: false },
    drafts: [],
    custom: {},
  },
  fresh: {
    pets: [lizi],
    settings,
    drafts: [],
    custom: {},
  },
  full: {
    pets: [lizi, tuanzi],
    settings,
    drafts: [DRAFT],
    custom: learned,
  },
  two: {
    pets: [lizi, tuanzi],
    settings,
    drafts: [DRAFT, DRAFT_2],
    custom: learned,
  },
  learned: {
    pets: [lizi, tuanzi],
    settings,
    drafts: [],
    custom: learned,
  },
};
