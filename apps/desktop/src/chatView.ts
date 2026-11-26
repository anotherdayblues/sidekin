// The chat view of the side panel (plan/11 05-聊天窗口, plan/29): messages,
// the composer, and the past topics opened over them. Chatting is on the
// desktop only; the main window keeps no chat page.
import { t } from "./i18n.ts";
import { showQuestion } from "./chatQuestion.ts";
import { chatBackend, type Turn } from "./chatBackend.ts";
import { chatMessages, fromTurns } from "./chatMessages.ts";
import { chatComposer, type Attached } from "./chatComposer.ts";
import { chatTopics } from "./chatTopics.ts";
import { bytesToBase64, extractDocument } from "./documents.ts";
import { errorText } from "./errorText.ts";
import "./styles/chat.css";

export async function mountChatView(
  root: HTMLElement,
  o: {
    showTranslations: () => void;
    face: (pet: string) => Promise<string>;
    eagerLoad?: boolean;
  },
) {
  const backend = await chatBackend();
  root.classList.add("chat-view");
  root.dataset.layout = "float";
  root.dataset.topics = "closed";
  const topics = chatTopics(root, {
    load: (q) => backend.topics(q),
    open: openTopic,
    linked: (id) => backend.linkedTasks(id),
    remove: async (id, removeTasks, expected) => {
      await backend.deleteTopic(id, removeTasks, expected);
      await reload();
    },
    showTranslations: o.showTranslations,
    face: o.face,
  });
  const main = document.createElement("section");
  main.className = "chat-main";
  main.dataset.dropHint = t("chat.dropHint");
  root.append(main);
  const log = chatMessages(main, t("chat.empty"));
  const composer = chatComposer(main, root, {
    send,
    stop,
    parseFile,
    findDuplicate,
    saveToLibrary,
    recall,
    onAttach: () => {
      root.dataset.topics = "closed";
    },
  });
  let token = "";
  let quietUntil = 0;
  let loaded = false;
  let reloading: Promise<void> | null = null;

  async function reload() {
    if (token) return;
    if (reloading) return reloading;
    reloading = (async () => {
      try {
        const c = await backend.current();
        log.set(fromTurns(c.turns));
        topics.mark(c.id);
        loaded = true;
      } catch (e) {
        composer.say(String(e));
      } finally {
        reloading = null;
      }
    })();
    return reloading;
  }
  async function ensureLoaded() {
    if (!loaded) await reload();
  }
  function fail(e: unknown) {
    const code = String(e).replace(/^Error: /, "");
    return errorText[code] ?? code;
  }
  async function send(
    text: string,
    image?: Attached,
    forceSearch?: boolean,
    files?: { name: string; text: string }[],
  ) {
    const mine = crypto.randomUUID();
    token = mine;
    root.dataset.busy = "true";
    composer.setBusy(true);
    composer.say("");
    const at = Date.now();
    log.push(
      {
        role: "user",
        text,
        at,
        image: image?.preview,
        files: files?.map((f) => f.name),
      },
      { role: "pet", text: "", at, streaming: true },
    );
    try {
      const answer = await backend.send(
        mine,
        text,
        image?.data,
        forceSearch,
        files,
      );
      if (token === mine) log.patchLast({ text: answer, streaming: false });
    } catch (e) {
      if (token !== mine) return;
      const said = log.messages.at(-1)?.text ?? "";
      if (fail(e) === errorText.stopped)
        log.patchLast({ text: said || errorText.stopped, streaming: false });
      else {
        if (!said) log.messages.pop();
        log.push({ role: "note", text: fail(e), at: Date.now(), error: true });
      }
    } finally {
      if (token === mine) {
        token = "";
        delete root.dataset.busy;
        quietUntil = Date.now() + 1500;
        composer.setBusy(false);
        composer.say("");
        void topics.refresh();
      }
    }
  }
  function stop() {
    if (token) void backend.cancel(token);
  }
  async function parseFile(name: string, bytes: Uint8Array<ArrayBuffer>) {
    const text = await extractDocument(name, bytes);
    const data = bytesToBase64(bytes);
    const sections = Math.max(1, Math.ceil([...text].length / 1000));
    return { data, text, sections };
  }
  async function findDuplicate(name: string) {
    const list = await backend.listDocuments().catch(() => []);
    return list.find((d) => d.name === name)?.id;
  }
  async function saveToLibrary(
    name: string,
    data: string,
    text: string,
    replaceId?: number,
  ) {
    await backend.importFile(name, data, text, replaceId);
  }
  function recall() {
    return [...log.messages].reverse().find((m) => m.role === "user")?.text;
  }
  async function newTopic() {
    if (token) return composer.say(t("chat.stopFirst"));
    try {
      await backend.newTopic();
      await reload();
      root.dataset.topics = "closed";
      composer.focus();
    } catch (e) {
      composer.say(fail(e));
    }
  }
  async function openTopic(id: number) {
    if (token) return composer.say(t("chat.stopFirst"));
    try {
      await backend.reopen(id);
      await reload();
      root.dataset.topics = "closed";
      composer.focus();
    } catch (e) {
      composer.say(fail(e));
    }
  }

  await backend.onEvent(({ method, params }) => {
    if (!token || params?.token !== token) return;
    if (method === "chat.question") showQuestion(main, token, params);
    if (method === "chat.questionClosed")
      main
        .querySelector(
          '[data-question-id="' + CSS.escape(String(params.id)) + '"]',
        )
        ?.remove();
    if (method === "chat.sources" && Array.isArray(params.sources))
      log.patchLast({ sources: params.sources });
    const last = log.messages.at(-1);
    if (method === "chat.delta" && typeof params.delta === "string") {
      composer.say("");
      log.patchLast({ text: (last?.text ?? "") + params.delta });
    }
    if (method === "chat.rewind")
      log.patchLast({ text: String(params.text ?? "") });
    if (method === "chat.steps" && Array.isArray(params.steps))
      log.patchLast({ steps: params.steps as Turn["steps"] });
    if (method === "chat.remembered") composer.say(t("chat.remembered"));
  });
  // A message sent from the bubble shows up here too.
  await backend.onUpdated(() => {
    if (!loaded) return;
    void topics.refresh();
    if (Date.now() > quietUntil) void reload();
  });
  if (o.eagerLoad !== false) await reload();
  return {
    reload,
    ensureLoaded,
    async focusTurn(topic: number, turn: number) {
      await openTopic(topic);
      log.el
        .querySelector(`[data-turn="${turn}"]`)
        ?.scrollIntoView({ block: "center" });
    },
    newTopic,
    focus: composer.focus,
    attachSnip(snip: { data: string; preview: string; draftText?: string }) {
      root.dataset.topics = "closed";
      composer.attachPrepared(
        { data: snip.data, preview: snip.preview },
        snip.draftText,
      );
    },
    attachPaths: (paths: string[]) => composer.attachLocalPaths(paths),
    setSnipPreview: composer.setSnipPreview,
    isDirty: () =>
      Boolean(
        token || composer.hasDraft() || main.querySelector("[data-question-id]"),
      ),
    toggleTopics() {
      root.dataset.topics = root.dataset.topics === "open" ? "closed" : "open";
      if (root.dataset.topics === "open") void topics.refresh();
    },
    /** Browser preview only: switch the fake backend to a fixed conversation. */
    preview(name: string) {
      (backend as { use?(n: string): void }).use?.(name);
    },
  };
}
