import { t, tn } from "./i18n.ts";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { native } from "./bridge.ts";
import { dropEventPoint } from "./dropPoint.ts";
const MAX = 20 * 1024 * 1024;
const EMPTY_PDF_ERR = t("library.pdfImages");
const EMPTY_DOC_ERR = t("library.noText");
export function bytesToBase64(bytes: Uint8Array) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 16384)
    bin += String.fromCharCode(...bytes.subarray(i, i + 16384));
  return btoa(bin);
}
export async function extractDocument(
  name: string,
  bytes: Uint8Array<ArrayBuffer>,
) {
  if (bytes.length > MAX) throw Error(t("library.tooBig"));
  const ext = name.split(".").at(-1)?.toLowerCase();
  let result: string | undefined;
  if (ext === "txt" || ext === "md") result = new TextDecoder().decode(bytes);
  else if (ext === "html") {
    const { parseHTML } = await import("linkedom");
    const { document } = parseHTML(new TextDecoder().decode(bytes));
    document
      .querySelectorAll("script,style,noscript,template")
      .forEach((el) => el.remove());
    result = document.documentElement.textContent ?? "";
  } else if (ext === "docx") {
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let p = bytes.length - 22;
    for (; p >= Math.max(0, bytes.length - 65557); p--)
      if (view.getUint32(p, true) === 0x06054b50) break;
    if (p < 0 || view.getUint32(p, true) !== 0x06054b50)
      throw Error(t("library.docxBad"));
    const count = view.getUint16(p + 10, true);
    if (count > 2048) throw Error(t("library.docxComplex"));
    let offset = view.getUint32(p + 16, true),
      total = 0;
    for (let i = 0; i < count; i++) {
      if (view.getUint32(offset, true) !== 0x02014b50)
        throw Error(t("library.docxBad"));
      total += view.getUint32(offset + 24, true);
      if (total > 64 * 1024 * 1024) throw Error(t("library.docxLarge"));
      offset +=
        46 +
        view.getUint16(offset + 28, true) +
        view.getUint16(offset + 30, true) +
        view.getUint16(offset + 32, true);
    }
    const mammoth = await import("mammoth/mammoth.browser");
    result = (await mammoth.extractRawText({ arrayBuffer: bytes.buffer }))
      .value;
  } else if (ext === "pdf") {
    const pdf = await import("pdfjs-dist");
    pdf.GlobalWorkerOptions.workerSrc = (
      await import("pdfjs-dist/build/pdf.worker.min.mjs?url")
    ).default;
    const task = pdf.getDocument({
      data: bytes.slice(),
      useSystemFonts: false,
      disableFontFace: true,
      useWorkerFetch: false,
    });
    try {
      const doc = await task.promise;
      if (doc.numPages > 3000) throw Error(t("library.pdfPages"));
      const pages = [];
      let length = 0;
      for (let n = 1; n <= doc.numPages; n++) {
        const page = await doc.getPage(n);
        const content = await page.getTextContent();
        const text = content.items
          .map((x) => ("str" in x ? x.str + (x.hasEOL ? "\n" : " ") : ""))
          .join("");
        length += text.length;
        if (length > 8_000_000) throw Error(t("library.pdfText"));
        pages.push(text);
        page.cleanup();
      }
      result = pages.join("\n");
    } finally {
      await task.destroy();
    }
  } else {
    throw Error(t("library.unsupported"));
  }
  if (!result.trim())
    throw Error(ext === "pdf" ? EMPTY_PDF_ERR : EMPTY_DOC_ERR);
  return result;
}
export function documentsPage(form: HTMLElement) {
  const section = document.createElement("section");
  section.className = "companion-library";
  form.append(section);
  section.innerHTML = `<label class="doc-drop"><b>${t("library.drop")}</b><small>${t("library.dropNote")}</small><input type="file" multiple accept=".txt,.md,.pdf,.docx,.html"></label><output class="doc-status"></output><div data-files></div>`;
  const status = section.querySelector("output")!,
    list = section.querySelector("[data-files]")!;
  let currentDocs: {
    id: number;
    name: string;
    note: string;
    sections: number;
  }[] = [];
  async function refresh() {
    const docs = native
      ? await invoke<
          { id: number; name: string; note: string; sections: number }[]
        >("list_documents")
      : [
          { id: 1, name: "项目计划.pdf", note: "里面有截止日期", sections: 12 },
          { id: 2, name: "读书笔记.md", note: "", sections: 3 },
        ];
    currentDocs = docs;
    list.replaceChildren();
    if (!docs.length) {
      const p = document.createElement("p");
      p.className = "memo-empty";
      p.textContent = t("library.empty");
      list.append(p);
    }
    for (const d of docs) {
      const row = document.createElement("div"),
        note = document.createElement("input"),
        ext = document.createElement("span"),
        name = document.createElement("span"),
        acts = document.createElement("div");
      row.className = "companion-entry doc-row";
      ext.className = "doc-ext";
      ext.textContent = (d.name.split(".").pop() ?? "").toUpperCase();
      name.className = "doc-name";
      const b = document.createElement("b"),
        small = document.createElement("small");
      b.textContent = d.name;
      small.textContent = tn("library.sections", d.sections);
      name.append(b, small);
      row.append(ext, name);
      note.className = "doc-note";
      note.placeholder = t("library.noteHint");
      note.maxLength = 400;
      note.value = d.note;
      note.onchange = async () => {
        try {
          await invoke("document_note", { id: d.id, note: note.value });
        } catch (e) {
          status.textContent = String(e);
        }
      };
      acts.className = "memo-acts";
      const button = (label: string, fn: () => void) => {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "link";
        btn.textContent = label;
        btn.onclick = fn;
        acts.append(btn);
      };
      button(t("common.delete"), () => {
        row.dataset.editing = "true";
        acts.replaceChildren();
        button(t("common.confirmDelete"), async () => {
          try {
            if (native) await invoke("remove_document", { id: d.id });
            status.textContent = t("library.removed", { name: d.name });
            await refresh();
          } catch (e) {
            status.textContent = String(e);
          }
        });
        button(t("common.cancel"), () => void refresh());
      });
      row.append(note, acts);
      list.append(row);
    }
  }
  function askDuplicate(name: string): Promise<"replace" | "keep" | "cancel"> {
    return new Promise((resolve) => {
      status.replaceChildren();
      const label = document.createElement("span");
      label.textContent = t("library.duplicate", { name });
      const acts = document.createElement("span");
      acts.className = "doc-dup-acts";
      for (const [text, choice] of [
        [t("library.replace"), "replace"],
        [t("library.keepBoth"), "keep"],
        [t("common.cancel"), "cancel"],
      ] as const) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "link";
        btn.textContent = text;
        btn.onclick = () => resolve(choice);
        acts.append(btn);
      }
      status.append(label, acts);
    });
  }
  async function add(name: string, bytes: Uint8Array<ArrayBuffer>) {
    const text = await extractDocument(name, bytes);
    const data = bytesToBase64(bytes);
    const existing = currentDocs.find((d) => d.name === name);
    if (existing) {
      const choice = await askDuplicate(name);
      if (choice === "cancel") {
        status.textContent = t("library.cancelled", { name });
        return;
      }
      if (choice === "replace") {
        await invoke("import_document", {
          name,
          data,
          note: "",
          text,
          replaceId: existing.id,
        });
        status.textContent = t("library.replaced", { name });
        await refresh();
        return;
      }
    }
    await invoke("import_document", { name, data, note: "", text });
    status.textContent = t("library.added", { name });
    await refresh();
  }
  async function files(values: File[]) {
    try {
      for (const f of values) {
        if (f.size > MAX) throw Error(t("library.tooBig"));
        await add(f.name, new Uint8Array(await f.arrayBuffer()));
      }
    } catch (e) {
      status.textContent = String(e);
    }
  }
  section.querySelector("input")!.onchange = (e) =>
    void files(Array.from((e.target as HTMLInputElement).files ?? []));
  // The whole 资料库 block takes drops, not just the small box.
  const zone = () => section.closest<HTMLElement>(".block") ?? section;
  const over = (on: boolean) => (zone().dataset.drop = on ? "over" : "");
  addEventListener("dragover", (e) => {
    if (!zone().contains(e.target as Node)) return;
    e.preventDefault();
    over(true);
  });
  addEventListener("dragleave", (e) => {
    if (!zone().contains(e.relatedTarget as Node)) over(false);
  });
  addEventListener("drop", (e) => {
    if (!zone().contains(e.target as Node)) return;
    e.preventDefault();
    over(false);
    void files(Array.from(e.dataTransfer?.files ?? []));
  });
  if (native)
    void getCurrentWebview().onDragDropEvent(async (e) => {
      if (e.payload.type === "over" || e.payload.type === "enter")
        over(!!section.offsetParent);
      if (e.payload.type === "leave") over(false);
      if (e.payload.type !== "drop" || !section.offsetParent) return;
      over(false);
      const pt = dropEventPoint(e.payload.position);
      const hit = document.elementFromPoint(pt.x, pt.y);
      if (!hit || !zone().contains(hit)) return;
      try {
        for (const path of e.payload.paths) {
          const b64 = await invoke<string>("library_source", { path });
          await add(
            path.split(/[\\/]/).at(-1)!,
            Uint8Array.from(atob(b64), (c) => c.charCodeAt(0)),
          );
        }
      } catch (err) {
        status.textContent = String(err);
      }
    });
  return refresh;
}
