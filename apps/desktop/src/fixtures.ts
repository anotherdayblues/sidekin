// Browser-preview states for screenshots and design review. Never used in
// the desktop app, where the real library is read through Tauri.
import type { Snapshot, Draft } from "./bridge.ts";
import { lang } from "./i18n.ts";

interface FixtureCopy {
  liziName: string;
  liziDesc: string;
  tuanziName: string;
  tuanziDesc: string;
  v1Summary: string;
  v2Summary: string;
  pillowWalk: string;
  stretch: string;
  ruleNightPillow: string;
  ruleMorning: string;
  ruleHourlyStretch: string;
  ruleRest: string;
  ruleDragWiggle: string;
  draft1Summary: string;
  draft1Wave: string;
  draft1Sip: string;
  draft1RuleClick: string;
  draft1RuleTea: string;
  draft2Summary: string;
  draft2RuleClick: string;
  draft2RuleYawn: string;
}

const COPY: Record<string, FixtureCopy> = {
  zh: {
    liziName: "栗子",
    liziDesc: "一只温暖的原创橘白小猫，安静陪伴，也会好奇地四处走走。",
    tuanziName: "团子",
    tuanziDesc: "示例数据：第二只伙伴，用来看列表。",
    v1Summary: "整点伸个懒腰",
    v2Summary: "晚上 11 点抱着枕头出来打哈欠",
    pillowWalk: "抱枕头出来",
    stretch: "伸懒腰",
    ruleNightPillow: "晚上抱枕头出来",
    ruleMorning: "早上打招呼",
    ruleHourlyStretch: "整点伸懒腰",
    ruleRest: "工作一小时提醒休息",
    ruleDragWiggle: "被拎起来挣扎",
    draft1Summary: "单击它就认真挥挥手，下午三点喝口水",
    draft1Wave: "认真挥手",
    draft1Sip: "喝口水",
    draft1RuleClick: "单击就挥手",
    draft1RuleTea: "下午三点喝口水",
    draft2Summary: "单击它改成跳一下，晚上 10 点伸个懒腰",
    draft2RuleClick: "单击就跳一下",
    draft2RuleYawn: "晚上十点伸懒腰",
  },
  en: {
    liziName: "Lizi",
    liziDesc: "A warm orange-and-white kitten who keeps quiet company and wanders curiously.",
    tuanziName: "Tuanzi",
    tuanziDesc: "Sample companion to preview the roster.",
    v1Summary: "Stretch on the hour",
    v2Summary: "Walk out with a pillow and yawn at 11 PM",
    pillowWalk: "Pillow walk",
    stretch: "Stretch",
    ruleNightPillow: "Bring pillow at night",
    ruleMorning: "Morning greeting",
    ruleHourlyStretch: "Hourly stretch",
    ruleRest: "Break reminder after 1h",
    ruleDragWiggle: "Wiggle when picked up",
    draft1Summary: "Wave on click, sip water at 3 PM",
    draft1Wave: "Warm wave",
    draft1Sip: "Sip water",
    draft1RuleClick: "Wave on click",
    draft1RuleTea: "Water break at 3 PM",
    draft2Summary: "Jump on click, stretch at 10 PM",
    draft2RuleClick: "Jump on click",
    draft2RuleYawn: "Stretch at 10 PM",
  },
  "zh-TW": {
    liziName: "栗子",
    liziDesc: "一隻溫暖的原創橘白小貓，安靜陪伴，也會好奇地四處走走。",
    tuanziName: "糰子",
    tuanziDesc: "範例資料：第二隻夥伴，用來預覽清單。",
    v1Summary: "整點伸個懶腰",
    v2Summary: "晚上 11 點抱著枕頭出來打哈欠",
    pillowWalk: "抱枕頭出來",
    stretch: "伸懶腰",
    ruleNightPillow: "晚上抱枕頭出來",
    ruleMorning: "早上打招呼",
    ruleHourlyStretch: "整點伸懶腰",
    ruleRest: "工作一小時提醒休息",
    ruleDragWiggle: "被拎起來掙扎",
    draft1Summary: "點一下就認真揮揮手，下午三點喝口水",
    draft1Wave: "認真揮手",
    draft1Sip: "喝口水",
    draft1RuleClick: "點一下就揮手",
    draft1RuleTea: "下午三點喝口水",
    draft2Summary: "點一下改成跳一下，晚上 10 點伸個懶腰",
    draft2RuleClick: "點一下就跳一下",
    draft2RuleYawn: "晚上十點伸懶腰",
  },
  ja: {
    liziName: "くり",
    liziDesc: "あたたかい茶白の子猫。そばで静かに見守りながら、ときどき好奇心たっぷりに歩き回ります。",
    tuanziName: "モチ",
    tuanziDesc: "一覧プレビュー用の2匹目の相棒。",
    v1Summary: "毎時0分に伸びをする",
    v2Summary: "23時に枕を抱えてあくびする",
    pillowWalk: "枕を抱えて歩く",
    stretch: "伸びをする",
    ruleNightPillow: "夜に枕を持って登場",
    ruleMorning: "朝のあいさつ",
    ruleHourlyStretch: "毎時0分の伸び",
    ruleRest: "1時間ごとに休憩リマインド",
    ruleDragWiggle: "つまみ上げられたらバタバタ",
    draft1Summary: "クリックで手を振り、15時に水を飲む",
    draft1Wave: "しっかり手を振る",
    draft1Sip: "ひとくち水を飲む",
    draft1RuleClick: "クリックで手を振る",
    draft1RuleTea: "15時の水分補給",
    draft2Summary: "クリックをジャンプに変更、22時に伸びをする",
    draft2RuleClick: "クリックでジャンプ",
    draft2RuleYawn: "22時に伸びをする",
  },
  ko: {
    liziName: "밤톨이",
    liziDesc: "따뜻한 치즈 태비 아기 고양이. 조용히 곁을 지키다가 가끔 호기심 가득하게 돌아다녀요.",
    tuanziName: "모찌",
    tuanziDesc: "목록 미리보기용 두 번째 친구예요.",
    v1Summary: "정각마다 기지개 켜기",
    v2Summary: "밤 11시에 베개 안고 나와 하품하기",
    pillowWalk: "베개 안고 나오기",
    stretch: "기지개 켜기",
    ruleNightPillow: "밤에 베개 들고 나오기",
    ruleMorning: "아침 인사하기",
    ruleHourlyStretch: "정각 기지개",
    ruleRest: "1시간 집중 후 휴식 알림",
    ruleDragWiggle: "집어 올리면 버둥대기",
    draft1Summary: "클릭하면 반갑게 손 흔들고 오후 3시에 물 마시기",
    draft1Wave: "반갑게 손 흔들기",
    draft1Sip: "물 한 모금",
    draft1RuleClick: "클릭하면 손 흔들기",
    draft1RuleTea: "오후 3시 물 마시기",
    draft2Summary: "클릭을 점프로 바꾸고 밤 10시에 기지개 켜기",
    draft2RuleClick: "클릭하면 점프",
    draft2RuleYawn: "밤 10시 기지개",
  },
};

