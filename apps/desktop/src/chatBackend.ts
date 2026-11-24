// What the chat views need from the host. In the browser preview a fake
// backend answers instead, so every state can be looked at without the app.
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { native } from "./bridge.ts";

export interface Turn {
  thumbnail?: string;
  id?: number;
  steps?: import("../../shared/toolSteps.ts").ToolStep[];
  sources?: { title: string; url: string }[];
  question: string;
  answer: string;
  at: number;
}
export interface LinkedTask {
  id: number;
  name: string;
}
export interface Topic {
  id: number;
  title: string;
  lastAt: number;
  turns: number;
  /** The pet it was with. */
  pet: string;
}
export interface BrainEvent {
  method: string;
  params?: Record<string, unknown> & { token?: string };
}
export interface ChatBackend {
  current(): Promise<{ id: number | null; turns: Turn[] }>;
  send(
    token: string,
    text: string,
    image?: string,
    forceSearch?: boolean,
    files?: { name: string; text: string }[],
  ): Promise<string>;
  cancel(token: string): Promise<void>;
  newTopic(): Promise<void>;
  topics(query: string): Promise<Topic[]>;
  linkedTasks(id: number): Promise<LinkedTask[]>;
  deleteTopic(
    id: number,
    removeTasks: boolean,
    expected: number[],
  ): Promise<void>;
  reopen(id: number): Promise<void>;
  listDocuments(): Promise<{ id: number; name: string }[]>;
  importFile(
    name: string,
    data: string,
    text: string,
    replaceId?: number,
  ): Promise<void>;
  onEvent(fn: (e: BrainEvent) => void): Promise<void>;
  onUpdated(fn: () => void): Promise<void>;
}

export const nativeBackend: ChatBackend = {
  current: () => invoke("current_chat_topic"),
  send: async (token, text, image, forceSearch, files) =>
    (
      await invoke<{ text: string }>("send_chat", {
        token,
        text,
        at: Date.now(),
        forceSearch,
        ...(image ? { image } : {}),
        ...(files?.length ? { files } : {}),
      })
    ).text,
  cancel: (token) => invoke("cancel_chat", { token }),
  newTopic: () => invoke("new_topic"),
  topics: (query) => invoke("chat_topics", { query }),
  linkedTasks: (id) => invoke("linked_topic_tasks", { id }),
  deleteTopic: (id, removeTasks, expected) =>
    invoke("delete_chat_topic", { id, removeTasks, expected }),
  reopen: (id) => invoke("reopen_chat_topic", { id }),
  listDocuments: () => invoke("list_documents"),
  importFile: (name, data, text, replaceId) =>
    invoke("import_document", {
      name,
      data,
      note: "",
      text,
      ...(replaceId !== undefined ? { replaceId } : {}),
    }),
  onEvent: async (fn) => {
    await listen<BrainEvent>("brain-event", (e) => fn(e.payload));
  },
  onUpdated: async (fn) => {
    await listen("chat-updated", () => fn());
  },
};

export async function chatBackend(): Promise<ChatBackend> {
  if (native) return nativeBackend;
  return (await import("./chatPreview.ts")).previewBackend();
}
