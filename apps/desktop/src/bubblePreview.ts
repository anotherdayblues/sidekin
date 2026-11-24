// The bubble outside the app (browser preview and screenshot scripts):
// `window.__studio.bubble(state, theme, skin, side, x)` shows one state with
// fixture text. Not used in the app itself.
import { applySkin, type Skin } from "./skin.ts";
import { errorText } from "./errorText.ts";
import type { Notice } from "./reminders.ts";
import type { ApprovalRequest } from "./bubbleApproval.ts";
import type { MemoryReceipt } from "./bubbleReceipt.ts";

export interface PreviewBubble {
  shell: HTMLElement;
  input: HTMLTextAreaElement;
  original: HTMLDetailsElement;
  originalText: HTMLElement;
  note: HTMLElement;
  action: HTMLElement;
  pick: (q: string) => HTMLElement;
  thread: {
    reset(): void;
    append(turn: { question: string; answer: string }): void;
  };
  showMine(text: string): void;
  reset(): void;
  state(s: string): void;
  paint(): void;
  error(code: string): void;
  drawNotices(items: Notice[]): void;
  showRemembered(receipt: MemoryReceipt | null): void;
  openRequest(request: ApprovalRequest): void;
  setVisible(text: string): void;
  setMode(mode: "chat" | "translate" | "vision"): void;
  /** plan/41: the language a translation went into, and where it came from. */
  translated(into: string, target: number): void;
  clearApproval(): void;
  tip(id: string, alone: boolean): void;
  focus(phase: "done" | "rested"): void;
  phone: {
    qr(s: {
      running: boolean;
      qr?: string;
      url?: string;
      firstTime?: boolean;
    }): void;
    linked(device: string): void;
    ask(o: {
      id: string;
      device: string;
      files: { name: string; size: number }[];
      text?: string | null;
    }): void;
    received(text: string, link: string | null): void;
  };
}

/** A stand-in QR code for screenshots: a fixed pattern of squares. */
function fakeQr() {
  let seed = 7,
    cells = "";
  for (let y = 0; y < 25; y++)
    for (let x = 0; x < 25; x++) {
      seed = (seed * 9301 + 49297) % 233280;
      const finder = ((x < 7 || x > 17) && y < 7) || (x < 7 && y > 17);
      const on = finder
        ? x % 6 === 0 ||
          y % 6 === 0 ||
          (x % 6 > 1 && x % 6 < 5 && y % 6 > 1 && y % 6 < 5)
        : seed / 233280 > 0.52;
      if (on) cells += `<rect x="${x}" y="${y}" width="1" height="1"/>`;
    }
  return `<svg viewBox="0 0 25 25" fill="currentColor">${cells}</svg>`;
}

const fixtureText: Record<string, string> = {
  answer: "我在这里。",
  streaming: "我刚看到你的消息，",
  authorization: "同意这次请求吗？",
  reminder: "该喝水了。",
  error: errorText.network,
  long: "这是较长的回答。\n".repeat(14),
};

