// The input area: text, one picture, attached files for this turn (with optional
// one-click save into 随身资料), send and stop.
import { t, tn } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { native } from "./bridge.ts";
import { mountGlobe } from "./globe.ts";
import { glyphs } from "./icons.ts";
export interface Attached {
  data: string;
  preview: string;
}
export interface PendingFile {
  name: string;
  data: string;
  text: string;
  sections: number;
  saved?: boolean;
  dupId?: number;
}
interface Handlers {
  send(
    text: string,
    image?: Attached,
    forceSearch?: boolean,
    files?: { name: string; text: string }[],
  ): void;
  stop(): void;
  parseFile(
    name: string,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<{ data: string; text: string; sections: number }>;
  findDuplicate(name: string): Promise<number | undefined>;
  saveToLibrary(
    name: string,
    data: string,
    text: string,
    replaceId?: number,
  ): Promise<void>;
  recall(): string | undefined;
}
const DOCS = /\.(txt|md|pdf|docx|html)$/i;
const EDGE = 1568;

async function toPng(file: Blob): Promise<Attached> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, EDGE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  const preview = canvas.toDataURL("image/png");
  return { data: preview.slice(preview.indexOf(",") + 1), preview };
}

export function chatComposer(
  root: HTMLElement,
  dropZone: HTMLElement,
  h: Handlers,
) {
  const box = document.createElement("form");
  box.className = "chat-composer";
  box.innerHTML = `<div class="chat-attached" hidden><img alt="${t("chat.imageToSend")}"><button type="button" data-unattach aria-label="${t("chat.removeImage")}">×</button></div>
<div class="chat-files" hidden></div>
<textarea rows="1" placeholder="${t("chat.placeholder")}" aria-label="${t("chat.message")}"></textarea>
<div class="chat-tools"><button type="button" data-globe aria-label="${t("chat.globe")}" aria-pressed="false">${glyphs.globe}</button><button type="button" data-image aria-label="${t("chat.sendImage")}" title="${t("chat.sendImage")}">${glyphs.image}</button><button type="button" data-file aria-label="${t("chat.attach")}" title="${t("chat.attachHint")}">${glyphs.clip}</button><input type="file" data-pick-image accept="image/*" hidden><input type="file" data-pick-file accept=".txt,.md,.pdf,.docx,.html" multiple hidden><span class="chat-status" role="status"></span><button type="submit" data-send aria-label="${t("chat.send")}"><i>${glyphs.arrow}</i><span>${t("chat.send")}</span></button><button type="button" data-stop aria-label="${t("chat.stop")}" hidden><i>${glyphs.square}</i><span>${t("chat.stop")}</span></button></div>`;
  root.append(box);
  const q = <T extends HTMLElement>(s: string) => box.querySelector<T>(s)!;
  const input = q<HTMLTextAreaElement>("textarea"),
    attached = q(".chat-attached"),
    filesBox = q(".chat-files"),
    status = q(".chat-status"),
    send = q<HTMLButtonElement>("[data-send]"),
    stop = q<HTMLButtonElement>("[data-stop]"),
    pickImage = q<HTMLInputElement>("[data-pick-image]"),
    pickFile = q<HTMLInputElement>("[data-pick-file]");
  let image: Attached | undefined;
  let files: PendingFile[] = [];
  let busy = false;
  const globe = mountGlobe(q("[data-globe]"));

  const grow = () => {
    input.style.height = "auto";
    input.style.height = Math.min(input.scrollHeight, 160) + "px";
  };
  const say = (text: string) => {
    status.textContent = text;
  };
  function renderFiles() {
    filesBox.replaceChildren();
    filesBox.hidden = !files.length;
    for (const f of files) {
      const chip = document.createElement("div");
      chip.className = "chat-file-chip";
      const meta = document.createElement("span");
      meta.className = "chat-file-meta";
      const b = document.createElement("b"),
        small = document.createElement("small");
      b.textContent = `📄 ${f.name}`;
      small.textContent = t("chat.fileThisTime", {
        sections: tn("library.sections", f.sections),
      });
      meta.append(b, small);
      const acts = document.createElement("span");
      acts.className = "chat-file-acts";
      const addLink = (label: string, fn: () => void) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "link";
        btn.textContent = label;
        btn.onclick = fn;
        acts.append(btn);
      };
      if (f.saved) {
        const savedTag = document.createElement("small");
        savedTag.className = "chat-file-saved";
        savedTag.textContent = t("chat.savedToLibrary");
        acts.append(savedTag);
      } else if (f.dupId !== undefined) {
        const dupNote = document.createElement("small");
        dupNote.className = "chat-file-dup";
        dupNote.textContent = t("chat.sameName");
        acts.append(dupNote);
        addLink(t("chat.replace"), async () => {
          try {
            await h.saveToLibrary(f.name, f.data, f.text, f.dupId);
            f.saved = true;
            f.dupId = undefined;
            renderFiles();
          } catch (e) {
            say(String(e));
          }
        });
        addLink(t("library.keepBoth"), async () => {
          try {
            await h.saveToLibrary(f.name, f.data, f.text);
            f.saved = true;
            f.dupId = undefined;
            renderFiles();
          } catch (e) {
            say(String(e));
          }
        });
        addLink(t("common.cancel"), () => {
          f.dupId = undefined;
          renderFiles();
        });
      } else {
        addLink(t("chat.saveToLibrary"), async () => {
          try {
            const dup = await h.findDuplicate(f.name);
            if (dup !== undefined) {
              f.dupId = dup;
              renderFiles();
              return;
            }
            await h.saveToLibrary(f.name, f.data, f.text);
            f.saved = true;
            renderFiles();
          } catch (e) {
            say(String(e));
          }
        });
      }
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "chat-file-remove";
      remove.setAttribute("aria-label", t("chat.removeFile"));
      remove.textContent = "×";
      remove.onclick = () => {
        files = files.filter((x) => x !== f);
        renderFiles();
      };
      acts.append(remove);
      chip.append(meta, acts);
      filesBox.append(chip);
    }
  }
  async function attach(file: Blob) {
    try {
      image = await toPng(file);
      attached.querySelector("img")!.src = image.preview;
      attached.hidden = false;
      say("");
    } catch {
      say(t("chat.badImage"));
    }
  }
  async function addDocBytes(name: string, bytes: Uint8Array<ArrayBuffer>) {
    say(t("chat.readingFile"));
    try {
      const parsed = await h.parseFile(name, bytes);
      const idx = files.findIndex((x) => x.name === name);
      const item: PendingFile = { name, ...parsed };
      if (idx >= 0) files[idx] = item;
      else files.push(item);
      renderFiles();
      say("");
    } catch (e) {
      say(String(e).replace(/^Error:\s*/, ""));
    }
  }
  async function take(list: Iterable<File>) {
    for (const f of list) {
      if (f.type.startsWith("image/")) await attach(f);
      else if (DOCS.test(f.name)) {
        await addDocBytes(f.name, new Uint8Array(await f.arrayBuffer()));
      } else say(t("chat.unsupported"));
    }
  }
  box.onsubmit = (e) => {
    e.preventDefault();
    const text =
      input.value.trim() ||
      (image ? t("chat.whatIsThis") : files.length ? t("chat.lookAtFile") : "");
    if (busy || !text) return;
    const sentFiles = files.length
      ? files.map((f) => ({ name: f.name, text: f.text }))
      : undefined;
    h.send(text, image, globe.take(), sentFiles);
    input.value = "";
    image = undefined;
    files = [];
    attached.hidden = true;
    renderFiles();
    grow();
  };
  input.oninput = grow;
  input.onkeydown = (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      box.requestSubmit();
    }
    if (e.key === "ArrowUp" && !input.value) {
      const last = h.recall();
      if (last) {
        e.preventDefault();
        input.value = last;
        grow();
      }
    }
  };
  input.onpaste = (e) => {
    const file = [...(e.clipboardData?.files ?? [])].find((f) =>
      f.type.startsWith("image/"),
    );
    if (file) {
      e.preventDefault();
      void attach(file);
    }
  };
  q("[data-unattach]").onclick = () => {
    image = undefined;
    attached.hidden = true;
  };
  q("[data-image]").onclick = () => pickImage.click();
  q("[data-file]").onclick = () => pickFile.click();
  pickImage.onchange = () => {
    if (pickImage.files?.[0]) void attach(pickImage.files[0]);
    pickImage.value = "";
  };
  pickFile.onchange = () => {
    void take([...(pickFile.files ?? [])]);
    pickFile.value = "";
  };
  stop.onclick = () => h.stop();
  dropZone.addEventListener("dragover", (e) => {
    e.preventDefault();
    dropZone.dataset.dropping = "true";
  });
  dropZone.addEventListener("dragleave", (e) => {
    if (!dropZone.contains(e.relatedTarget as Node))
      delete dropZone.dataset.dropping;
  });
  dropZone.addEventListener("drop", (e) => {
    e.preventDefault();
    delete dropZone.dataset.dropping;
    void take([...(e.dataTransfer?.files ?? [])]);
  });
  if (native)
    void getCurrentWebview().onDragDropEvent(async (e) => {
      if (!dropZone.offsetParent) return;
      if (e.payload.type === "over" || e.payload.type === "enter") {
        dropZone.dataset.dropping = "true";
        return;
      }
      if (e.payload.type === "leave") {
        delete dropZone.dataset.dropping;
        return;
      }
      if (e.payload.type !== "drop") return;
      delete dropZone.dataset.dropping;
      const hit = document.elementFromPoint(
        e.payload.position.x / devicePixelRatio,
        e.payload.position.y / devicePixelRatio,
      );
      if (!hit || !dropZone.contains(hit)) return;
      for (const path of e.payload.paths) {
        const name = path.split(/[\\/]/).at(-1) ?? "";
        if (!DOCS.test(name)) {
          say(t("chat.dropTypes"));
          continue;
        }
        try {
          const b64 = await invoke<string>("library_source", { path });
          await addDocBytes(
            name,
            Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
          );
        } catch (err) {
          say(String(err));
        }
      }
    });
  return {
    focus: () => input.focus(),
    say,
    hasDraft: () => Boolean(input.value.trim() || image || files.length),
    setBusy(on: boolean) {
      busy = on;
      send.hidden = on;
      stop.hidden = !on;
    },
  };
}
