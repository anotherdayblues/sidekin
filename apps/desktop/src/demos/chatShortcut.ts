// 聊天快捷键 (plan/17 3.7): press the chat shortcut over any window, type,
// and the pet answers in its bubble.
import { t } from "../i18n.ts";
import type { Demo } from "./demoTypes.ts";
import {
  answer,
  bubbleState,
  docWindow,
  hop,
  keycaps,
  keysDone,
  petWithBubble,
  piece,
  pressKeys,
  timeline,
  typeAndSend,
} from "./demoParts.ts";

export const chatShortcut: Demo = {
  id: "chat-shortcut",
  length: 7500,
  captions: (c) => [
    {
      at: 0,
      text: c.label("chat")
        ? t("demo.chatShortcut.step1", { key: c.label("chat") })
        : t("demo.chatShortcut.step1Click"),
    },
    { at: 1500, text: t("demo.chatShortcut.step2") },
    { at: 2650, text: t("demo.chatShortcut.step3") },
  ],
  stills: [1200, 2300, 5200],
  markup: (c) =>
    docWindow(`<p class="demo-doc">${t("demo.chatShortcut.doc")}</p>`) +
    keycaps(c.keys("chat")) +
    petWithBubble(
      piece.mine + piece.dots + piece.text + piece.compose(),
      "chat",
    ),
  cues(c) {
    const { cues, at } = timeline();
    const up = pressKeys(at, c.keys("chat").length, 700);
    at(up + 50, (s) => {
      hop(s);
      bubbleState(s, "input");
    });
    at(up + 600, keysDone);
    const sent = typeAndSend(at, t("demo.chatShortcut.say"), 2000, 8);
    const done = answer(at, t("demo.chatShortcut.reply"), sent + 700, 1300);
    at(sent + 700, (s) => s.pet.play("waving"));
    at(done + 300, (s) => s.pet.play("jumping"));
    return cues;
  },
};
