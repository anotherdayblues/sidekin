// 截屏识图 (plan/17 3.7): press the snip shortcut, drag a box around a
// chart, and ask the pet about it.
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

/** Four bars; their heights live in demo.css. */
const chart = (part = "chart") =>
  `<div class="demo-chart"><b>${t("demo.snip.chart")}</b><div data-part="${part}"><i></i><i></i><i></i><i></i></div></div>`;

export const snip: Demo = {
  id: "snip",
  length: 8500,
  captions: (c) => [
    { at: 0, text: t("demo.snip.step1", { key: c.label("vision") }) },
    { at: 1300, text: t("demo.snip.step2") },
    { at: 2800, text: t("demo.snip.step3") },
  ],
  stills: [2400, 3900, 7000],
  markup: (c) =>
    docWindow(chart()) +
    `<div class="demo-dim" data-part="dim"></div><i class="demo-marquee" data-part="marquee"></i>` +
    keycaps(c.keys("vision")) +
    petWithBubble(
      `<div class="demo-shot" data-part="shot-card">${chart("shot")}</div>` +
        piece.mine +
        piece.dots +
        piece.text +
        piece.compose(t("snip.askImage")),
      "chat",
    ),
  cues(c) {
    const { cues, at } = timeline();
    const up = pressKeys(at, c.keys("vision").length, 500);
    // ② The screen dims; drag a box around the chart.
    at(up + 50, (s) => {
      s.part("dim").dataset.show = "";
      const pointer = s.part("pointer");
      pointer.dataset.shape = "cross";
      pointer.dataset.show = "";
      s.pointAt(s.part("chart"), "start", 0);
    });
    at(1500, (s) => {
      s.box("marquee", s.part("chart"));
      s.part("marquee").dataset.show = "";
      s.part("pointer").dataset.drag = "";
    });
    at(1600, (s) => {
      s.part("marquee").dataset.grow = "";
      s.pointAt(s.part("chart"), "end", 1);
    });
    // ③ Let go: the shot lands in the bubble, ready for a question.
    at(2700, (s) => {
      delete s.part("dim").dataset.show;
      delete s.part("marquee").dataset.show;
      delete s.part("pointer").dataset.show;
      keysDone(s);
      hop(s);
      bubbleState(s, "input");
    });
    const sent = typeAndSend(at, t("demo.snip.ask"), 3300, 10);
    // Sent, the shot shrinks to a thumbnail beside the question.
    at(sent, (s) => (s.part("shot-card").dataset.sent = ""));
    const done = answer(at, t("demo.snip.reply"), sent + 700, 1400);
    at(done + 300, (s) => s.pet.play("jumping"));
    return cues;
  },
};