export function previewBubble(b: PreviewBubble) {
  Object.assign(window, {
    __studio: {
      bubble: async (
        s: string,
        theme = "day",
        skin: Skin = "studio",
        side: "above" | "below" = "above",
        x?: number,
      ) => {
        await applySkin(skin);
        b.shell.dataset.side = side;
        if (x === undefined) b.shell.style.removeProperty("--pet-x");
        else b.shell.style.setProperty("--pet-x", x + "px");
        b.clearApproval();
        b.reset();
        b.showMine("");
        b.thread.reset();
        b.setMode("chat");
        b.input.value = "";
        b.original.hidden = true;
        document.documentElement.dataset.theme = theme;
        b.state(s);
        b.setVisible(fixtureText[s] ?? "");
        if (["fallback", "budget"].includes(s)) {
          b.state("answer");
          b.setVisible("展览周一开幕。");
          const indicator = b.pick(
            s === "fallback" ? "[data-backup]" : "[data-budget]",
          );
          indicator.hidden = false;
          indicator.textContent =
            s === "fallback" ? "备用" : "今天已达上限，后台任务已暂停。";
          if (s === "fallback") indicator.title = "本地备用模型";
        }
        if (s === "reading") {
          b.state("tool");
          b.note.textContent = "正在看网页…";
        }
        if (s === "translation") {
          b.setMode("translate");
          b.original.hidden = false;
          b.original.open = true;
          b.originalText.textContent = "Please take a seat near the window.";
          b.setVisible("请在窗边坐下。");
          b.translated("中文", 1);
          b.state("answer");
        }
        if (s === "translation-typing") {
          b.setMode("translate");
          b.state("input");
          b.input.value = "周末一起去吃拉面吧，我知道一家很好吃的店";
        }
        if (s === "vision") {
          b.setMode("vision");
          b.state("input");
          b.input.value = "这是什么？";
        }
        b.drawNotices(
          s === "reminder"
            ? [
                {
                  id: 1,
                  revision: 1,
                  reminder: 1,
                  pet: "fixture",
                  message: "该喝水了",
                  due: Date.now(),
                  missed: false,
                },
              ]
            : [],
        );
        if (s === "authorization")
          b.openRequest({
            id: "fixture-auth",
            token: "fixture",
            service: "名牌服务",
            tool: "读取名牌",
            args: '{"宠物":"栗子"}',
          });
        if (s === "reminder") b.setVisible("");
        if (s === "remembered") {
          b.state("answer");
          b.setVisible("你喜欢喝乌龙茶，我记住了。");
          b.showRemembered({
            id: 1,
            petId: "fixture",
            entries: [{ book: "user", added: "喜欢乌龙茶" }],
            expiresInMs: 5000,
          });
        }
        if (s === "permission") b.error("permission");
        if (s === "empty-selection") {
          b.setVisible("先选中一段文字哦");
          b.state("answer");
        }
        if (s === "long") b.state("answer");
        // 上手引导: a tip on its own, and one under an answer.
        if (s === "tip") b.tip("copy-translate", true);
        if (s === "hello") {
          b.state("tip");
          b.tip("hello", true);
        }
        // 手机传文件: the code, a phone's question, and text from it.
        if (s === "phone-qr") {
          b.state("phone");
          b.phone.qr({
            running: true,
            qr: fakeQr(),
            url: "http://192.168.1.23:53318/t/3f9c…/",
            firstTime: true,
          });
        }
        // 发到手机 with no phone yet, and the help after a while without one.
        if (s === "phone-send" || s === "phone-help") {
          b.state("phone");
          b.phone.qr({
            running: true,
            qr: fakeQr(),
            url: "http://192.168.1.23:53318/t/3f9c…/",
          });
          if (s === "phone-help")
            document
              .querySelector<HTMLElement>("[data-phone-act=help]")
              ?.click();
        }
        if (s === "phone-linked") {
          b.state("phone");
          b.phone.qr({ running: true, qr: fakeQr() });
          b.phone.linked("iPhone");
          b.phone.linked("鸿蒙手机");
        }
        if (s === "phone-offer") {
          b.state("phone");
          b.phone.ask({
            id: "o",
            device: "iPhone",
            files: [
              { name: "IMG_0412.HEIC", size: 2_400_000 },
              { name: "IMG_0413.HEIC", size: 2_600_000 },
              { name: "IMG_0415.MOV", size: 3_100_000 },
            ],
          });
        }
        if (s === "phone-text") {
          b.state("phone");
          b.phone.received(
            "明天下午三点在图书馆二楼见，记得带上打印好的报告。",
            null,
          );
        }
        // 番茄钟: done, and the break over.
        if (s === "focus-done" || s === "focus-rested") {
          b.state("focus");
          b.focus(s === "focus-done" ? "done" : "rested");
        }
        if (s === "answer-tip") {
          b.state("answer");
          b.setVisible("好的，这段的意思是：请在窗边坐下。");
          b.tip("copy-translate", false);
        }
        if (s === "thread") {
          b.thread.append({
            question: "明天要带伞吗？",
            answer: "下午有阵雨，带把折叠伞吧。",
          });
          b.showMine("几点开始下？");
          b.setVisible("大概三点到六点，傍晚就停了。");
          b.state("answer");
        }
        if (s === "error") b.action.textContent = "再试一次";
        b.paint();
      },
    },
  });
}