const c = COPY[lang] ?? COPY.zh;

const lizi = {
  id: "lizi",
  displayName: c.liziName,
  description: c.liziDesc,
  spriteVersionNumber: 2,
  spritesheetPath: "spritesheet.webp",
  fingerprint: "demo",
  revision: "1",
};
const tuanzi = {
  ...lizi,
  id: "tuanzi",
  displayName: c.tuanziName,
  description: c.tuanziDesc,
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
        { version: 1, summary: c.v1Summary, acceptedAt: 1793700000 },
        {
          version: 2,
          summary: c.v2Summary,
          acceptedAt: 1793800000,
        },
      ],
    },
    layer: {
      actions: {
        "pillow-walk": {
          label: c.pillowWalk,
          image: "",
          durations: [140, 140, 140, 140, 140, 140, 140, 220],
        },
        stretch: {
          label: c.stretch,
          image: "",
          durations: [160, 160, 200, 400, 160, 220],
        },
      },
      rules: [
        {
          id: "night-pillow",
          label: c.ruleNightPillow,
          when: { type: "clock", at: "23:00" },
          do: [{ play: "pillow-walk" }, { play: "waving", repeat: 2 }],
          chance: 0.6,
        },
        {
          id: "morning",
          label: c.ruleMorning,
          when: { type: "clock", at: "08:30", days: [1, 2, 3, 4, 5] },
          do: [{ play: "waving" }],
        },
        {
          id: "hourly-stretch",
          label: c.ruleHourlyStretch,
          when: { type: "clock", at: "*:00" },
          do: [{ play: "stretch" }],
        },
        {
          id: "rest",
          label: c.ruleRest,
          when: { type: "active", minutes: 60 },
          do: [{ play: "stretch" }, { play: "waving" }],
          cooldownMinutes: 30,
        },
        {
          id: "drag-wiggle",
          label: c.ruleDragWiggle,
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
  summary: c.draft1Summary,
  receivedAt: 1793819129,
  addedActions: ["hello-wave", "sip"],
  addedRules: ["click-wave", "tea-time"],
  removedActions: [],
  removedRules: [],
  preview: {
    actions: {
      ...learned.lizi.layer.actions,
      "hello-wave": {
        label: c.draft1Wave,
        image: "",
        durations: [140, 140, 140, 140, 140, 220],
      },
      sip: { label: c.draft1Sip, image: "", durations: [160, 160, 300, 160, 220] },
    },
    rules: [
      ...learned.lizi.layer.rules,
      {
        id: "click-wave",
        label: c.draft1RuleClick,
        when: { type: "event", event: "click" },
        do: [{ play: "hello-wave", repeat: 2 }, { play: "jumping" }],
      },
      {
        id: "tea-time",
        label: c.draft1RuleTea,
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
  summary: c.draft2Summary,
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
        label: c.draft2RuleClick,
        when: { type: "event", event: "click" },
        do: [{ play: "jumping" }],
      },
      {
        id: "ten-yawn",
        label: c.draft2RuleYawn,
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
